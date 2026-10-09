import type {
  Bridge,
  FileSnapshot,
  FileEvent,
  HistoryEntry,
  Draft,
  TreeNode,
  UpdateState,
  ProjectOverview,
} from './types';
import { version as demoVersion } from '../package.json';
import { createBridgeActivity, wrapBridgeActivity } from './bridge-activity.mjs';
import welcome from '../examples/欢迎使用 Folio.md?raw';
import guide from '../examples/Markdown 语法手册.md?raw';
import agents from '../examples/AGENTS.md?raw';
import claude from '../examples/CLAUDE.md?raw';
const listeners = new Set<(event: FileEvent) => void>();
const noop = () => () => {};
const root = '/Folio';
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
};
let contents: Record<string, string> = {};
try {
  contents = JSON.parse(localStorage.getItem('folio-demo-files') || '{}');
} catch {}
if (!Object.keys(contents).length)
  contents = {
    [root + '/欢迎使用 Folio.md']: welcome,
    [root + '/Markdown 语法手册.md']: guide,
    [root + '/AGENTS.md']: agents,
    [root + '/CLAUDE.md']: claude,
  };
const histories: Record<string, HistoryEntry[]> = {};
const drafts: Record<string, Draft> = {};
const snapshot = (p: string): FileSnapshot => {
  if (!(p in contents)) throw Error('文件不存在。');
  return {
    path: p,
    workspaceRoot: root,
    content: contents[p],
    hash: hash(contents[p]),
    eol: 'LF',
    bom: false,
  };
};
const persist = () => localStorage.setItem('folio-demo-files', JSON.stringify(contents));
const tree = async (): Promise<TreeNode[]> =>
  Object.keys(contents)
    .sort()
    .map((p) => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1), kind: 'file' }));
const unavailable = async (): Promise<any> => {
  throw Error('请在 Folio 桌面应用中使用本地文件操作。当前是浏览器演示。');
};
function demoProjects(): ProjectOverview {
  let preferences = {
    onboarded: false,
    homeOnLaunch: true,
    discoverProjects: false,
    language: 'zh-CN' as const,
  };
  try {
    preferences = {
      ...preferences,
      ...JSON.parse(localStorage.getItem('folio-demo-experience') || '{}'),
    };
  } catch {}
  return {
    preferences,
    projects: [
      { id: 'demo', root, name: 'Folio', sources: ['Folio'], available: true, registered: true },
    ],
    sync: { enabled: false, available: false, projectIds: [] },
  };
}
const demo: Bridge = {
  desktop: false,
  contextMenu: async () => null,
  exportDiagnostics: unavailable,
  diagnosticsSnapshot: unavailable,
  copyText: (text) => navigator.clipboard.writeText(text),
  agentStatus: async () => ({ phase: 'idle', models: [] }),
  agentContext: async () => {},
  agentHints: async ({ path }) => ({ key: '', path, phase: 'unavailable', summary: '', hints: [] }),
  agentConfiguration: async () => ({
    provider: 'chatgpt',
    baseURL: 'https://api.openai.com/v1',
    model: '',
    hintModel: '',
    hasKey: false,
    configured: false,
  }),
  agentConfigure: unavailable,
  agentTestAPI: unavailable,
  agentConnect: unavailable,
  agentAcquire: async () => ({ phase: 'idle', models: [] }),
  agentLogin: unavailable,
  agentCancelLogin: unavailable,
  agentDisconnect: unavailable,
  agentRelease: async () => {},
  agentSession: async (root) => ({ root, messages: [], running: false }),
  agentSend: unavailable,
  agentCancel: unavailable,
  agentClear: unavailable,
  agentResolve: unavailable,
  onAgent: noop,
  projectOverview: async () => demoProjects(),
  projectConfigure: async (patch) => {
    localStorage.setItem(
      'folio-demo-experience',
      JSON.stringify({ ...demoProjects().preferences, ...patch }),
    );
    return demoProjects();
  },
  projectOpen: async () => ({ root, tree: await tree(), autoOpen: false }),
  projectSyncNow: unavailable,
  projectSyncBind: unavailable,
  projectSyncResolve: unavailable,
  onProjects: noop,
  updateStatus: async () => ({
    phase: 'idle',
    currentVersion: demoVersion,
    supported: false,
    message: '浏览器演示不支持检查或安装更新。请在 Folio 桌面应用中使用此功能。',
  }),
  checkUpdates: async () => demo.updateStatus(),
  downloadUpdate: unavailable,
  cancelUpdate: async () => demo.updateStatus(),
  beginUpdateInstall: unavailable,
  commitUpdateInstall: unavailable,
  abortUpdateInstall: async () => {},
  updateBootReady: async () => {},
  openUpdatePage: unavailable,
  onUpdate: noop,
  dingtalkShare: unavailable,
  dingtalkInfo: unavailable,
  dingtalkPlan: unavailable,
  dingtalkExecute: unavailable,
  dingtalkReconcile: unavailable,
  dingtalkRecoveryInfo: unavailable,
  dingtalkRecover: unavailable,
  dingtalkShareStatus: unavailable,
  dingtalkShareResolve: unavailable,
  libraryRemove: unavailable,
  libraryCancel: async () => {},
  activateWorkspace: async () => ({ root, tree: await tree() }),
  librarySnapshot: async ({ query = '' } = {}) => ({
    projects: [{ id: 'demo', root, name: '示例文档' }],
    documents: Object.keys(contents)
      .filter((p) => !query || p.includes(query) || contents[p].includes(query))
      .map((p) => ({
        path: p,
        name: p.split('/').pop(),
        projectId: 'demo',
        projectName: '示例文档',
        relativePath: p.slice(root.length + 1),
        modifiedAt: Date.now(),
      })),
    total: Object.keys(contents).length,
    unavailable: [],
  }),
  libraryOpen: async (p) => ({ root, tree: await tree(), initial: p }),
  cloudBindProject: unavailable,
  cloudStatus: async () => ({ configured: false, collections: [], project: null }),
  cloudConfigure: unavailable,
  cloudCreateCollection: unavailable,
  cloudAttachCollection: unavailable,
  bootstrap: async () => ({ root, tree: await tree(), initial: root + '/欢迎使用 Folio.md' }),
  choose: unavailable,
  acceptOpen: unavailable,
  tree,
  documents: async (_root, options = {}) => {
    const found = (await tree()).filter(
      (n) =>
        !options.query || n.name.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()),
    );
    const offset = options.offset || 0,
      limit = options.limit || 100;
    return {
      documents: found.slice(offset, offset + limit).map((n) => ({
        path: n.path,
        name: n.name,
        relativePath: n.name,
        modifiedAt: Date.now(),
        size: contents[n.path]?.length || 0,
      })),
      total: found.length,
      offset,
      hasMore: offset + limit < found.length,
      limited: false,
      scanned: found.length,
      fromCache: true,
      updatedAt: Date.now(),
      excluded: false,
    };
  },
  cancelDocuments: async () => {},
  markOpened: async () => {},
  directory: async (_root, directory) => ({
    nodes: directory === root ? await tree() : [],
    limited: false,
  }),
  releaseDirectory: async () => {},
  watchDocuments: async () => {},
  quickOpen: async (_root, query) =>
    (await tree())
      .filter((n) => n.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .map(({ path, name }) => ({ path, name })),
  read: async (p) => snapshot(p),
  save: async (args) => {
    const current = args.path in contents ? snapshot(args.path) : null;
    if ((current?.hash ?? null) !== args.expectedHash) return { ok: false, conflict: current };
    if (current)
      (histories[args.path] ||= []).unshift({
        ...current,
        time: Date.now(),
        reason: 'before-save',
      });
    contents[args.path] = args.content;
    persist();
    return { ok: true, file: snapshot(args.path) };
  },
  search: async (q) =>
    Object.entries(contents).flatMap(([p, c]) =>
      c
        .split('\n')
        .flatMap((text, i) =>
          text.toLowerCase().includes(q.toLowerCase())
            ? [{ path: p, name: p.split('/').pop()!, line: i + 1, text }]
            : [],
        ),
    ),
  history: async (p) =>
    (histories[p] || []).map(({ content, ...entry }) => ({
      ...entry,
      hash: entry.hash!,
      contentLength: content.length,
    })),
  historyEntry: async (p, hash) =>
    (histories[p] || []).find((entry) => entry.hash === hash) || null,
  checkpoint: async (p, content) => {
    (histories[p] ||= []).unshift({
      ...snapshot(p),
      content,
      hash: hash(content),
      time: Date.now(),
      reason: 'human-before-review',
    });
  },
  getDraft: async (p) => drafts[p] || null,
  putDraft: async (p, d) => {
    if (d) drafts[p] = d;
    else delete drafts[p];
  },
  create: async (name, kind) => {
    if (kind === 'folder') throw Error('文件夹管理请使用桌面版。');
    const p = root + '/' + name;
    if (p in contents) throw Error('同名文件已存在。');
    contents[p] = '';
    persist();
    return { ok: true, file: snapshot(p) };
  },
  rename: async (p, name) => {
    const target = root + '/' + name;
    if (target in contents) throw Error('同名文件已存在。');
    contents[target] = contents[p];
    delete contents[p];
    persist();
    return snapshot(target);
  },
  trash: async (p) => {
    (histories[p] ||= []).unshift({ ...snapshot(p), time: Date.now(), reason: 'before-trash' });
    delete contents[p];
    persist();
    return true;
  },
  reveal: unavailable,
  openLink: async (href, p) => {
    if (/^https?:/.test(href)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    return { file: snapshot(decodeURIComponent(new URL(href, 'https://local' + p).pathname)) };
  },
  saveAs: unavailable,
  importImage: unavailable,
  export: async ({ kind, html, name }) => {
    if (kind !== 'html') throw Error('PDF 和 Word 导出请使用桌面应用。');
    const blob = new Blob([html], { type: 'text/html' }),
      url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/\.[^.]+$/, '') + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return a.download;
  },
  dirty: async () => {},
  close: async () => {},
  onFile: (cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  onTree: noop,
  onCommand: noop,
  onOpen: noop,
  onNotice: noop,
};
export const bridgeActivity = createBridgeActivity();
const writeMethods = new Set<keyof Bridge>([
  'exportDiagnostics',
  'agentSend',
  'agentConfigure',
  'agentLogin',
  'agentClear',
  'agentResolve',
  'bootstrap',
  'projectConfigure',
  'projectOpen',
  'projectSyncNow',
  'projectSyncBind',
  'projectSyncResolve',
  'choose',
  'acceptOpen',
  'activateWorkspace',
  'libraryOpen',
  'libraryRemove',
  'save',
  'saveAs',
  'checkpoint',
  'create',
  'rename',
  'trash',
  'importImage',
  'export',
  'close',
  'cloudConfigure',
  'cloudBindProject',
  'cloudCreateCollection',
  'cloudAttachCollection',
  'dingtalkPlan',
  'dingtalkExecute',
  'dingtalkReconcile',
  'dingtalkRecover',
  'dingtalkShare',
  'dingtalkShareResolve',
]);
export const bridge: Bridge = wrapBridgeActivity(
  window.folio || demo,
  bridgeActivity,
  writeMethods,
);
export function demoExternal(path: string, content: string) {
  contents[path] = content;
  persist();
  listeners.forEach((cb) => cb({ path, file: snapshot(path) }));
}
