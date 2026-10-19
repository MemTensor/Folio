export interface ExperiencePreferences {
  onboarded: boolean;
  homeOnLaunch: boolean;
  discoverProjects: boolean;
  language: 'zh-CN' | 'en';
  pinnedProjects?: string[];
}
export interface ProjectOverview {
  preferences: ExperiencePreferences;
  projects: {
    id: string;
    root: string;
    name: string;
    sources: string[];
    available: boolean;
    registered: boolean;
    lastOpenedAt?: number;
    displayName?: string;
  }[];
  recentDocuments?: {
    path: string;
    name: string;
    projectName: string;
    relativePath: string;
    lastOpenedAt: number;
  }[];
  refreshedAt?: number | null;
  limited?: boolean;
  sync?: {
    enabled: boolean;
    available: boolean;
    projectIds: string[];
    lastSyncedAt?: number | null;
    conflicts?: any[];
    message?: string | null;
    running?: boolean;
    bindings?: Record<string, string>;
    cloudProjects?: { id: string; name: string; path: string }[];
  };
}
export interface FileSnapshot {
  path: string;
  content: string;
  hash: string | null;
  eol: 'LF' | 'CRLF';
  bom: boolean;
  mtime?: number;
  size?: number;
  workspaceRoot?: string;
}
export interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  size?: number;
  mtime?: number;
  children?: TreeNode[];
}
export interface DocumentCatalogResult {
  total: number;
  hasMore: boolean;
  offset: number;
  documents: {
    path: string;
    name: string;
    relativePath: string;
    modifiedAt: number;
    size: number;
  }[];
  limited: boolean;
  scanned: number;
  fromCache: boolean;
  updatedAt: number;
  excluded: boolean;
}
export interface DirectoryResult {
  nodes: TreeNode[];
  limited: boolean;
}
export interface SearchResult {
  path: string;
  name: string;
  line: number;
  text: string;
}
export interface HistoryEntry extends FileSnapshot {
  time: number;
  reason: string;
}
export interface HistoryMetadata {
  hash: string;
  time: number;
  reason: string;
  contentLength: number;
  path?: string;
  eol?: 'LF' | 'CRLF';
  bom?: boolean;
  bytes?: number;
}
export interface Draft {
  content: string;
  base: FileSnapshot;
  time?: number;
  restorePending?: boolean;
}
export interface FileEvent {
  path: string;
  file?: FileSnapshot;
  deleted?: boolean;
  error?: string;
}
export interface Workspace {
  root: string;
  tree: TreeNode[];
  initial?: string | null;
  autoOpen?: boolean;
  treeLimited?: boolean;
}
export type SaveResult =
  { ok: true; file: FileSnapshot } | { ok: false; conflict: FileSnapshot | null };
export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'preparing'
    | 'installing'
    | 'error';
  currentVersion: string;
  available?: { version: string; notes: string; publishedAt: string; size: number };
  progress?: { received: number; total: number; percent: number };
  message?: string;
  messageVars?: Record<string, string | number>;
  errorCode?: string;
  supported: boolean;
}
export interface AgentEdit {
  id: string;
  title: string;
  before: string;
  after: string;
  from: number;
  to: number;
}
export interface AgentMessage {
  provider?: 'chatgpt' | 'api';
  model?: string;
  id: string;
  role: 'user' | 'assistant';
  text: string;
  path: string;
  time: number;
  status?: 'running' | 'completed' | 'interrupted' | 'error';
  error?: string;
  repairing?: boolean;
  stopReason?: 'user' | 'timeout' | 'too-large' | 'shutdown' | 'restart' | 'disconnect' | 'runtime';
  finishedAt?: number;
  effort?: string;
  context?: 'selection' | 'document';
  referenceNames?: string[];
  sources?: {
    path: string;
    name: string;
    line: number;
    endLine: number;
    hash?: string;
    kind?: 'preview';
  }[];
  edits?: AgentEdit[];
  base?: string;
  baseHash?: string;
  selection?: { from: number; to: number } | null;
  outcome?: 'accepted' | 'dismissed' | 'undone';
}
export interface AgentConnection {
  provider?: 'chatgpt' | 'api';
  revision?: number;
  phase: 'idle' | 'connecting' | 'ready' | 'login' | 'missing' | 'error';
  waiting?: boolean;
  loginURL?: string;
  message?: string;
  account?: { email: string | null; plan: string };
  models: {
    id: string;
    name: string;
    isDefault: boolean;
    effort?: string;
    supportedEfforts?: string[];
    inputModalities?: string[];
  }[];
}
export interface AgentSettingsTarget {
  provider: 'chatgpt' | 'api';
  field?: 'baseURL' | 'key' | 'model';
}
export interface AgentSession {
  root: string;
  messages: AgentMessage[];
  running: boolean;
}
export interface AgentHintResult {
  requestId?: string;
  key: string;
  path: string;
  phase: 'idle' | 'empty' | 'generating' | 'ready' | 'unavailable';
  summary: string;
  hints: { label: string; prompt: string; mode: 'ask' | 'edit' }[];
  model?: string | null;
  message?: string;
}
export interface AgentRequest {
  path: string;
  content: string;
  selection: { from: number; to: number } | null;
  instruction: string;
  mode: 'auto' | 'ask' | 'edit';
  model?: string;
  effort?: string;
  revision?: number;
  references: string[];
  language: 'en' | 'zh-CN';
}
export interface Bridge {
  agentHints(input: {
    force?: boolean;
    requestId: string;
    path: string;
    content: string;
    scope: 'document' | 'selection';
    language: 'en' | 'zh-CN';
  }): Promise<AgentHintResult>;
  agentConfiguration(): Promise<{
    provider: 'chatgpt' | 'api';
    baseURL: string;
    model: string;
    hintModel: string;
    imageInput: boolean;
    hasKey: boolean;
    configured: boolean;
  }>;
  agentConfigure(input: {
    provider: 'chatgpt' | 'api';
    baseURL?: string;
    model?: string;
    hintModel?: string;
    imageInput?: boolean;
    apiKey?: string;
  }): Promise<any>;
  agentTestAPI(): Promise<{ models: string[] }>;
  agentStatus(): Promise<AgentConnection>;
  agentContext(input: {
    requestId: string;
    path: string;
    content: string;
    revision: number;
  }): Promise<void>;
  agentConnect(): Promise<AgentConnection>;
  agentAcquire(lease: string): Promise<AgentConnection>;
  agentLogin(): Promise<AgentConnection>;
  agentCancelLogin(): Promise<AgentConnection>;
  agentDisconnect(): Promise<AgentConnection>;
  agentRelease(lease: string): Promise<void>;
  agentSession(root: string): Promise<AgentSession>;
  agentSend(input: AgentRequest): Promise<AgentSession>;
  agentCancel(root: string): Promise<void>;
  agentClear(root: string): Promise<AgentSession>;
  agentResolve(
    root: string,
    id: string,
    outcome: 'accepted' | 'dismissed' | 'undone',
    editIds?: string[],
  ): Promise<AgentSession>;
  onAgent(
    cb: (
      event:
        | { type: 'connection'; connection: AgentConnection }
        | { type: 'context-request'; requestId: string; path: string }
        | { type: 'session'; session: AgentSession }
        | { type: 'progress'; root: string; id: string; text: string }
        | { type: 'hints'; result: AgentHintResult },
    ) => void,
  ): () => void;
  updateStatus(): Promise<UpdateState>;
  checkUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<UpdateState>;
  beginUpdateInstall(): Promise<{ requestId: string }>;
  commitUpdateInstall(options: { requestId: string }): Promise<void>;
  abortUpdateInstall(options: { requestId: string }): Promise<void>;
  updateBootReady(): Promise<void>;
  openUpdatePage(): Promise<void>;
  onUpdate(cb: (state: UpdateState) => void): () => void;
  dingtalkShare(path: string, to: string): Promise<any>;
  dingtalkInfo(path: string): Promise<any>;
  dingtalkPlan(
    path: string,
    options: {
      profile?: string;
      expectedRevision?: string;
      diagrams?: Array<{ source: string; png: string }>;
    },
  ): Promise<any>;
  dingtalkExecute(path: string, planId: string): Promise<any>;
  dingtalkReconcile(path: string): Promise<any>;
  dingtalkRecoveryInfo(path: string, options?: { nodeId?: string }): Promise<any>;
  dingtalkRecover(
    path: string,
    options: {
      action: 'attach' | 'adopt-remote' | 'detach' | 'confirm-not-created';
      expectedPlanId: string;
      nodeId?: string;
      expectedRevision?: number;
      confirmed: boolean;
    },
  ): Promise<any>;
  dingtalkShareStatus(path: string, to: string): Promise<any>;
  dingtalkShareResolve(
    path: string,
    options: {
      to: string;
      expectedPackageHash: string;
      outcome: 'sent' | 'not-sent';
      confirmed: boolean;
    },
  ): Promise<any>;
  librarySnapshot(options?: {
    query?: string;
    projectId?: string;
    offset?: number;
    limit?: number;
  }): Promise<any>;
  libraryOpen(path: string): Promise<Workspace>;
  activateWorkspace(root: string): Promise<Workspace>;
  libraryRemove(projectId: string): Promise<{ removed: boolean; projectId: string; root: string }>;
  libraryCancel(): Promise<void>;
  projectOverview(options?: { refresh?: boolean; discover?: boolean }): Promise<ProjectOverview>;
  projectConfigure(
    patch: Partial<ExperiencePreferences> & { syncEnabled?: boolean; syncProjectIds?: string[] },
  ): Promise<ProjectOverview>;
  projectOpen(id: string): Promise<Workspace>;
  projectSyncNow(): Promise<any>;
  projectSyncBind(input: { projectId: string; cloudId: string | null }): Promise<ProjectOverview>;
  projectSyncResolve(input: { id: string; choice: 'local' | 'cloud' }): Promise<any>;
  onProjects(callback: () => void): () => void;
  desktop: boolean;
  bootstrap(): Promise<Workspace>;
  choose(kind: 'file' | 'folder'): Promise<Workspace | null>;
  acceptOpen(root: string): Promise<Workspace>;
  tree(root?: string): Promise<TreeNode[]>;
  documents(
    root: string,
    options?: {
      query?: string;
      includeArchives?: boolean;
      refresh?: boolean;
      sort?: 'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc';
      limit?: number;
      offset?: number;
    },
  ): Promise<DocumentCatalogResult>;
  cancelDocuments(root: string): Promise<void>;
  markOpened(path: string): Promise<void>;
  directory(root: string, directory: string): Promise<DirectoryResult>;
  releaseDirectory(root: string, directory: string): Promise<void>;
  watchDocuments(paths: string[]): Promise<void>;
  quickOpen(root: string, query: string): Promise<Array<{ path: string; name: string }>>;
  read(path: string): Promise<FileSnapshot>;
  exportDiagnostics(): Promise<string | null>;
  diagnosticsSnapshot(): Promise<string>;
  copyText(text: string): Promise<void>;
  copyContent(content: { text: string; html?: string }, documentPath?: string): Promise<void>;
  contextMenu(input: {
    kind: 'document' | 'file' | 'tab' | 'text';
    path?: string;
    editable: boolean;
    selection: boolean;
    blockKind?: 'table' | 'math' | 'diagram';
  }): Promise<string | null>;
  save(args: FileSnapshot & { expectedHash: string | null }): Promise<SaveResult>;
  search(query: string, root?: string): Promise<SearchResult[]>;
  history(path: string): Promise<HistoryMetadata[]>;
  historyEntry(path: string, hash: string): Promise<HistoryEntry | null>;
  checkpoint(path: string, content: string): Promise<void>;
  getDraft(path: string): Promise<Draft | null>;
  putDraft(path: string, draft: Draft | null): Promise<void>;
  create(
    name: string,
    kind: 'file' | 'folder',
    root?: string,
  ): Promise<SaveResult | { path: string; kind: string }>;
  rename(path: string, name: string): Promise<FileSnapshot>;
  trash(path: string): Promise<boolean>;
  reveal(path: string): Promise<void>;
  openLink(href: string, path: string): Promise<{ file: FileSnapshot; anchor?: string } | void>;
  saveAs(file: FileSnapshot): Promise<(FileSnapshot & { openWarning?: boolean }) | null>;
  importImage(args: { path: string; name: string; data: string }): Promise<string>;
  export(args: {
    kind: 'html' | 'pdf' | 'docx';
    html: string;
    content: string;
    name: string;
    path?: string;
    diagrams?: string[];
    maths?: { source: string; svg: string }[];
  }): Promise<string | { path: string; message: string } | null>;
  dirty(value: boolean): Promise<void>;
  close(): Promise<void>;
  cloudBindProject(id: string | null, workspace: string): Promise<any>;
  cloudStatus(root?: string): Promise<any>;
  cloudConfigure(options: { apiKey?: string; clearKey?: boolean }): Promise<any>;
  cloudCreateCollection(name: string, description?: string): Promise<any>;
  cloudAttachCollection(id: string, name: string): Promise<any>;
  onFile(cb: (event: FileEvent) => void): () => void;
  onTree(cb: (root?: string) => void): () => void;
  onCommand(cb: (command: string) => void): () => void;
  onOpen(cb: (args: { root: string; path?: string }) => void): () => void;
  onNotice(cb: (message: string) => void): () => void;
}
declare global {
  interface Window {
    folio?: Bridge;
  }
}
