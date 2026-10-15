const fs = require('node:fs/promises');
const path = require('node:path');
const { FileStore, within } = require('./file-store.cjs');
const { KnowledgeStore } = require('./knowledge.cjs');

// A FileStore never changes roots after admission. In-flight operations and
// background tabs therefore retain their original project boundary.
class Workspaces {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.entries = new Map();
    this.activeRoot = null;
    this.closed = false;
    this.stores = new Set();
  }
  async admit(root) {
    root = await fs.realpath(root);
    if (this.closed) throw Error('后台任务仍在收尾，完成后会退出。');
    let entry = this.entries.get(root);
    if (!entry) {
      const store = new FileStore(this.dataDir);
      await store.setRoot(root);
      if (this.closed) throw Error('后台任务仍在收尾，完成后会退出。');
      this.stores.add(store);
      entry = { store, knowledge: new KnowledgeStore(store) };
      this.entries.set(root, entry);
    }
    return entry;
  }
  activate(root) {
    const entry = this.entries.get(root);
    if (!entry) throw Error('请先打开这个项目。');
    this.activeRoot = root;
    return entry;
  }
  current(root = this.activeRoot) {
    const entry = this.entries.get(root);
    if (!entry) throw Error('请先打开项目文件夹。');
    return entry;
  }
  remove(root) {
    this.entries.delete(root);
    if (this.activeRoot === root) this.activeRoot = null;
  }
  async forPath(target, { missing = false } = {}) {
    if (typeof target !== 'string' || !path.isAbsolute(target))
      throw Error('文档操作需要绝对路径。');
    // Use the lexical project first, so a symlink cannot grant access to a
    // different open project. FileStore.safe performs the realpath check.
    const root = [...this.entries.keys()]
      .filter((root) => within(root, target))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) throw Error('此路径不属于已打开的项目。');
    const entry = this.entries.get(root);
    await entry.store.safe(target, missing);
    return entry;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.stores].map((store) => store.close()));
  }
}
module.exports = { Workspaces };
