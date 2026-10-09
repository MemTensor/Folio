const path = require('node:path');
const key = (root, directory) => JSON.stringify([root, directory]);

// Keep only folders the person expanded and parents of open documents watched.
// Native events never cause arbitrary unopened document bodies to be read.
class WorkspaceSession {
  constructor(browser, { onTree = () => {}, onDocument = () => {} } = {}) {
    this.browser = browser;
    this.onTree = onTree;
    this.onDocument = onDocument;
    this.visible = new Map();
    this.documents = new Map();
    this.catalogDirectories = new Map();
    this.catalogEpochs = new Map();
    this.catalogOwned = new Map();
    this.catalogTasks = new Map();
    this.epochs = new Map();
    this.docEpoch = 0;
    this.generation = browser.generation;
    this.restoring = null;
    this.closed = false;
  }
  pinned(root, directory) {
    return (
      this.catalogDirectories.get(root)?.has(directory) ||
      [...this.documents.values()].some(
        (file) => file.root === root && path.dirname(file.path) === directory,
      )
    );
  }
  async list(root, directory = root) {
    const id = key(root, directory),
      epoch = (this.epochs.get(id) || 0) + 1;
    this.epochs.set(id, epoch);
    this.visible.set(id, { root, directory });
    try {
      const result = await this.browser.list(root, directory);
      if (!this.visible.has(id) && !this.pinned(root, directory))
        await this.browser.unwatch(root, directory);
      void this.restoreIfNeeded();
      return result;
    } catch (error) {
      if (this.epochs.get(id) === epoch) this.visible.delete(id);
      throw error;
    }
  }
  async release(root, directory = root) {
    const id = key(root, directory);
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
    this.visible.delete(id);
    if (!this.pinned(root, directory)) await this.browser.unwatch(root, directory);
  }
  async openDocument(root, file) {
    if (this.documents.size >= 256 && !this.documents.has(file)) return;
    this.documents.set(file, { root, path: file });
    const directory = path.dirname(file);
    await this.browser.watch(root, directory);
    if (!this.pinned(root, directory) && !this.visible.has(key(root, directory)))
      await this.browser.unwatch(root, directory);
    void this.restoreIfNeeded();
  }
  async setDocuments(files) {
    const epoch = ++this.docEpoch;
    const previous = [...this.documents.values()];
    this.documents = new Map(files.slice(0, 256).map((file) => [file.path, file]));
    const parents = new Map(
      files.map((file) => [
        key(file.root, path.dirname(file.path)),
        { root: file.root, directory: path.dirname(file.path) },
      ]),
    );
    for (const { root, directory } of parents.values()) {
      if (epoch !== this.docEpoch) return;
      await this.browser.watch(root, directory);
      if (!this.pinned(root, directory) && !this.visible.has(key(root, directory)))
        await this.browser.unwatch(root, directory);
    }
    for (const file of previous) {
      if (epoch !== this.docEpoch) return;
      const directory = path.dirname(file.path);
      if (!this.pinned(file.root, directory) && !this.visible.has(key(file.root, directory)))
        await this.browser.unwatch(file.root, directory);
    }
  }
  async setCatalogDirectories(root, directories) {
    const epoch = (this.catalogEpochs.get(root) || 0) + 1;
    this.catalogEpochs.set(root, epoch);
    const selected = new Set(directories.slice(0, 16));
    if (selected.size) this.catalogDirectories.set(root, selected);
    else this.catalogDirectories.delete(root);
    // Desired directories may change while an asynchronous watch is pending.
    // Keep actual acquisitions independently, and serialize their reconciliation
    // so a superseded page cannot lose subscriptions that still need releasing.
    const prior = this.catalogTasks.get(root) || Promise.resolve();
    const task = prior
      .catch(() => {})
      .then(async () => {
        if (this.closed || this.catalogEpochs.get(root) !== epoch) return;
        const owned = this.catalogOwned.get(root) || new Set();
        this.catalogOwned.set(root, owned);
        try {
          for (const directory of selected) {
            if (this.closed || this.catalogEpochs.get(root) !== epoch) return;
            owned.add(directory);
            await this.browser.watch(root, directory);
            if (!this.pinned(root, directory) && !this.visible.has(key(root, directory))) {
              await this.browser.unwatch(root, directory);
              owned.delete(directory);
            }
          }
        } finally {
          for (const directory of owned) {
            if (this.closed || this.catalogEpochs.get(root) !== epoch) break;
            if (selected.has(directory)) continue;
            if (!this.pinned(root, directory) && !this.visible.has(key(root, directory)))
              await this.browser.unwatch(root, directory);
            owned.delete(directory);
          }
          if (!owned.size && this.catalogOwned.get(root) === owned) this.catalogOwned.delete(root);
        }
        void this.restoreIfNeeded();
      });
    this.catalogTasks.set(root, task);
    try {
      await task;
    } finally {
      if (this.catalogTasks.get(root) === task) this.catalogTasks.delete(root);
    }
  }
  changed(event) {
    if (
      this.visible.has(key(event.root, event.directory)) ||
      this.catalogDirectories.get(event.root)?.has(event.directory)
    )
      this.onTree(event.root);
    for (const file of this.documents.values()) {
      if (
        file.root === event.root &&
        path.dirname(file.path) === event.directory &&
        (!event.path || event.path === file.path)
      )
        this.onDocument(file);
    }
  }
  restoreIfNeeded() {
    if (this.closed || this.generation === this.browser.generation) return Promise.resolve();
    if (this.restoring) return this.restoring;
    const generation = this.browser.generation;
    const required = new Map([...this.visible]);
    for (const [root, dirs] of this.catalogDirectories)
      for (const directory of dirs) required.set(key(root, directory), { root, directory });
    for (const file of this.documents.values())
      required.set(key(file.root, path.dirname(file.path)), {
        root: file.root,
        directory: path.dirname(file.path),
      });
    this.restoring = (async () => {
      for (const { root, directory } of required.values()) {
        if (this.closed || this.browser.generation !== generation) return;
        if (!this.visible.has(key(root, directory)) && !this.pinned(root, directory)) continue;
        await this.browser.watch(root, directory);
        if (!this.visible.has(key(root, directory)) && !this.pinned(root, directory))
          await this.browser.unwatch(root, directory);
      }
      if (this.browser.generation === generation) this.generation = generation;
    })()
      .catch(() => {})
      .finally(() => {
        this.restoring = null;
      });
    return this.restoring;
  }
  async closeRoot(root) {
    this.docEpoch++;
    this.catalogEpochs.set(root, (this.catalogEpochs.get(root) || 0) + 1);
    this.catalogDirectories.delete(root);
    this.catalogOwned.delete(root);
    for (const [id, item] of this.visible) if (item.root === root) this.visible.delete(id);
    for (const [file, item] of this.documents) if (item.root === root) this.documents.delete(file);
    await this.browser.closeRoot(root);
  }
  async close() {
    this.closed = true;
    this.docEpoch++;
    this.visible.clear();
    this.catalogDirectories.clear();
    this.catalogOwned.clear();
    this.documents.clear();
    await this.browser.close();
  }
}
module.exports = { WorkspaceSession };
