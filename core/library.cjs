const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { FileStore, within, markdown } = require('./file-store.cjs');
const { readRecoverableJSON, writeRecoverableJSON, withLock, digest } = require('./state.cjs');
const { DocumentIndex } = require('./document-index.cjs');
const { allowedLibraryRoot } = require('./library-root.cjs');
function validState(value) {
  return (
    !!value &&
    Array.isArray(value.projects) &&
    value.projects.every(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        /^[a-f0-9]{24}$/.test(p.id) &&
        typeof p.root === 'string' &&
        path.isAbsolute(p.root) &&
        typeof p.name === 'string',
    ) &&
    !!value.opened &&
    typeof value.opened === 'object' &&
    !Array.isArray(value.opened) &&
    Object.values(value.opened).every(Number.isFinite)
  );
}
class DocumentLibrary {
  constructor(dataDir, { home = os.homedir(), onRecovery } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'document-library.json');
    try {
      this.home = require('node:fs').realpathSync(home);
    } catch {
      this.home = path.resolve(home);
    }
    this.index = new DocumentIndex(dataDir, { home: this.home });
    this.onRecovery = onRecovery;
    this.generation = 0;
    this.removing = false;
  }
  async state() {
    return readRecoverableJSON(this.file, {
      fallback: { projects: [], opened: {} },
      validate: validState,
      label: '文档库登记信息',
      allowReset: true,
      onRecovery: this.onRecovery,
    });
  }
  async mutate(fn) {
    return withLock(this.dataDir, 'document-library', async () => {
      const db = await this.state(),
        result = await fn(db);
      await writeRecoverableJSON(this.file, db, { validate: validState, label: '文档库登记信息' });
      return result;
    });
  }
  async validateRoot(root) {
    root = await fs.realpath(root);
    if (!(await fs.stat(root)).isDirectory()) throw Error('请选择文件夹。');
    if (!this.allowsRoot(root)) {
      throw Object.assign(
        Error('请选择具体的项目文件夹；磁盘根目录和整个用户目录不能加入文档库。'),
        {
          code: 'USAGE',
        },
      );
    }
    return root;
  }
  allowsRoot(root) {
    return allowedLibraryRoot(root, this.home, { dataDir: this.dataDir });
  }
  async register(root) {
    root = await this.validateRoot(root);
    return this.mutate((db) => {
      let project = db.projects.find((p) => p.root === root);
      if (!project) {
        project = {
          id: digest(root).slice(0, 24),
          root,
          name: path.basename(root),
          addedAt: Date.now(),
        };
        db.projects.push(project);
      }
      project.lastOpenedAt = Date.now();
      return project;
    });
  }
  async remove(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
      throw Object.assign(Error('项目 ID 无效。'), { code: 'USAGE' });
    this.removing = true;
    this.generation++;
    await this.index.close();
    try {
      return await this.mutate(async (db) => {
        const project = db.projects.find((p) => p.id === id);
        if (!project) throw Object.assign(Error('此项目已不在文档库中。'), { code: 'USAGE' });
        // Purge only derived search data. Original files, drafts and history stay intact.
        await this.index.request({ operation: 'remove', root: project.root });
        db.projects = db.projects.filter((p) => p.id !== id);
        db.opened = Object.fromEntries(
          Object.entries(db.opened).filter(
            ([file]) =>
              !within(project.root, file) || db.projects.some((p) => within(p.root, file)),
          ),
        );
        return { removed: true, projectId: id, root: project.root };
      });
    } finally {
      this.removing = false;
    }
  }
  async rootFor(file) {
    const p = await fs.realpath(file),
      db = await this.state();
    return (
      db.projects
        .filter((r) => this.allowsRoot(r.root) && within(r.root, p))
        .sort((a, b) => b.root.length - a.root.length)[0]?.root || null
    );
  }
  async opened(file) {
    const p = await fs.realpath(file);
    return this.mutate((db) => {
      const now = Date.now();
      db.opened[p] = now;
      const project = db.projects
        .filter((project) => within(project.root, p))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (project) project.lastOpenedAt = now;
      db.opened = Object.fromEntries(
        Object.entries(db.opened)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 300),
      );
    });
  }
  async snapshot({ query = '', projectId, offset = 0, limit = 150 } = {}) {
    const generation = this.generation;
    return withLock(this.dataDir, 'document-library', async () => {
      if (this.removing || generation !== this.generation)
        throw Object.assign(Error('已取消查找。'), { code: 'SEARCH_CANCELED' });
      const db = await this.state();
      if (generation !== this.generation)
        throw Object.assign(Error('已取消查找。'), { code: 'SEARCH_CANCELED' });
      const projects = db.projects
        .slice()
        .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
      const blocked = projects.filter((p) => !this.allowsRoot(p.root)).map((p) => p.id);
      const result = await this.index.request({
        projects: projects.filter((p) => !blocked.includes(p.id)),
        opened: db.opened,
        query: String(query).slice(0, 1000),
        projectId,
        offset: Math.max(0, Math.floor(Number(offset) || 0)),
        limit: Math.max(1, Math.min(500, Math.floor(Number(limit) || 150))),
      });
      if (generation !== this.generation)
        throw Object.assign(Error('已取消查找。'), { code: 'SEARCH_CANCELED' });
      return { ...result, projects, blocked };
    });
  }
  async close() {
    this.generation++;
    await this.index.close();
  }
  async cancelSearch() {
    this.generation++;
    if (!this.removing) await this.index.close();
  }
  async locate(file) {
    const p = await fs.realpath(file);
    if (!markdown(p)) throw Error('请选择 Markdown 或文本文件。');
    const root = await this.rootFor(p);
    if (!root) throw Error('此文件不属于已打开过的项目。');
    const store = new FileStore(this.dataDir);
    await store.setRoot(root);
    await store.safe(p);
    return { path: p, root };
  }
}
module.exports = { DocumentLibrary, allowedLibraryRoot };
