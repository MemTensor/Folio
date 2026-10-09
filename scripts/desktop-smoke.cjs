const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AgentService } = require('../core/agent-service.cjs');
const { AgentSettings } = require('../core/agent-settings.cjs');
const { CompatibleClient } = require('../core/compatible-client.cjs');
const { AgentDocuments } = require('../core/agent-documents.cjs');
const { FileStore } = require('../core/file-store.cjs');
const { captureDocumentPreview } = require('../electron/agent-preview.cjs');
const { verifyTableEditor } = require('./desktop-table-check.cjs');
const { verifyBlockSelection } = require('./desktop-block-check.cjs');
const { verifyAgentPanel } = require('./desktop-agent-check.cjs');

const temporary = path.resolve(process.argv[2]),
  dist = path.resolve(process.argv[3]);
const scenario = process.argv[4] || 'normal',
  language = process.argv[5] || 'zh-CN',
  capturePath = process.argv[6] ? path.resolve(process.argv[6]) : null;
if (
  ![
    'normal',
    'home',
    'first-run',
    'table-edit',
    'block-select',
    'formula-preview',
    'agent',
  ].includes(scenario) ||
  !['zh-CN', 'en'].includes(language)
)
  throw Error('Unsupported desktop verification scenario or language.');
const editableScenario =
  scenario === 'normal' ||
  scenario === 'table-edit' ||
  scenario === 'block-select' ||
  scenario === 'formula-preview' ||
  scenario === 'agent';
const root = path.resolve(__dirname, '..');
const preload = path.join(root, 'electron/preload.cjs');
const workspace = path.join(temporary, 'workspace'),
  file = path.join(workspace, 'Startup.md');
const marker = 'FOLIO_DESKTOP_SMOKE_BODY';
const content =
  '# Desktop startup fixture\n\n' +
  marker +
  '\n' +
  (scenario === 'table-edit'
    ? '\n| Label | Notes |\n| --- | --- |\n| sample | one<br>two |\n\nFixture end.\n'
    : scenario === 'block-select'
      ? '\nBefore the code.\n\n```text\nalpha bravo charlie\nsecond line\n```\n\nAfter the code.\n\n```text\nstack=image bridge=/opt/Megatron-Bridge@8eea7a95e mcore=/opt/Megatron-Bridge/3rdparty/Megatron-LM@24fc94d27d47 capture_root=/mnt/data/generated-fixture/packed/worker-isolation-checkpoint\n```\n'
      : scenario === 'formula-preview'
        ? '\nOptimizer error ' +
          String.raw`\(\eta\)` +
          '.\n\n' +
          String.raw`\[` +
          '\n' +
          String.raw`|F_P(A)-F_Q(A)|` +
          '\n' +
          String.raw`\le` +
          '\n' +
          String.raw`\sum_i w_i\,TV(P_i,Q_i)` +
          '\n' +
          String.raw`\]` +
          '\n\nWithin prose ' +
          String.raw`\[a+b\]` +
          ' follows.\n'
        : scenario === 'agent'
          ? '\n$$a^2+b^2=c^2$$\n\n| Ratio | Score |\n| --- | --- |\n| A | 0.7 |\n'
          : '');
const errors = [],
  unexpectedIPC = [],
  calls = {};
let window,
  finished = false;
app.setPath('userData', path.join(temporary, 'user-data'));
app.setPath('sessionData', path.join(temporary, 'session-data'));
app.setName('Folio desktop verification');
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([
  { scheme: 'folio', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function finish(ok, details) {
  if (finished) return;
  finished = true;
  const result = { ok, scenario, language, calls, errors, unexpectedIPC, ...details };
  window?.destroy();
  process.stdout.write(JSON.stringify(result) + '\n', () => app.exit(ok ? 0 : 1));
}
process.on('uncaughtException', (error) => finish(false, { failure: error.message }));
process.on('unhandledRejection', (error) => finish(false, { failure: String(error) }));
const timeout = setTimeout(() => finish(false, { failure: 'Electron startup timed out.' }), 25000);
timeout.unref();

async function run() {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(file, content);
  const referenceFile = path.join(workspace, 'Reference.md');
  const referenceContent = '# Reference fixture\n\nGenerated context for the startup document.\n';
  await fs.writeFile(referenceFile, referenceContent);
  const referenceStore = new FileStore(path.join(temporary, 'agent-data'));
  await referenceStore.setRoot(workspace);
  const otherProject = path.join(temporary, 'generated-atlas-project');
  await fs.mkdir(otherProject, { recursive: true });
  const tree = [{ name: 'Startup.md', path: file, kind: 'file', mtime: 1_790_000_000_000 }];
  const snapshot = {
    path: file,
    workspaceRoot: workspace,
    content,
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    eol: 'LF',
    bom: false,
  };
  const agentClient = new EventEmitter();
  agentClient.cwd = temporary;
  agentClient.started = false;
  let threadCounter = 0,
    retryRequests = 0;
  agentClient.start = async () => {
    agentClient.started = true;
  };
  agentClient.stop = () => {
    agentClient.started = false;
    agentClient.emit('disconnected', Error('generated process stopped'));
  };
  agentClient.request = async (method, params) => {
    if (method === 'account/read')
      return { account: { type: 'chatgpt', planType: 'pro', email: 'fixture@example.invalid' } };
    if (method === 'model/list')
      return {
        data: [
          {
            model: 'fixture-model',
            displayName: 'Fixture model',
            isDefault: true,
            supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
              reasoningEffort,
            })),
          },
          {
            model: 'fixture-precise',
            displayName: 'Fixture precise',
            isDefault: false,
            supportedReasoningEfforts: ['low', 'high'].map((reasoningEffort) => ({
              reasoningEffort,
            })),
          },
          { model: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: false },
        ],
      };
    if (method === 'thread/start') return { thread: { id: 'thread-' + ++threadCounter } };
    if (method === 'turn/start') {
      const prompt = JSON.parse(params.input[0].text);
      const retryFixture = prompt.request === 'RETRY_INTERRUPTED_FIXTURE';
      if (retryFixture) retryRequests++;
      if (
        prompt.task === 'repair-document-response' &&
        (prompt.validationIssue.code !== 'AGENT_EDIT_MISSING' || params.effort !== 'high')
      )
        throw Error('Automatic repair did not receive source feedback and selected effort.');
      const hintReply = {
        summary: 'Startup fixture describes document initialization.',
        hints: [
          {
            label: 'Clarify startup wording',
            prompt:
              'Clarify the FOLIO_DESKTOP_SMOKE_BODY sentence in this document without inventing facts.',
            mode: 'edit',
          },
          {
            label: 'Clarify fixture sentence',
            prompt: 'Clarify the generated startup fixture sentence.',
            mode: 'edit',
          },
          {
            label: 'Document startup assumptions',
            prompt:
              'Add the assumptions stated in this document; mark missing details for confirmation.',
            mode: 'edit',
          },
        ],
      };
      const edits = ['edit', 'auto', 'repair-document-response'].includes(prompt.task)
        ? [
            {
              title: 'Improve the generated sentence',
              before:
                prompt.task === 'auto' && prompt.request.includes('rendered')
                  ? 'MISSING_MARKER_FOR_REPAIR'
                  : marker,
              after: marker + '_REFINED',
            },
          ]
        : [];
      const turnId = 'turn-' + threadCounter;
      setTimeout(
        async () => {
          if (retryFixture && retryRequests === 1) {
            agentClient.emit('notification', 'turn/completed', {
              threadId: params.threadId,
              turn: { status: 'interrupted' },
            });
            return;
          }
          if (prompt.task === 'auto' && prompt.request.includes('rendered')) {
            const preview = await agentClient.toolHandler({
              threadId: params.threadId,
              turnId,
              callId: 'generated-preview',
              tool: 'folio_preview_document',
              arguments: {},
            });
            if (
              !preview.success ||
              !preview.contentItems.some((item) => item.type === 'inputImage')
            )
              throw Error('Generated visual tool failed.');
          }
          if (['edit', 'auto'].includes(prompt.task)) {
            const read = await agentClient.toolHandler({
              threadId: params.threadId,
              turnId,
              callId: 'generated-read',
              tool: 'folio_read_document',
              arguments: { path: 'Reference.md', offset: 0 },
            });
            if (!read.success) throw Error('Generated document tool failed.');
          }
          agentClient.emit('notification', 'item/completed', {
            threadId: params.threadId,
            item: {
              type: 'agentMessage',
              text: JSON.stringify(
                retryFixture
                  ? { answer: 'Recovered generated request.', edits: [] }
                  : prompt.task === 'document-hints'
                    ? hintReply
                    : {
                        answer: 'The wording is more precise. Formula example: $a^2+b^2=c^2$.',
                        edits,
                      },
              ),
            },
          });
          agentClient.emit('notification', 'turn/completed', {
            threadId: params.threadId,
            turn: { status: 'completed' },
          });
        },
        prompt.task === 'document-hints' ? 500 : 10,
      );
      return { turn: { id: 'turn-' + threadCounter } };
    }
    return {};
  };
  const agentSettings = new AgentSettings(path.join(temporary, 'agent-data'), {
    encrypt: async (value) => Buffer.from(value.split('').reverse().join('')).toString('base64'),
    decrypt: async (value) => Buffer.from(value, 'base64').toString().split('').reverse().join(''),
  });
  const apiClient = new CompatibleClient(agentSettings, {
    fetchImpl: async (url, options) => {
      if (!url.startsWith('https://generated-provider.invalid/v1/'))
        throw Error('Unexpected generated API host.');
      if (options.headers.Authorization !== 'Bearer generated-api-key')
        throw Error('Unexpected generated API credential.');
      if (url.endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'fixture-api' }] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      const request = JSON.parse(options.body),
        prompt = JSON.parse(request.messages[1].content);
      const edits = ['edit', 'auto', 'repair-document-response'].includes(prompt.task)
        ? [{ title: 'Generated API edit', before: marker, after: marker + '_REFINED' }]
        : [];
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ answer: 'Generated API reply.', edits }) } },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  const agent = new AgentService({
    dataDir: path.join(temporary, 'agent-data'),
    settings: agentSettings,
    apiClient,
    client: agentClient,
    contextEnabled: true,
    documentTools: new AgentDocuments({
      getStore: () => referenceStore,
      getPreview: async (input) => {
        const preview = await captureDocumentPreview(window, input);
        if (preview.image && capturePath) {
          const file = path.join(
            path.dirname(capturePath),
            path.basename(capturePath, '.png') + '-model-preview.png',
          );
          await fs.writeFile(file, Buffer.from(preview.image.split(',')[1], 'base64'), {
            flag: 'wx',
          });
        }
        return preview;
      },
      listDocuments: async () => ({
        documents: [{ relativePath: 'Reference.md' }],
        limited: false,
      }),
    }),
    onEvent: (event) => window?.webContents.send('agent-event', event),
  });
  const handlers = {
    'agent-context': (input) => agent.resolveContext(input),
    'agent-hints': (input) => agent.suggestions(input),
    'agent-configuration': () => agent.configuration(),
    'agent-configure': (input) => agent.configure(input),
    'agent-test-api': () => agent.testAPI(),
    'agent-status': () => agent.status(),
    'agent-connect': () => agent.connect(),
    'agent-acquire': async (lease) => {
      const before = agent.status();
      const restored = await agent.acquire(lease);
      // Return a delayed, older snapshot after the ready notification. This
      // reproduces the renderer race without altering the real service state.
      if (before.phase === 'idle' && restored.phase === 'ready') {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return before;
      }
      return restored;
    },
    'agent-session': (root) => agent.session(root),
    'agent-release': (lease) => agent.release(lease),
    'agent-disconnect': () => agent.disconnect(),
    'agent-clear': (root) => agent.clear(root),
    'agent-send': (input) => {
      if (input.path !== file || input.references.length || input.mode !== 'auto')
        throw Error('Unexpected generated agent request.');
      return agent.send({ ...input, root: workspace });
    },
    'agent-resolve': (root, id, outcome, ids) => agent.resolve(root, id, outcome, ids),
    'project-overview': () => ({
      preferences: {
        onboarded: scenario !== 'first-run',
        homeOnLaunch: !editableScenario,
        discoverProjects: false,
        language,
        pinnedProjects: ['generated-orion', 'generated-atlas'],
      },
      projects: [
        {
          id: 'generated-orion',
          name: 'Orion Notes',
          root: workspace,
          sources: ['Codex'],
          registered: true,
          available: true,
        },
        {
          id: 'generated-atlas',
          name: 'Atlas Research',
          root: otherProject,
          sources: ['Claude Code'],
          registered: true,
          available: true,
        },
      ],
      recentDocuments: [
        {
          path: file,
          name: 'Startup.md',
          projectName: 'Orion Notes',
          relativePath: 'Startup.md',
          lastOpenedAt: 1790000000000,
        },
        {
          path: path.join(otherProject, 'Research.md'),
          name: 'Research.md',
          projectName: 'Atlas Research',
          relativePath: 'Research.md',
          lastOpenedAt: 1789990000000,
        },
      ],
      sync: { enabled: false, available: false, projectIds: [] },
    }),
    bootstrap: () => ({
      root: workspace,
      tree,
      initial: editableScenario ? file : null,
      platform: process.platform,
    }),
    read: (p) => {
      if (p === referenceFile)
        return {
          ...snapshot,
          path: referenceFile,
          content: referenceContent,
          hash: crypto.createHash('sha256').update(referenceContent).digest('hex'),
        };
      if (p !== file) throw Error('Unexpected document path.');
      return snapshot;
    },
    history: (p) => {
      if (p !== file) throw Error('Unexpected history path.');
      return [];
    },
    'dingtalk-info': (p) => {
      if (p !== file) throw Error('Unexpected publishing path.');
      return { profiles: [] };
    },
    'watch-documents': () => {},
    'document-opened': () => {},
    checkpoint: (p, text) => {
      if (p !== file || typeof text !== 'string') throw Error('Unexpected generated checkpoint.');
    },
    'documents-cancel': () => {},
    documents: () => ({
      documents: [
        {
          path: file,
          name: 'Startup.md',
          relativePath: 'docs/Startup.md',
          modifiedAt: 1790000000000,
          size: content.length,
        },
      ],
      total: 1,
      offset: 0,
      hasMore: false,
      limited: false,
      scanned: 1,
      fromCache: true,
      updatedAt: 1790000000000,
      excluded: true,
    }),
    'directory-release': () => {},
    directory: () => ({ nodes: tree, limited: false }),
    'quick-open': () => [{ path: file, name: 'Startup.md' }],
    'draft-get': (p) => {
      if (p !== file && p !== referenceFile) throw Error('Unexpected draft path.');
      return null;
    },
    ...(scenario === 'table-edit' || scenario === 'agent'
      ? {
          'draft-put': (p) => {
            if (p !== file) throw Error('Unexpected draft path.');
          },
          save: async (args) => {
            if (args.path !== file) throw Error('Unexpected save path.');
            if (args.expectedHash !== snapshot.hash) throw Error('Unexpected save revision.');
            await fs.writeFile(file, args.content);
            snapshot.content = args.content;
            snapshot.hash = crypto.createHash('sha256').update(args.content).digest('hex');
            return { ok: true, file: { ...snapshot } };
          },
        }
      : {}),
    'activate-workspace': (p) => {
      if (p !== workspace) throw Error('Unexpected workspace.');
      return { root: workspace, tree };
    },
    tree: () => tree,
    dirty: () => {},
    'update-status': () => ({ phase: 'idle', currentVersion: '0.0.0-test', supported: false }),
    'update-boot-ready': () => {},
  };
  // Keep the actual contextBridge API. Only its IPC backends are replaced with
  // generated fixtures; no production FileStore, cloud client or user state runs.
  const source = await fs.readFile(preload, 'utf8');
  for (const [, channel] of source.matchAll(/invoke\('([^']+)'\)/g)) {
    ipcMain.handle(channel, (_event, ...args) => {
      calls[channel] = (calls[channel] || 0) + 1;
      if (!Object.hasOwn(handlers, channel)) {
        unexpectedIPC.push(channel);
        throw Error('Unexpected IPC in startup check: ' + channel);
      }
      return handlers[channel](...args);
    });
  }
  await app.whenReady();
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    const allowed =
      request.url.startsWith('folio://app/') ||
      request.url.startsWith('data:') ||
      request.url.startsWith('blob:');
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
    const url = new URL(request.url),
      target = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
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
  let observed;
  for (let attempt = 0; attempt < 150; attempt++) {
    // Read DOM and the public preload property descriptor; never inject a mock
    // window.folio or interact with a real application window.
    observed = await window.webContents.executeJavaScript(`(() => {
      const scenario=${JSON.stringify(scenario)},language=${JSON.stringify(language)};
      const english=language==='en',toolbarLabel=english?'Paragraph and formatting commands':'段落与格式命令';
      const home=document.querySelector('.project-home'),firstRun=document.querySelector('.first-run'),grid=document.querySelector('.project-grid');
      const buttons=root=>Array.from(root?.querySelectorAll('button')||[]).map(button=>button.textContent.trim());
      const homeButtons=buttons(home),welcomeButtons=buttons(firstRun);
      const cards=Array.from(document.querySelectorAll('.project-grid .project-card:not(.add-project)'));
      const visible=element=>{if(!element)return false;const box=element.getBoundingClientRect();return box.width>0&&box.height>0&&getComputedStyle(element).visibility!=='hidden';};
      const overlayTop=root=>{if(!root)return false;const box=root.getBoundingClientRect();return root.contains(document.elementFromPoint(box.left+Math.min(box.width/2,100),box.top+Math.min(box.height/2,100)));};
      const common={
        bridgeFrozen:Object.isFrozen(window.folio),
        bootstrapReadOnly:Object.getOwnPropertyDescriptor(window.folio||{},'bootstrap')?.writable===false,
        appPresent:!!document.querySelector('#root .app'),
        toolbarPresent:!!document.querySelector('.editor-toolbar button[aria-label="'+toolbarLabel+'"]'),
        editorPresent:!!document.querySelector('[data-testid="markdown-editor"]'),
        documentPresent:document.querySelector('[data-testid="markdown-editor"]')?.textContent.includes(${JSON.stringify(marker)})===true,
        requestedLanguage:document.documentElement.lang===language,
        projectHomeEntry:!!document.querySelector('.titlebar button[aria-label="'+(english?'Project home':'项目首页')+'"]')
      };
      const maths=Array.from(document.querySelectorAll('[data-math-source]'));
      const formulaReady=maths.length===3&&maths.every(node=>node.dataset.mathReady==='true'&&!!node.querySelector('svg path'))&&maths.some(node=>node.dataset.mathDisplay==='false'&&node.dataset.mathSource===${JSON.stringify(String.raw`\eta`)})&&maths.some(node=>node.dataset.mathDisplay==='true'&&node.dataset.mathSource?.includes(${JSON.stringify(String.raw`\sum_i`)}))&&getComputedStyle(document.querySelector('.formula-inline.math-preview')).display==='block';
      const checks=(scenario==='normal'||scenario==='table-edit'||scenario==='block-select'||scenario==='formula-preview'||scenario==='agent')?{
        ...common,homeHidden:!home,onboardingHidden:!firstRun,
        workspaceEditable:document.querySelector('.workspace')?.inert===false,
        sortButton:!!document.querySelector('button[aria-label="'+(english?'Sort files':'文件排序')+'"]'),
        documentList:!!document.querySelector('.project-document-row'),
        defaultDocuments:document.querySelector('.workspace-file-view button[aria-pressed="true"]')?.textContent===(english?'Documents':'文档'),
        ...(scenario==='formula-preview'?{formulaReady}:{})
      }:scenario==='home'?{
        ...common,homePresent:visible(home),homeTopLayer:overlayTop(home),onboardingHidden:!firstRun,
        workspaceInert:document.querySelector('.workspace')?.inert===true,
        projectCards:cards.length===2&&cards.map(card=>card.querySelector('.project-card-name')?.textContent).join('|')==='Orion Notes|Atlas Research',
        coverLayout:cards.every(card=>{const box=card.querySelector('.notebook-cover')?.getBoundingClientRect();return box&&box.width>=100&&box.height>=150;}),
        gridLayout:!!grid&&getComputedStyle(grid).display==='grid',
        recentDocuments:home?.querySelectorAll('.recent-document').length===2,
        projectsHeading:home?.querySelector('.project-home-heading h1')?.textContent===(english?'Projects':'项目'),
        folderButton:homeButtons.some(text=>text.includes(english?'Add project':'添加项目')),
        resumeButton:homeButtons.includes(english?'Back to document':'返回文档')
      }:{
        ...common,onboardingPresent:visible(firstRun),onboardingTopLayer:overlayTop(firstRun),
        dialogSemantics:firstRun?.getAttribute('role')==='dialog'&&firstRun?.getAttribute('aria-modal')==='true',
        workspaceInert:document.querySelector('.workspace')?.inert===true,
        welcomeHeading:firstRun?.querySelector('#welcome-title')?.textContent===(english?'Welcome to Folio':'欢迎使用 Folio'),
        welcomeFeatures:firstRun?.querySelectorAll('.welcome-features section').length===3,
        continueButton:welcomeButtons.includes(english?'Continue':'继续'),
        skipButton:welcomeButtons.includes(english?'Skip introduction':'跳过引导'),
        languageSelector:firstRun?.querySelector('select[aria-label="'+(english?'Language':'语言')+'"]')?.value===language,
        focusInside:firstRun?.contains(document.activeElement)===true
      };
      return {checks,bodyExcerpt:document.body.innerText.slice(0,600)};
    })()`);
    if (errors.length || unexpectedIPC.length) return finish(false, { observed });
    if (
      Object.values(observed.checks).every(Boolean) &&
      calls.bootstrap &&
      calls.read &&
      calls['project-overview'] &&
      calls['update-boot-ready']
    ) {
      const tableEditing =
        scenario === 'table-edit'
          ? await verifyTableEditor(window, content, () => fs.readFile(file, 'utf8'))
          : null;
      const blockSelection =
        scenario === 'block-select'
          ? await verifyBlockSelection(window, content, capturePath)
          : null;
      const agentPanel =
        scenario === 'agent'
          ? await verifyAgentPanel(window, content, capturePath, language)
          : null;
      if (errors.length || unexpectedIPC.length)
        return finish(false, { observed, tableEditing, blockSelection });
      if (!tableEditing && (await fs.readFile(file, 'utf8')) !== content)
        throw Error('The read-only startup fixture was modified.');
      if (capturePath) {
        await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        const image = await window.webContents.capturePage();
        if (image.isEmpty()) throw Error('The generated desktop screenshot was empty.');
        await fs.writeFile(capturePath, image.toPNG(), { flag: 'wx' });
      }
      clearTimeout(timeout);
      return finish(true, {
        observed,
        ...(tableEditing ? { tableEditing } : { fixtureUnchanged: true }),
        ...(blockSelection ? { blockSelection } : {}),
        ...(agentPanel ? { agentPanel } : {}),
        ...(capturePath ? { capturePath } : {}),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  finish(false, {
    failure: 'Desktop scenario, language, or startup acknowledgement did not match expectations.',
    observed,
  });
}
void run().catch((error) => finish(false, { failure: error.message }));
