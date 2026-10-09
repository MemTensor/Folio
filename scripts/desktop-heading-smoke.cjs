const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const temporary = path.resolve(process.argv[2]);
const dist = path.resolve(process.argv[3]);
const root = path.resolve(__dirname, '..');
const workspace = path.join(temporary, 'workspace');
const startup = path.join(workspace, 'Startup.md');
const created = path.join(workspace, 'Heading.md');
const preload = path.join(root, 'electron/preload.cjs');
const calls = {};
const errors = [];
let window;
let finished = false;
let createdSnapshot = null;

app.setPath('userData', path.join(temporary, 'user-data'));
app.setPath('sessionData', path.join(temporary, 'session-data'));
app.setName('Folio heading verification');
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([
  { scheme: 'folio', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function finish(ok, details = {}) {
  if (finished) return;
  finished = true;
  window?.destroy();
  process.stdout.write(JSON.stringify({ ok, calls, errors, ...details }) + '\n', () =>
    app.exit(ok ? 0 : 1),
  );
}
process.on('uncaughtException', (error) => finish(false, { failure: error.message }));
process.on('unhandledRejection', (error) => finish(false, { failure: String(error) }));
const timeout = setTimeout(() => finish(false, { failure: 'Heading check timed out.' }), 25000);
timeout.unref();

function snapshot(file, content) {
  return {
    path: file,
    workspaceRoot: workspace,
    content,
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    eol: 'LF',
    bom: false,
  };
}
const startupSnapshot = snapshot(startup, '# Existing title\n\nOpen the new document.\n');
const tree = () => [
  { name: 'Startup.md', path: startup, kind: 'file', mtime: 1_790_000_000_000 },
  ...(createdSnapshot
    ? [{ name: 'Heading.md', path: created, kind: 'file', mtime: 1_790_000_000_001 }]
    : []),
];
const evaluate = (fn, ...args) =>
  window.webContents.executeJavaScript(
    `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
  );
async function waitFor(label, condition) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Heading verification timed out: ' + label);
}
function key(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}
async function run() {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(startup, startupSnapshot.content);
  const handlers = {
    'project-overview': () => ({
      preferences: {
        onboarded: true,
        homeOnLaunch: false,
        discoverProjects: false,
        language: 'en',
        pinnedProjects: [],
      },
      projects: [
        { id: 'generated', name: 'Fixture', root: workspace, registered: true, available: true },
      ],
      recentDocuments: [],
      sync: { enabled: false, available: false, projectIds: [] },
    }),
    bootstrap: () => ({
      root: workspace,
      tree: tree(),
      initial: startup,
      platform: process.platform,
    }),
    read: (file) => {
      if (file === startup) return startupSnapshot;
      if (file === created && createdSnapshot) return createdSnapshot;
      throw Error('Unexpected document read: ' + file);
    },
    'draft-get': () => null,
    'draft-put': () => {},
    'watch-documents': () => {},
    'document-opened': () => {},
    'documents-cancel': () => {},
    documents: () => ({
      documents: tree().map((item) => ({
        path: item.path,
        name: item.name,
        relativePath: item.name,
        modifiedAt: item.mtime,
        size: 0,
      })),
      total: tree().length,
      offset: 0,
      hasMore: false,
      limited: false,
      scanned: tree().length,
      fromCache: true,
      updatedAt: 1_790_000_000_000,
      excluded: true,
    }),
    'directory-release': () => {},
    directory: () => ({ nodes: tree(), limited: false }),
    'quick-open': () => tree(),
    'activate-workspace': () => ({ root: workspace, tree: tree() }),
    tree,
    create: async (name, kind, targetRoot) => {
      assert.equal(kind, 'file');
      assert.equal(targetRoot, workspace);
      assert.equal(name, 'Heading.md');
      assert.equal(createdSnapshot, null);
      await fs.writeFile(created, '', { flag: 'wx' });
      createdSnapshot = snapshot(created, '');
      return { ok: true, file: createdSnapshot };
    },
    save: async (args) => {
      assert.equal(args.path, created);
      assert.equal(args.expectedHash, createdSnapshot.hash);
      await fs.writeFile(created, args.content);
      createdSnapshot = snapshot(created, args.content);
      return { ok: true, file: createdSnapshot };
    },
    dirty: () => {},
    'update-status': () => ({ phase: 'idle', currentVersion: '0.0.0-test', supported: false }),
    'update-boot-ready': () => {},
  };
  const source = await fs.readFile(preload, 'utf8');
  for (const [, channel] of source.matchAll(/invoke\('([^']+)'\)/g)) {
    ipcMain.handle(channel, (_event, ...args) => {
      calls[channel] = (calls[channel] || 0) + 1;
      if (!Object.hasOwn(handlers, channel)) throw Error('Unexpected IPC: ' + channel);
      return handlers[channel](...args);
    });
  }
  await app.whenReady();
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    const allowed = /^(folio:\/\/app\/|data:|blob:)/.test(request.url);
    if (!allowed) errors.push('Unexpected network request: ' + new URL(request.url).protocol);
    callback({ cancel: !allowed });
  });
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  protocol.handle('folio', async (request) => {
    const url = new URL(request.url);
    const target = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (url.host !== 'app' || !target.startsWith(dist + path.sep))
      return new Response('Forbidden', { status: 403 });
    try {
      return new Response(await fs.readFile(target), {
        headers: { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' },
      });
    } catch {
      return new Response('Missing build asset', { status: 404 });
    }
  });
  window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 850,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('preload-error', (_event, _file, error) =>
    errors.push('Preload: ' + error.message),
  );
  window.webContents.on('render-process-gone', (_event, details) =>
    finish(false, { failure: 'Renderer exited: ' + details.reason }),
  );
  window.webContents.on('console-message', (details, level, message) => {
    if ((details.level ?? level) === 'error' || level === 3)
      errors.push(details.message ?? message);
  });
  await window.loadURL('folio://app/index.html');
  await waitFor('startup editor', () =>
    evaluate(() =>
      document
        .querySelector('[data-testid="markdown-editor"]')
        ?.textContent.includes('Existing title'),
    ),
  );
  window.webContents.focus();
  await evaluate(() => document.querySelector('.cm-content').focus());
  const startupLive = await evaluate(() => ({
    heading: document.querySelector('.cm-line.cm-heading')?.innerText,
    writingSelected: document
      .querySelector('.view-switch button:first-child')
      ?.classList.contains('selected'),
  }));
  assert.equal(startupLive.writingSelected, true, 'existing document opens in writing mode');
  assert.equal(startupLive.heading, 'Existing title', 'initial heading hides its Markdown marker');
  await evaluate(() =>
    Array.from(document.querySelectorAll('.view-switch button'))
      .find(
        (button) => button.textContent.includes('Source') || button.textContent.includes('源码'),
      )
      .click(),
  );
  await waitFor('existing heading source mode', () =>
    evaluate(() => document.querySelector('.cm-content')?.innerText.includes('# Existing title')),
  );
  assert.equal(await fs.readFile(startup, 'utf8'), startupSnapshot.content);
  await evaluate(() => document.querySelector('.view-switch button:first-child').click());
  await waitFor('writing mode restored', () =>
    evaluate(() =>
      document.querySelector('.view-switch button:first-child')?.classList.contains('selected'),
    ),
  );
  await evaluate(() => {
    const button = document.querySelector(
      'button[aria-label="New document"], button[aria-label="新建文档"]',
    );
    if (!button)
      throw Error(
        'Missing new-document button: ' +
          Array.from(document.querySelectorAll('button[aria-label]'), (item) =>
            item.getAttribute('aria-label'),
          ).join('|'),
      );
    button.click();
  });
  await waitFor('new document dialog', () =>
    evaluate(() => !!document.querySelector('.name-field input')),
  );
  await evaluate(() => {
    const input = document.querySelector('.name-field input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Heading.md');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.modal-actions .primary').click();
  });
  await waitFor('created empty document', () =>
    evaluate(
      () =>
        !!document.querySelector('[data-testid="markdown-editor"]') &&
        document.title.startsWith('Heading.md'),
    ),
  );
  assert.equal(await fs.readFile(created, 'utf8'), '');
  window.webContents.focus();
  await evaluate(() => document.querySelector('.cm-content').focus());
  await window.webContents.insertText('# Title');
  await waitFor('active heading line', () =>
    evaluate(() => !!document.querySelector('.cm-line.cm-heading')),
  );
  const liveHeading = await evaluate(() => ({
    line: document.querySelector('.cm-line.cm-heading')?.innerText,
    writingSelected: document
      .querySelector('.view-switch button:first-child')
      ?.classList.contains('selected'),
    sourceSelected: Array.from(document.querySelectorAll('.view-switch button')).some(
      (button) =>
        button.classList.contains('selected') &&
        (button.textContent.includes('Source') || button.textContent.includes('源码')),
    ),
  }));
  assert.equal(liveHeading.writingSelected, true, 'new document opens in writing mode');
  assert.equal(liveHeading.sourceSelected, false, 'new document opens in writing mode');
  assert.equal(liveHeading.line, 'Title', 'active heading hides only its Markdown marker');

  await new Promise((resolve) => setTimeout(resolve, 700));
  await window.webContents.insertText('!');
  await waitFor('typing at heading cursor', () =>
    evaluate(() => document.querySelector('.cm-line.cm-heading')?.innerText === 'Title!'),
  );
  key('Z', [process.platform === 'darwin' ? 'meta' : 'control']);
  await waitFor('undo recent heading edit', () =>
    evaluate(() => document.querySelector('.cm-line.cm-heading')?.innerText === 'Title'),
  );
  await evaluate(() =>
    Array.from(document.querySelectorAll('.view-switch button'))
      .find(
        (button) => button.textContent.includes('Source') || button.textContent.includes('源码'),
      )
      .click(),
  );
  await waitFor('source mode with literal Markdown', () =>
    evaluate(() => document.querySelector('.cm-content')?.innerText.includes('# Title')),
  );
  const sourceText = await evaluate(() => document.querySelector('.cm-content')?.innerText);
  assert.equal(sourceText.trim(), '# Title');
  window.webContents.send('command', 'save');
  await waitFor('saved Markdown', async () => (await fs.readFile(created, 'utf8')) === '# Title');
  assert.equal(await fs.readFile(created, 'utf8'), '# Title');
  await evaluate((title) => {
    const tab = Array.from(document.querySelectorAll('.doc-tab')).find(
      (button) => button.title === title,
    );
    if (!tab) throw Error('Missing generated startup tab.');
    tab.click();
  }, startup);
  await waitFor('existing document reopened', () =>
    evaluate(() => document.title.startsWith('Startup.md')),
  );
  await evaluate(() => document.querySelector('.view-switch button:first-child').click());
  await waitFor('reopened heading in writing mode', () =>
    evaluate(() => !!document.querySelector('.cm-line.cm-heading')),
  );
  const reopenedHeading = await evaluate(
    () => document.querySelector('.cm-line.cm-heading').innerText,
  );
  assert.equal(reopenedHeading, 'Existing title', 'reopened heading hides its Markdown marker');
  assert.equal(await fs.readFile(startup, 'utf8'), startupSnapshot.content);
  assert.deepEqual(errors, []);
  assert.equal(calls.create, 1);
  clearTimeout(timeout);
  finish(true, { startupLive, liveHeading, reopenedHeading, sourceText, saved: true });
}
void run().catch((error) => finish(false, { failure: error.stack || error.message }));
