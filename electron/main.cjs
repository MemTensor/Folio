const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  session,
  safeStorage,
  clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { FileStore, within, markdown } = require('../core/file-store.cjs');
const { WorkspaceBrowser } = require('../core/workspace-browser.cjs');
const { WorkspaceSession } = require('../core/workspace-session.cjs');
const { DocumentCatalog } = require('../core/document-catalog.cjs');
const { embedLocalImages } = require('../core/export-assets.cjs');
const { exportDocx } = require('../core/docx.cjs');
const { Workspaces } = require('../core/workspaces.cjs');
const { OperationGroup } = require('../core/operation-group.cjs');
const documentOperations = new OperationGroup();
const documentSearch = new (require('../core/document-search.cjs').DocumentSearch)();
const { DocumentLibrary } = require('../core/library.cjs');
const { createProjectServices } = require('./projects.cjs');
let projects,
  diagnostics,
  rebuildMenu = () => {};
let language = 'zh-CN';
const translateUI = (message) => {
  if (language !== 'en') return message;
  return require('./translations.en.cjs')[message] || message;
};
const { wordExportMessage } = require('./export-message.cjs');
const { desktopCloudOptions, PRINT_MAX_BYTES } = require('../core/desktop-policy.cjs');
const { writeJSON } = require('../core/state.cjs');
const { printPDF } = require('./print.cjs');
const { MemosCloud } = require('../core/memos-cloud.cjs');
const { DingTalkSync } = require('../core/dingtalk-sync.cjs');
const { UpdateService } = require('../core/update-service.cjs');
const { MacUpdateInstaller } = require('../core/update-installer.cjs');
const { RELEASE_PAGE } = require('../core/update-release.cjs');
const { UpdateGate } = require('../core/update-gate.cjs');
const updateGate = new UpdateGate({
  onExpire: ({ requestId }) => updater?.expireInstall(requestId),
});
let updater,
  updateQuitAuthorized = false,
  rendererGeneration = 0;
const updateOwner = () =>
  win && !win.isDestroyed() ? `${win.webContents.id}:${rendererGeneration}` : null;
async function abortPendingUpdate() {
  const requestId = updateGate.activeTicket()?.requestId;
  updateGate.cancel();
  if (requestId) await updater?.abortInstall(requestId).catch(() => {});
}

if (process.env.FOLIO_DATA_DIR) app.setPath('userData', path.resolve(process.env.FOLIO_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  { scheme: 'folio', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'folio-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let win,
  workspaces,
  agent,
  cloud,
  library,
  dingtalk,
  allowClose = false,
  rendererReady = false,
  dirty = false,
  pendingFile,
  configuration = {};
let workspaceBrowser, workspaceSession, documentCatalog;
const documentRequests = new Map(),
  documentViewDirectories = new Map();
const treeTimers = new Map(),
  documentTimers = new Map();
let historyBudgetNotice = false;
function reportHistoryBudget(file) {
  if (file?.historyBudget?.overBudget && !historyBudgetNotice) {
    historyBudgetNotice = true;
    send('notice', '历史快照超过存储配额，已优先保留必要的恢复副本，其余旧版本会自动清理。');
  }
}
const dev = process.env.FOLIO_DEV_URL === 'http://127.0.0.1:5173';
const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
function argFile(args) {
  return args.find((a) => !a.startsWith('-') && markdown(a) && path.isAbsolute(a));
}
pendingFile = argFile(process.argv);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, args) => {
  const file = argFile(args);
  if (file) requestOpen(file);
  win?.show();
  win?.focus();
});
const deferredOpens = [];
function requestOpen(file) {
  // `workspaces` exists well before the window does, and send() is a no-op with
  // no window, so an open request that arrives while init() is still running
  // used to vanish. Queue until there is somewhere to deliver it.
  if (win && workspaces) void openPath(file);
  else if (pendingFile === undefined || pendingFile === null) pendingFile = file;
  else if (deferredOpens.length < 32) deferredOpens.push(file);
}
function drainDeferredOpens() {
  if (!win || !workspaces) return;
  const queued = deferredOpens.splice(0, deferredOpens.length);
  for (const file of queued) void openPath(file);
}
app.on('open-file', (event, file) => {
  event.preventDefault();
  requestOpen(file);
});
function command(id) {
  send('command', id);
}
async function watchRoot(root) {
  root = await library.validateRoot(root);
  if (!workspaces.entries.has(root) && workspaces.entries.size >= 24)
    throw Error('同时打开的项目较多，请先从文档库移除不用的项目。');
  const existing = workspaces.entries.has(root);
  const { store } = await workspaces.admit(root);
  let result;
  try {
    result = await workspaceSession.list(store.root);
  } catch (error) {
    if (!existing) {
      workspaces.remove(root);
      await workspaceSession.closeRoot(root).catch(() => {});
    }
    throw error;
  }
  workspaces.activate(store.root);
  await library.register(store.root);
  configuration.root = store.root;
  await writeJSON(path.join(app.getPath('userData'), 'config.json'), configuration);
  return { root: store.root, tree: result.nodes, treeLimited: result.limited };
}
function refreshObservedDocument({ root, path: p }) {
  updateGate.changed();
  updater?.invalidate();
  clearTimeout(documentTimers.get(p));
  documentTimers.set(
    p,
    setTimeout(
      () =>
        void documentOperations
          .run(async () => {
            documentTimers.delete(p);
            if (!workspaceSession.documents.has(p)) return;
            try {
              const { store, knowledge } = workspaces.current(root);
              const file = { ...(await store.read(p)), workspaceRoot: root };
              await observeDocument(knowledge, file);
              if (workspaceSession.documents.has(p)) send('file-changed', { path: p, file });
            } catch (e) {
              if (workspaceSession.documents.has(p))
                send(
                  'file-changed',
                  e.code === 'ENOENT' ? { path: p, deleted: true } : { path: p, error: e.message },
                );
            }
          })
          .catch(() => {}),
      180,
    ),
  );
}
async function observeDocument(knowledge, file) {
  reportHistoryBudget(file);
  try {
    await knowledge.observe(file);
  } catch (e) {
    send('notice', '文档仍可阅读；来源记录暂不可用：' + e.message);
  }
}
async function openPath(file) {
  if (updateGate.activeTicket()) {
    send('notice', '正在准备更新，请稍后再打开文档。');
    return;
  }
  try {
    const absolute = await fs.realpath(file);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      send('open-request', { root: absolute });
      return;
    }
    send('open-request', {
      root: (await library.rootFor(absolute)) || path.dirname(absolute),
      path: absolute,
    });
  } catch (e) {
    send('notice', e.message);
  }
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    const url = event.senderFrame?.url || '';
    if (
      event.sender !== win?.webContents ||
      !(url.startsWith('folio://app/') || (dev && new URL(url).origin === 'http://127.0.0.1:5173'))
    )
      throw Error('无效的请求来源。');
    if (
      (name.startsWith('update-') ||
        name.startsWith('agent-') ||
        name.startsWith('diagnostics-') ||
        name === 'context-menu' ||
        name.startsWith('clipboard-write')) &&
      event.senderFrame?.frameTreeNodeId !== win.webContents.mainFrame.frameTreeNodeId
    )
      throw Error(
        name.startsWith('update-') ? '更新请求必须来自当前应用窗口。' : '无效的请求来源。',
      );
    const finish = updateGate.enter(name);
    try {
      return await documentOperations.run(() => fn(...args));
    } catch (error) {
      diagnostics?.record('ipc-failure', { operation: name, code: error.code });
      throw Object.assign(new Error(translateUI(error.message || String(error))), {
        code: error.code,
      });
    } finally {
      finish();
    }
  });
}
async function init() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  diagnostics = new (require('../core/diagnostics.cjs').Diagnostics)(app.getPath('userData'), {
    version: app.getVersion(),
  });
  diagnostics.record('app-start');
  handle('clipboard-write', require('./clipboard.cjs').createClipboardWriter(clipboard));
  handle(
    'clipboard-write-content',
    require('./clipboard.cjs').createRichClipboardWriter(
      clipboard,
      (content, documentPath, signal) =>
        require('../core/clipboard-assets.cjs').embedClipboardAssets(
          content,
          documentPath,
          workspaces,
          signal,
        ),
    ),
  );
  handle('diagnostics-snapshot', () => diagnostics.snapshot());
  handle('diagnostics-export', async () => {
    const snapshot = await diagnostics.snapshot();
    const result = await dialog.showSaveDialog(win, {
      title: translateUI('导出诊断信息'),
      defaultPath: path.join(
        app.getPath('downloads'),
        'Folio-diagnostics-' + new Date().toISOString().slice(0, 10) + '.json',
      ),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, snapshot, { mode: 0o600 });
    return result.filePath;
  });
  workspaces = new Workspaces(app.getPath('userData'));
  dingtalk = new DingTalkSync(app.getPath('userData'));
  cloud = new MemosCloud(app.getPath('userData'));
  agent = require('./agent.cjs').registerAgent({
    handle,
    workspaces,
    listDocuments: (root, options) => documentCatalog.list(root, options),
    getPreview: (input) => require('./agent-preview.cjs').captureDocumentPreview(win, input),
    contextEnabled: true,
    diagnostics,
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
    onEvent: (event) => send('agent-event', event),
    openExternal: (url) => shell.openExternal(url),
    encrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable())
        throw Error('系统安全存储不可用，暂时无法保存 API Key。');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  });
  library = new DocumentLibrary(app.getPath('userData'), {
    onRecovery: () => send('notice', '已恢复文档库登记信息，原始文档和草稿已保留。'),
  });
  try {
    configuration = JSON.parse(
      await fs.readFile(path.join(app.getPath('userData'), 'config.json'), 'utf8'),
    );
  } catch {}
  projects = createProjectServices({
    dataDir: app.getPath('userData'),
    library,
    openRoot: watchRoot,
    gate: updateGate,
    onChange: () => send('projects-changed'),
    onLanguage: (value) => {
      language = value;
      rebuildMenu();
    },
  });
  await projects.init();
  language = projects.getPreferences().language;
  handle('project-overview', (options) => projects.overview(options));
  handle('project-configure', (patch) => projects.configure(patch));
  handle('project-open', (id) => projects.open(id));
  handle('project-sync', () => projects.runSync());
  handle('project-sync-bind', (input) => projects.bind(input));
  handle('project-sync-resolve', (input) => projects.resolve(input));
  documentCatalog = new DocumentCatalog(app.getPath('userData'));
  workspaceBrowser = new WorkspaceBrowser({
    onChange: (event) => {
      void documentCatalog
        .invalidate(event.root, event.path)
        .then(() => workspaceSession.changed(event))
        .catch(() => workspaceSession.changed(event));
      projects?.schedule();
    },
    onNotice: (notice) => send('notice', translateUI(notice.message)),
  });
  workspaceSession = new WorkspaceSession(workspaceBrowser, {
    onTree: (root) => {
      clearTimeout(treeTimers.get(root));
      treeTimers.set(
        root,
        setTimeout(() => {
          treeTimers.delete(root);
          send('tree-changed', root);
        }, 120),
      );
    },
    onDocument: refreshObservedDocument,
  });
  const dist = path.join(app.getAppPath(), 'dist');
  protocol.handle('folio', (request) => {
    const url = new URL(request.url);
    const file = path.resolve(
      dist,
      '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
    );
    if (url.host !== 'app' || !within(dist, file))
      return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).href);
  });
  protocol.handle('folio-asset', async (request) => {
    try {
      const url = new URL(request.url),
        target = url.searchParams.get('path');
      if (url.hostname !== 'local') return new Response('Not found', { status: 404 });
      const { store } = await workspaces.forPath(url.searchParams.get('document'), {
        missing: true,
      });
      const file = await store.safe(target);
      if (!/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(file))
        return new Response('Unsupported asset', { status: 415 });
      return net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  handle('bootstrap', async () => {
    let root = configuration.root;
    if (pendingFile) {
      root = (await library.rootFor(pendingFile)) || path.dirname(pendingFile);
    }
    if (
      !root ||
      !library.allowsRoot(root) ||
      !(await fs
        .stat(root)
        .then((s) => s.isDirectory())
        .catch(() => false))
    ) {
      root = path.join(app.getPath('userData'), 'Welcome');
      await fs.mkdir(root, { recursive: true });
      const examples =
        language === 'en'
          ? ['en/Welcome to Folio.md', 'en/Markdown Guide.md', 'AGENTS.md', 'CLAUDE.md']
          : [
              '欢迎使用 Folio.md',
              'Markdown 语法手册.md',
              '公式、图与表.md',
              'AGENTS.md',
              'CLAUDE.md',
            ];
      for (const file of examples) {
        await fs
          .copyFile(
            path.join(app.getAppPath(), 'examples', file),
            path.join(root, path.basename(file)),
            require('node:fs').constants.COPYFILE_EXCL,
          )
          .catch((e) => {
            if (e.code !== 'EEXIST') throw e;
          });
      }
    }
    if (root === path.join(app.getPath('userData'), 'Welcome')) {
      await fs.mkdir(path.join(root, 'assets'), { recursive: true });
      await fs
        .copyFile(
          path.join(app.getAppPath(), 'examples/assets/example-curve.png'),
          path.join(root, 'assets/example-curve.png'),
          require('node:fs').constants.COPYFILE_EXCL,
        )
        .catch((e) => {
          if (e.code !== 'EEXIST') throw e;
        });
    }
    const info = await watchRoot(root);
    const initial = pendingFile;
    pendingFile = null;
    // The renderer is listening now, so anything that queued during startup can
    // be delivered.
    setImmediate(drainDeferredOpens);
    return { ...info, initial, platform: process.platform };
  });
  handle('choose', async (kind) => {
    const res = await dialog.showOpenDialog(win, {
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
      filters:
        kind === 'folder'
          ? undefined
          : [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt', 'qmd', 'rmd'] }],
    });
    if (res.canceled) return null;
    const selected = res.filePaths[0],
      root =
        kind === 'folder' ? selected : (await library.rootFor(selected)) || path.dirname(selected);
    return {
      ...(await watchRoot(root)),
      initial: kind === 'folder' ? null : selected,
      autoOpen: kind !== 'folder',
    };
  });
  // Only OS-originated open requests may switch to a path supplied by a renderer.
  let requestedRoot = null;
  app.on('folio-open-root', (_e, root) => (requestedRoot = root));
  handle('accept-open', async (root) => {
    if (root !== requestedRoot) throw Error('请使用文件选择窗口打开项目。');
    requestedRoot = null;
    return watchRoot(root);
  });
  handle('context-menu', async (input) => {
    const { contextItems, popupContext } = require('./context-menu.cjs');
    contextItems(input, translateUI, () => {});
    if (input?.kind !== 'text') {
      if (typeof input?.path !== 'string' || input.path.length > 8192)
        throw Error('右键菜单请求无效。');
      await workspaces.forPath(input.path);
    }
    return popupContext(Menu, win, input, translateUI);
  });
  const oldOpenPath = openPath;
  openPath = async (file) => {
    try {
      const real = await fs.realpath(file),
        stat = await fs.stat(real);
      requestedRoot = stat.isDirectory()
        ? real
        : (await library.rootFor(real)) || path.dirname(real);
      await oldOpenPath(file);
    } catch (e) {
      send('notice', e.message);
    }
  };
  handle('activate-workspace', async (root) => {
    workspaces.current(root);
    return watchRoot(root);
  });
  handle(
    'tree',
    async (root) => (await workspaceSession.list(workspaces.current(root).store.root)).nodes,
  );
  handle('documents', async (root, options) => {
    const { store } = workspaces.current(root);
    const generation = (documentRequests.get(root) || 0) + 1;
    documentRequests.set(root, generation);
    const result = await documentCatalog.list(store.root, options);
    if (documentRequests.get(root) === generation) {
      const dirs = new Set(options?.offset ? documentViewDirectories.get(root) || [] : [root]);
      for (const document of result.documents) {
        if (dirs.size >= 16) break;
        dirs.add(path.dirname(document.path));
      }
      documentViewDirectories.set(root, dirs);
      void workspaceSession
        .setCatalogDirectories(root, [...dirs])
        .catch((error) => send('notice', translateUI(error.message)));
    }
    return result;
  });
  handle('documents-cancel', async (root) => {
    if (typeof root !== 'string' || !workspaces.entries.has(root)) return;
    documentRequests.set(root, (documentRequests.get(root) || 0) + 1);
    documentViewDirectories.delete(root);
    await documentCatalog.cancel(root);
    await workspaceSession.setCatalogDirectories(root, []);
  });
  handle('directory', async (root, directory) => {
    const { store } = workspaces.current(root);
    return workspaceSession.list(store.root, directory);
  });
  handle('directory-release', async (root, directory) => {
    if (!workspaces.entries.has(root)) return;
    return workspaceSession.release(root, directory);
  });
  let observedGeneration = 0;
  handle('watch-documents', async (paths) => {
    if (
      !Array.isArray(paths) ||
      paths.length > 256 ||
      paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
    )
      throw Error('打开文档列表无效。');
    const generation = ++observedGeneration,
      files = [];
    for (const p of new Set(paths)) {
      try {
        const { store } = await workspaces.forPath(p, { missing: true });
        files.push({ root: store.root, path: await store.safe(p, true) });
      } catch {}
    }
    if (generation === observedGeneration) await workspaceSession.setDocuments(files);
  });
  handle('quick-open', async (root, query) => {
    workspaces.current(root);
    if (typeof query !== 'string' || query.length > 1000) throw Error('查找内容过长。');
    const project = (await library.state()).projects.find((p) => p.root === root);
    if (!project) return [];
    if (!query.trim()) {
      const opened = Object.entries((await library.state()).opened)
        .filter(([p]) => within(root, p))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100);
      return opened.map(([p]) => ({ path: p, name: path.basename(p) }));
    }
    const result = await library.index.request({ operation: 'filenames', root, query, limit: 100 });
    if (result.limited)
      send('notice', translateUI('快速打开只显示部分匹配；可输入更具体的文件名或打开子文件夹。'));
    return result.documents;
  });
  handle('read', async (p) => {
    const { store, knowledge } = await workspaces.forPath(p);
    const safe = await store.safe(p);
    await workspaceSession
      .openDocument(store.root, safe)
      .catch((e) => send('notice', translateUI(e.message)));
    const file = { ...(await store.read(safe)), workspaceRoot: store.root };
    await observeDocument(knowledge, file);
    return file;
  });
  handle('document-opened', async (p) => {
    try {
      const { store } = await workspaces.forPath(p);
      await library.opened(await store.safe(p));
      send('projects-changed');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
  handle('dingtalk-share', async (p, to) =>
    dingtalk.share((await workspaces.forPath(p)).knowledge, p, { to, confirmed: true }),
  );
  handle('dingtalk-info', async (p) => dingtalk.info((await workspaces.forPath(p)).knowledge, p));
  handle('dingtalk-plan', async (p, options) =>
    dingtalk.plan((await workspaces.forPath(p)).knowledge, p, options),
  );
  handle('dingtalk-execute', async (p, id) =>
    dingtalk.execute((await workspaces.forPath(p)).knowledge, id, {
      confirmed: true,
      expectedPath: p,
    }),
  );
  handle('dingtalk-reconcile', async (p) =>
    dingtalk.reconcile((await workspaces.forPath(p)).knowledge, p),
  );
  handle('dingtalk-recovery-info', async (p, options) =>
    dingtalk.recoveryInfo((await workspaces.forPath(p)).knowledge, p, options),
  );
  handle('dingtalk-recover', async (p, options) =>
    dingtalk.recover((await workspaces.forPath(p)).knowledge, p, { ...options, confirmed: true }),
  );
  handle('dingtalk-share-status', async (p, to) =>
    dingtalk.shareStatus((await workspaces.forPath(p)).knowledge, p, to),
  );
  handle('dingtalk-share-resolve', async (p, options) =>
    dingtalk.resolveShare((await workspaces.forPath(p)).knowledge, p, {
      ...options,
      confirmed: true,
    }),
  );
  handle('library-snapshot', (options) => library.snapshot(options));
  handle('library-cancel', () => library.cancelSearch());
  handle('library-remove', async (id) => {
    const result = await library.remove(id);
    documentRequests.set(result.root, (documentRequests.get(result.root) || 0) + 1);
    documentViewDirectories.delete(result.root);
    await documentCatalog.cancel(result.root);
    await workspaceSession.closeRoot(result.root);
    workspaces.remove(result.root);
    const pinned = projects.getPreferences().pinnedProjects || [];
    if (pinned.includes(id))
      await projects.configure({ pinnedProjects: pinned.filter((value) => value !== id) });
    if (configuration.root === result.root) {
      delete configuration.root;
      await writeJSON(path.join(app.getPath('userData'), 'config.json'), configuration);
    }
    return result;
  });
  handle('library-open', async (p) => {
    const found = await library.locate(p);
    return { ...(await watchRoot(found.root)), initial: found.path };
  });
  handle('save', async (args) => {
    const { store, knowledge } = await workspaces.forPath(args.path, { missing: true });
    let previous = null;
    try {
      previous = await store.read(args.path);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const result = await store.save(args);
    if (result.ok) {
      reportHistoryBudget(result.file);
      for (const warning of result.warnings || []) send('notice', warning.message);
    }
    if (result.ok)
      try {
        await knowledge.recordWrite(previous, result, {
          actor: 'Folio desktop',
          origin: 'unknown',
          evidence: 'desktop',
        });
      } catch (e) {
        send('notice', '文档已保存；来源记录暂不可用：' + e.message);
      }
    return result;
  });
  handle('search', (query, root) => {
    const store = workspaces.current(root).store;
    return documentSearch.search(store.root, store.dataDir, query);
  });
  handle('history', async (p) =>
    (await workspaces.forPath(p, { missing: true })).store.historyMetadata(p),
  );
  handle('history-entry', async (p, hash) =>
    (await workspaces.forPath(p, { missing: true })).store.historyEntry(p, hash),
  );
  handle('checkpoint', async (p, content) => {
    const result = await (
      await workspaces.forPath(p, { missing: true })
    ).store.checkpoint(p, content);
    reportHistoryBudget(result);
    return result;
  });
  handle('draft-get', async (p) =>
    (await workspaces.forPath(p, { missing: true })).store.readDraft(p),
  );
  handle('draft-put', async (p, draft) =>
    (await workspaces.forPath(p, { missing: true })).store.writeDraft(p, draft),
  );
  handle('cloud-status', (root) => cloud.status(workspaces.current(root).store.root));
  handle('cloud-bind-project', (id, root) =>
    cloud.bindProject(workspaces.current(root).store.root, id),
  );
  handle('cloud-configure', (args) => cloud.configure(desktopCloudOptions(args)));
  handle('cloud-create-collection', (name, description) => cloud.addCollection(name, description));
  handle('cloud-attach-collection', (id, name) => cloud.attachCollection(id, name));
  handle('create', async (name, kind, root) => {
    const { store } = workspaces.current(root);
    if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw Error('名称无效。');
    const p = await store.safe(path.join(store.root, name), true);
    if (kind === 'folder') {
      await fs.mkdir(p);
      return { path: p, kind };
    }
    return store.save({ path: p, content: '', expectedHash: null });
  });
  handle('rename', async (p, name) => {
    const { store, knowledge } = await workspaces.forPath(p);
    p = await store.safe(p);
    if (!markdown(p)) throw Error('只能重命名 Markdown 或文本文件。');
    if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || !markdown(name))
      throw Error('请输入有效的 Markdown 文件名。');
    const dest = await store.safe(path.join(path.dirname(p), name), true);
    if (p === dest) return store.read(p);
    const renamed = await store.rename(p, dest);
    await knowledge
      .rename(p, dest)
      .catch((error) =>
        send('notice', translateUI('文档仍可阅读；来源记录暂不可用：') + error.message),
      );
    return renamed;
  });
  handle('trash', async (p) => {
    const { store } = await workspaces.forPath(p);
    p = await store.safe(p);
    if (!markdown(p)) throw Error('只能把 Markdown 或文本文件移入回收站。');
    return store.exclusive(p, async (target) => {
      if (!(await fs.stat(target)).isFile()) throw Error('只能把单个文件移入回收站。');
      await store.remember(await store.snapshot(target), 'before-trash');
      await shell.trashItem(target);
      return true;
    });
  });
  handle('reveal', async (p) =>
    shell.showItemInFolder(await (await workspaces.forPath(p)).store.safe(p)),
  );
  handle('open-link', async (href, document) => {
    if (typeof href !== 'string') throw Error('无效的链接。');
    if (/^(https?:|mailto:)/i.test(href)) {
      const u = new URL(href);
      if (!['https:', 'http:', 'mailto:'].includes(u.protocol)) throw Error('不支持的链接。');
      return shell.openExternal(u.href);
    }
    const { store } = await workspaces.forPath(document);
    const doc = await store.safe(document);
    const [pathname, anchor] = href.split('#');
    const p = await store.safe(path.resolve(path.dirname(doc), decodeURIComponent(pathname)));
    if (!markdown(p)) throw Error('此链接不是 Markdown 文档。');
    return { file: await store.read(p), anchor: anchor ? decodeURIComponent(anchor) : null };
  });
  handle('save-as', async ({ path: p, content, eol, bom }) => {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: p,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled) return null;
    // Saving outside the current workspace is allowed only by the native save dialog.
    const sibling = new FileStore(app.getPath('userData'));
    await sibling.setRoot(path.dirname(res.filePath));
    return require('../core/save-as.cjs').saveAsDocument(
      sibling,
      { path: res.filePath, content, eol, bom },
      async (file) => watchRoot((await library.rootFor(file)) || path.dirname(file)),
    );
  });
  handle('import-image', async ({ path: document, name, data }) => {
    const { store } = await workspaces.forPath(document);
    const doc = await store.safe(document);
    if (typeof data !== 'string' || data.length > 28 * 1024 * 1024) throw Error('图片过大。');
    const ext = path.extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp'].includes(ext))
      throw Error('不支持此图片格式。');
    const dir = path.join(path.dirname(doc), 'assets');
    await fs.mkdir(dir, { recursive: true });
    await store.safe(dir);
    const clean =
      path
        .basename(name, ext)
        .replace(/[^\p{L}\p{N}_-]/gu, '-')
        .slice(0, 50) || 'image';
    const filename = clean + '-' + require('node:crypto').randomBytes(4).toString('hex') + ext;
    await fs.writeFile(path.join(dir, filename), Buffer.from(data, 'base64'), { flag: 'wx' });
    return 'assets/' + filename;
  });
  handle(
    'export',
    async ({ kind, html, content, name, path: documentPath, diagrams = [], maths = [] }) => {
      const { store } = await workspaces.forPath(documentPath);
      if (
        !['html', 'pdf', 'docx'].includes(kind) ||
        typeof html !== 'string' ||
        html.length > 40 * 1024 * 1024
      )
        throw Error('导出参数无效。');
      html = await embedLocalImages(html, store);
      if (Buffer.byteLength(html) > PRINT_MAX_BYTES)
        throw Error('导出内容过大，请压缩图片或拆分文档。');
      const result = await dialog.showSaveDialog(win, {
        defaultPath: name.replace(/\.[^.]+$/, '') + '.' + kind,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (result.canceled) return null;
      if (kind === 'html') await fs.writeFile(result.filePath, html, 'utf8');
      else if (kind === 'pdf') {
        await printPDF(html, result.filePath, app.getPath('temp'));
      } else {
        const dir = await fs.mkdtemp(path.join(app.getPath('temp'), 'folio-export-'));
        const temp = path.join(dir, 'document.md');
        try {
          let binary = [
            '/opt/homebrew/bin/pandoc',
            '/usr/local/bin/pandoc',
            '/usr/bin/pandoc',
          ].find((p) => require('node:fs').existsSync(p));
          if (!binary) throw Error('DOCX 导出需要安装 Pandoc。HTML 和 PDF 导出可直接使用。');
          const doc = await store.safe(documentPath);
          const resultInfo = await exportDocx({
            binary,
            content,
            resourceDir: path.dirname(doc),
            target: result.filePath,
            tempDir: dir,
            diagrams,
            maths,
          });
          if (resultInfo.fallbackCount || resultInfo.warnings)
            return {
              path: result.filePath,
              message: wordExportMessage(resultInfo, language),
            };
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
      return result.filePath;
    },
  );
  handle('dirty', (value) => {
    dirty = Boolean(value);
    win.setDocumentEdited(dirty);
  });
  handle('close', () => {
    if (updateGate.activeTicket()) throw Error('更新准备中，请稍候。');
    allowClose = true;
    win.close();
  });
  updater = new UpdateService({
    currentVersion: app.getVersion(),
    dataDir: app.getPath('userData'),
    supported: app.isPackaged,
    installer:
      app.isPackaged && process.platform === 'darwin'
        ? new MacUpdateInstaller({
            dataDir: app.getPath('userData'),
            currentBundle: path.resolve(process.execPath, '../../..'),
            helperPath: path.join(process.resourcesPath, 'updater', 'folio-update-helper'),
            currentVersion: app.getVersion(),
            arch: process.arch,
          })
        : null,
    onChange: (state) => send('update-state', state),
  });
  handle('update-status', () => updater.status());
  handle('update-check', () => updater.check());
  handle('update-download', () => updater.download());
  handle('update-cancel', () => {
    updater.cancel();
    return updater.snapshot();
  });
  handle('update-open-page', () => shell.openExternal(RELEASE_PAGE));
  handle('update-boot-ready', () => {
    rendererReady = true;
    return updater.bootReady();
  });
  handle('update-begin-install', () => {
    if (updateGate.writes || updateGate.activeTicket())
      throw Error('文档操作尚未完成，请稍后再更新。');
    const ticket = updater.beginInstall();
    updateGate.begin(ticket.requestId, updateOwner());
    return ticket;
  });
  handle('update-abort-install', async (args) => {
    if (
      !updateGate.activeTicket() ||
      args?.requestId !== updateGate.ticket.requestId ||
      updateGate.ticket.owner !== updateOwner()
    )
      return;
    updateGate.cancel(args.requestId);
    await updater.abortInstall(args.requestId);
  });
  handle('update-commit-install', async (args) => {
    const requestId = args?.requestId;
    try {
      updateGate.commit(requestId, updateOwner());
      await updater.commitInstall({
        requestId,
        parentPid: process.pid,
        guard: () => updateGate.valid(requestId, updateOwner()),
      });
      if (!updateGate.valid(requestId, updateOwner()))
        throw Error('文档状态已变化，更新安装已取消。');
      updateQuitAuthorized = true;
      allowClose = true;
      setImmediate(() => app.quit());
    } catch (error) {
      if (requestId && updateGate.activeTicket()?.requestId === requestId) {
        updateGate.cancel(requestId);
        await updater.abortInstall(requestId).catch(() => {});
      }
      throw error;
    }
  });
  createWindow();
}
function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 940,
    minWidth: 780,
    minHeight: 560,
    title: 'Folio',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame && !updateQuitAuthorized) {
      rendererGeneration++;
      agent?.releasePanels();
      void abortPendingUpdate();
    }
  });
  win.webContents.on('render-process-gone', () => {
    rendererReady = false;
    dirty = false;
    agent?.releasePanels();
    if (!updateQuitAuthorized) void abortPendingUpdate();
  });
  win.webContents.on('destroyed', () => {
    agent?.releasePanels();
    if (!updateQuitAuthorized) void abortPendingUpdate();
  });
  win.on('closed', () => {
    if (!updateQuitAuthorized) void abortPendingUpdate();
  });
  win.on('close', (event) => {
    if (updateGate.activeTicket() && !updateQuitAuthorized) {
      event.preventDefault();
      send('notice', '更新准备中，请稍候。');
      return;
    }
    if ((rendererReady || dirty) && !allowClose) {
      event.preventDefault();
      command('close-request');
    }
  });
  if (dev) win.loadURL(process.env.FOLIO_DEV_URL);
  else win.loadURL('folio://app/index.html');
  // The document UI never waits for the authenticated background client.
  // This restores an existing opt-in without starting model generation.
  void agent.warm().catch(() => {});
  const item = (label, id, accelerator) => ({ label, accelerator, click: () => command(id) });
  const menu = [
    {
      label: 'Folio',
      submenu: [
        { role: 'about' },
        item('检查更新…', 'updates'),
        item('设置…', 'settings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '文件',
      submenu: [
        item('项目首页', 'home'),
        item('新建文档', 'new', 'CmdOrCtrl+N'),
        item('打开文档…', 'open', 'CmdOrCtrl+O'),
        item('打开文件夹…', 'folder', 'CmdOrCtrl+Shift+O'),
        item('快速打开…', 'quick', 'CmdOrCtrl+P'),
        { type: 'separator' },
        item('保存', 'save', 'CmdOrCtrl+S'),
        item('另存为…', 'save-as', 'CmdOrCtrl+Shift+S'),
        item('发布到钉钉…', 'dingtalk'),
        {
          label: '导出',
          submenu: [
            item('PDF…', 'export-pdf'),
            item('HTML…', 'export-html'),
            item('Word (.docx)…', 'export-docx'),
          ],
        },
        { type: 'separator' },
        item('在 Finder 中显示', 'reveal'),
        { role: 'close' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('查找与替换', 'find', 'CmdOrCtrl+F'),
        item('搜索当前项目', 'search', 'CmdOrCtrl+Shift+F'),
      ],
    },
    {
      label: '段落',
      submenu: [
        item('1 级标题', 'heading-1', 'CmdOrCtrl+1'),
        item('2 级标题', 'heading-2', 'CmdOrCtrl+2'),
        item('3 级标题', 'heading-3', 'CmdOrCtrl+3'),
        item('4 级标题', 'heading-4', 'CmdOrCtrl+4'),
        item('5 级标题', 'heading-5', 'CmdOrCtrl+5'),
        item('6 级标题', 'heading-6', 'CmdOrCtrl+6'),
        { type: 'separator' },
        item('正文', 'paragraph', 'CmdOrCtrl+0'),
        item('引用', 'quote'),
        item('无序列表', 'bullet'),
        item('有序列表', 'ordered'),
        item('任务列表', 'task'),
        item('代码块', 'codeblock'),
        item('表格', 'table'),
        item('公式', 'math'),
        item('分隔线', 'rule'),
      ],
    },
    {
      label: '格式',
      submenu: [
        item('粗体', 'bold', 'CmdOrCtrl+B'),
        item('斜体', 'italic', 'CmdOrCtrl+I'),
        item('行内代码', 'code', 'CmdOrCtrl+Shift+K'),
        item('删除线', 'strike'),
        item('高亮', 'highlight'),
        item('超链接', 'link', 'CmdOrCtrl+K'),
        item('图片', 'image'),
      ],
    },
    {
      label: '显示',
      submenu: [
        item('即时预览 / 源码', 'source', 'CmdOrCtrl+/'),
        item('阅读模式', 'read', 'CmdOrCtrl+Shift+R'),
        item('显示 / 隐藏侧栏', 'sidebar', 'CmdOrCtrl+\\'),
        item('专注模式', 'focus', 'CmdOrCtrl+Shift+J'),
        item('打字机模式', 'typewriter', 'CmdOrCtrl+Shift+T'),
        item('沉浸写作', 'zen', 'CmdOrCtrl+Shift+Enter'),
        item('改动审阅', 'review'),
        item('Agent 文档助手', 'document-agent', 'CmdOrCtrl+J'),
        item('历史版本', 'history'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: '帮助',
      submenu: [
        item('Markdown 语法手册', 'guide'),
        item('快捷键与命令', 'commands', 'CmdOrCtrl+Shift+P'),
      ],
    },
  ];
  rebuildMenu = () => {
    const translated = (entries) =>
      entries.map((entry) => ({
        ...entry,
        ...(entry.label ? { label: translateUI(entry.label) } : {}),
        ...(Array.isArray(entry.submenu) ? { submenu: translated(entry.submenu) } : {}),
      }));
    Menu.setApplicationMenu(Menu.buildFromTemplate(translated(menu)));
  };
  rebuildMenu();
  projects.schedule();
}
app
  .whenReady()
  .then(init)
  .catch((e) => {
    dialog.showErrorBox('Folio 启动失败', e.stack || e.message);
    app.quit();
  });
app.on('before-quit', (event) => {
  if (updateGate.activeTicket() && !updateQuitAuthorized) {
    event.preventDefault();
    return;
  }
  if (!updateQuitAuthorized) {
    try {
      updater?.cancel();
    } catch {}
  }
});
app.on('window-all-closed', () => app.quit());
require('./shutdown.cjs').installShutdown(
  app,
  async () => {
    const requests = documentOperations.close();
    documentSearch.close();
    for (const timer of treeTimers.values()) clearTimeout(timer);
    for (const timer of documentTimers.values()) clearTimeout(timer);
    // Readers cancel independently; document replacements finish or roll back
    // before the process exits. A slow write must never be killed mid-replace.
    await Promise.allSettled([
      workspaceSession?.close(),
      documentCatalog?.close(),
      library?.close(),
      projects?.close(),
      agent?.close(),
    ]);
    await requests;
    await workspaces?.close();
    await diagnostics?.writing;
  },
  (error) => {
    try {
      console.error('[folio] shutdown:', error?.message || error);
    } catch {}
  },
);
