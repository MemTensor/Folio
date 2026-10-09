const { AgentService, LIMIT } = require('../core/agent-service.cjs');
const { markdown } = require('../core/file-store.cjs');

function registerAgent({
  handle,
  workspaces,
  dataDir,
  version,
  onEvent,
  openExternal,
  agentService,
  encrypt,
  decrypt,
  listDocuments,
  getPreview,
  contextEnabled,
  diagnostics,
}) {
  const service =
    agentService ||
    new AgentService({
      dataDir,
      version,
      onEvent,
      openExternal,
      contextEnabled,
      diagnostics,
      settings: new (require('../core/agent-settings.cjs').AgentSettings)(dataDir, {
        encrypt,
        decrypt,
      }),
      documentTools: listDocuments
        ? new (require('../core/agent-documents.cjs').AgentDocuments)({
            getStore: (root) => workspaces.current(root).store,
            listDocuments,
            getPreview,
          })
        : undefined,
    });
  handle('agent-configuration', () => service.configuration());
  handle('agent-configure', (input) => service.configure(input));
  handle('agent-test-api', () => service.testAPI());
  handle('agent-hints', async (input) => {
    if (
      !input ||
      typeof input.content !== 'string' ||
      input.content.length > LIMIT ||
      typeof input.requestId !== 'string' ||
      input.requestId.length > 100
    )
      throw Error('文档或请求过长，请缩小范围后重试。');
    await workspaces.forPath(input.path);
    return service.suggestions({
      force: input.force === true,
      requestId: input.requestId,
      path: input.path,
      content: input.content,
      scope: input.scope === 'selection' ? 'selection' : 'document',
      language: input.language === 'en' ? 'English' : 'Chinese',
    });
  });
  handle('agent-status', () => service.status());
  handle('agent-context', async (input) => {
    if (
      !input ||
      typeof input.requestId !== 'string' ||
      input.requestId.length > 100 ||
      typeof input.content !== 'string' ||
      input.content.length > LIMIT ||
      !Number.isSafeInteger(input.revision)
    )
      return;
    const { store } = await workspaces.forPath(input.path);
    if (service.active?.root === store.root) service.resolveContext(input);
  });
  handle('agent-connect', () => service.connect());
  handle('agent-acquire', (lease) => service.acquire(lease));
  handle('agent-login', () => service.login());
  handle('agent-login-cancel', () => service.cancelLogin());
  handle('agent-disconnect', () => service.disconnect());
  handle('agent-release', (lease) => service.release(lease));
  const rootOf = (root) => workspaces.current(root).store.root;
  handle('agent-session', (root) => service.session(rootOf(root)));
  handle('agent-clear', (root) => service.clear(rootOf(root)));
  handle('agent-cancel', (root) => service.cancel(rootOf(root)));
  handle('agent-resolve', (root, id, outcome, editIds) => {
    if (typeof id !== 'string' || id.length > 100) throw Error('修改建议状态无效。');
    return service.resolve(rootOf(root), id, outcome, editIds);
  });
  handle('agent-send', async (input) => {
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.content !== 'string' ||
      input.content.length > LIMIT ||
      !Array.isArray(input.references) ||
      input.references.length > 3
    )
      throw Error('文档或请求过长，请缩小范围后重试。');
    const { store } = await workspaces.forPath(input.path);
    if (!markdown(input.path)) throw Error('只允许打开 Markdown 或文本文件。');
    const references = [];
    let length = input.content.length;
    for (const file of [...new Set(input.references)]) {
      const entry = await workspaces.forPath(file);
      if (entry.store.root !== store.root) throw Error('只能添加当前项目中的参考文档。');
      const safe = await store.safe(file);
      const stat = await require('node:fs/promises').stat(safe);
      if (stat.size > LIMIT * 4) throw Error('参考文档过大，请选择更小的文档。');
      const snapshot = await store.read(file);
      length += snapshot.content.length;
      if (length > LIMIT) throw Error('文档或请求过长，请缩小范围后重试。');
      references.push({
        name: require('node:path').relative(store.root, file),
        content: snapshot.content,
      });
    }
    return service.send({
      root: store.root,
      path: input.path,
      content: input.content,
      selection: input.selection || null,
      instruction: input.instruction,
      mode: input.mode,
      model: input.model,
      effort: input.effort,
      revision: input.revision,
      language: input.language === 'en' ? 'English' : 'Chinese',
      references,
    });
  });
  return service;
}
module.exports = { registerAgent };
