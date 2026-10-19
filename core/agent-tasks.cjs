const path = require('node:path'),
  crypto = require('node:crypto');
const { readJSON, writeJSON, withLock, digest } = require('./state.cjs');
const { CloudError, publish, refreshPublication, searchKnowledge } = require('./memos-cloud.cjs');

/** Task-bound memory work. No background daemon, cross-project default, or GUI queue. */
class AgentTasks {
  constructor(knowledge, cloud) {
    this.knowledge = knowledge.scoped();
    this.cloud = cloud;
    this.root = this.knowledge.store.root;
    this.file = path.join(knowledge.dataDir, 'agent-tasks', digest(this.root) + '.json');
  }
  async mutate(fn) {
    return withLock(this.knowledge.dataDir, 'agent-tasks:' + this.root, async () => {
      const db = await readJSON(this.file, { tasks: {} }),
        r = await fn(db);
      const ids = Object.keys(db.tasks).sort(
        (a, b) => db.tasks[b].startedAt - db.tasks[a].startedAt,
      );
      for (const id of ids.slice(100)) if (db.tasks[id].state === 'finished') delete db.tasks[id];
      await writeJSON(this.file, db);
      return r;
    });
  }
  async get(id) {
    const t = (await readJSON(this.file, { tasks: {} })).tasks[id];
    if (!t) throw new CloudError('当前项目中没有这个任务。', 'USAGE');
    return t;
  }
  async maintain(kb, connectionCloud = this.cloud) {
    const cloud = await connectionCloud.scopedConnection();
    const connection = await cloud.config();
    const result = { refreshed: 0, retired: 0, deferred: 0 };
    const entries = (await this.knowledge.publications()).filter(
      (p) =>
        p.baseURL === connection.baseURL &&
        p.knowledgebaseId === kb &&
        p.mode === 'navigation' &&
        p.baseURL,
    );
    for (const p of entries.filter((p) => p.state === 'submitted' && p.fileIds.length).slice(0, 2))
      try {
        await refreshPublication(this.knowledge, cloud, p.id);
        result.refreshed++;
      } catch {
        result.deferred++;
      }
    const latest = await this.knowledge.publications();
    // Only retire owned navigation projections after a replacement is available.
    // Historical source snapshots remain local and are never deleted here.
    const stale = [];
    for (const p of latest.filter(
      (p) =>
        p.baseURL === connection.baseURL &&
        p.knowledgebaseId === kb &&
        p.mode === 'navigation' &&
        ['ready', 'submitted'].includes(p.state) &&
        p.fileIds.length,
    )) {
      const newer = latest.find(
        (n) =>
          n.baseURL === p.baseURL &&
          n.fileIds?.length &&
          !n.fileIds.some((id) => p.fileIds.includes(id)) &&
          n.knowledgebaseId === kb &&
          n.documentId === p.documentId &&
          n.mode === 'navigation' &&
          n.state === 'ready' &&
          n.createdAt > p.createdAt,
      );
      if (newer) {
        const source = await this.knowledge.resolve(p.documentId).catch(() => null);
        if (source && source.revision === newer.revision) stale.push(p);
      }
    }
    for (const old of stale.slice(0, 2)) {
      try {
        if (old.baseURL !== connection.baseURL) continue;
        await cloud.removeDocuments(old.fileIds);
        await this.knowledge.mutate((db) => {
          db.publications[old.id] = { ...old, state: 'retired', retiredAt: Date.now() };
        });
        result.retired++;
      } catch {
        result.deferred++;
      }
    }
    return result;
  }
  async begin(query) {
    if (typeof query !== 'string' || !query.trim())
      throw new CloudError('task begin 需要简短的任务描述。', 'USAGE');
    const cloud = await this.cloud.scopedConnection();
    const binding = await cloud.project(this.root),
      task = {
        id: crypto.randomUUID(),
        workspace: this.root,
        startedAt: Date.now(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        query: query.slice(0, 1000),
        baseURL: (await cloud.config()).baseURL,
        knowledgebaseId: binding.knowledgebaseId,
        state: 'active',
      };
    await this.mutate((db) => (db.tasks[task.id] = task));
    let memory = {
      enabled: binding.enabled,
      status: binding.enabled ? 'available' : 'disabled',
      items: [],
      maintenance: null,
    };
    if (binding.enabled)
      try {
        memory.maintenance = await this.maintain(binding.knowledgebaseId, cloud);
        const found = await searchKnowledge(this.knowledge, cloud, query, binding.knowledgebaseId);
        memory.items = found.items.filter((i) => i.source);
        memory.unassociatedCount = found.items.length - memory.items.length;
      } catch (e) {
        memory.status = 'unavailable';
        memory.reason = e.code || 'CLOUD_ERROR';
      }
    return {
      task,
      memory,
      pendingDocuments: binding.enabled
        ? await this.knowledge.pending(8, {
            baseURL: task.baseURL,
            knowledgebaseId: binding.knowledgebaseId,
          })
        : [],
      notice:
        '默认只使用当前项目。索引仅帮助定位，具体结论请读取当前原文；历史问题显式读取旧 revision。',
    };
  }
  async finish(id, manifest = {}) {
    const task = await this.get(id);
    if (task.state === 'finished') return { ...task, replayed: true };
    const documents = Array.isArray(manifest) ? manifest : manifest.documents || [];
    if (!Array.isArray(documents) || documents.length > 10)
      throw new CloudError('每个任务最多整理 10 份相关文档。', 'USAGE');
    for (const d of documents)
      if (typeof d.path !== 'string' || !d.expectedRevision)
        throw new CloudError('每份文档需要 path 和读取到的 expectedRevision。', 'USAGE');
    const cloud = await this.cloud.scopedConnection();
    const binding = await cloud.project(this.root);
    const sameConnection = task.baseURL === (await cloud.config()).baseURL;
    const results = [];
    if (binding.enabled && sameConnection && binding.knowledgebaseId === task.knowledgebaseId) {
      for (const doc of documents) {
        if (typeof doc.path !== 'string' || !doc.expectedRevision)
          throw new CloudError('每份文档需要 path 和读取到的 expectedRevision。', 'USAGE');
        try {
          const item = await publish(this.knowledge, cloud, doc.path, binding.knowledgebaseId, {
            expectedRevision: doc.expectedRevision,
            summary: doc.summary,
            whenToRead: doc.whenToRead,
            mode: 'navigation',
          });
          results.push({ path: item.path, publicationId: item.id, state: item.state });
        } catch (e) {
          results.push({ path: doc.path, state: 'deferred', reason: e.code || 'ERROR' });
        }
      }
    }
    let maintenance = null;
    if (binding.enabled && sameConnection && binding.knowledgebaseId === task.knowledgebaseId)
      maintenance = await this.maintain(binding.knowledgebaseId, cloud);
    const finished = {
      ...task,
      state: 'finished',
      finishedAt: Date.now(),
      results,
      maintenance,
      memoryStatus: !binding.enabled
        ? 'disabled'
        : !sameConnection || binding.knowledgebaseId !== task.knowledgebaseId
          ? 'binding-changed'
          : 'processed',
    };
    await this.mutate((db) => (db.tasks[id] = finished));
    return finished;
  }
}
module.exports = { AgentTasks };
