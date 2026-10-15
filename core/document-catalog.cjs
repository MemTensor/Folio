const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { markdown, within, documentAllowed } = require('./document-catalog-policy.cjs');
const LIMITS = Object.freeze({
  maxEntries: 10000,
  maxDirectoryEntries: 2000,
  maxDocuments: 2000,
  maxDepth: 12,
  maxMs: 700,
});
const CACHE = Object.freeze({
  ttlMs: 60000,
  maxFiles: 24,
  maxBytes: 12 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
});
const fail = (code, message) => Object.assign(Error(message), { code });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const collator = new Intl.Collator('zh-CN', { numeric: true });
const sorts = new Set(['modified-desc', 'modified-asc', 'name-asc', 'name-desc']);
class DocumentCatalog {
  constructor(
    dataDir,
    {
      ttlMs = CACHE.ttlMs,
      timeoutMs = 2800,
      limits = {},
      cacheLimits = {},
      workerFactory = (file, options) => new Worker(file, options),
    } = {},
  ) {
    this.directory = path.join(dataDir, 'document-catalog');
    this.ttlMs = Math.max(0, Math.min(CACHE.ttlMs, ttlMs));
    this.timeoutMs = Math.max(1, Math.min(2800, timeoutMs));
    this.limits = Object.fromEntries(
      Object.entries(LIMITS).map(([key, max]) => [
        key,
        Math.max(1, Math.min(max, Math.floor(limits[key]) || max)),
      ]),
    );
    this.cacheLimits = Object.fromEntries(
      Object.entries(CACHE)
        .filter(([key]) => key !== 'ttlMs')
        .map(([key, max]) => [
          key,
          Math.max(1, Math.min(max, Math.floor(cacheLimits[key]) || max)),
        ]),
    );
    this.workerFactory = workerFactory;
    this.worker = null;
    this.retiring = new Set();
    this.pending = new Map();
    this.loads = new Map();
    this.memory = new Map();
    this.epochs = new Map();
    this.invalidated = new Map();
    this.pathChanges = new Map();
    this.nonDocumentFiles = new Map();
    this.sequence = 0;
    this.closed = false;
    this.persisting = Promise.resolve();
  }
  start() {
    if (this.worker) return this.worker;
    if (this.retiring.size >= 2)
      throw fail('DOCUMENT_CATALOG_BUSY', '上一次读取还在结束，请稍后刷新。');
    const worker = this.workerFactory(path.join(__dirname, 'document-catalog-worker.cjs'), {
      workerData: { limits: this.limits },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    this.worker = worker;
    worker.on('message', ({ id, result, error }) => {
      if (this.worker !== worker) return;
      const task = this.pending.get(id);
      if (!task) return;
      this.pending.delete(id);
      error ? task.reject(fail(error.code, error.message)) : task.resolve(result);
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', (error) => this.stopWorker(error, worker));
    worker.on('exit', () =>
      this.stopWorker(fail('DOCUMENT_CATALOG_EXIT', '文档目录暂不可用，请刷新重试。'), worker),
    );
    return worker;
  }
  stopWorker(error, worker = this.worker) {
    if (!worker || this.worker !== worker) return;
    this.worker = null;
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    this.retiring.add(worker);
    worker.unref();
    void Promise.resolve(worker.terminate())
      .catch(() => {})
      .finally(() => this.retiring.delete(worker));
  }
  request(operation, root, includeArchives = false, paths) {
    const worker = this.start(),
      id = ++this.sequence;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { root, resolve, reject });
      try {
        worker.postMessage({ id, operation, root, includeArchives, paths });
      } catch (error) {
        this.stopWorker(error);
      }
    });
  }
  key(root, includeArchives) {
    return digest(root + '\0' + includeArchives);
  }
  valid(value, root, includeArchives) {
    return (
      value?.version === 1 &&
      value.root === root &&
      value.includeArchives === includeArchives &&
      Number.isFinite(value.updatedAt) &&
      Number.isFinite(value.scannedAt || value.updatedAt) &&
      (value.scannedAt || value.updatedAt) <= Date.now() + 1000 &&
      value.updatedAt <= Date.now() + 1000 &&
      Date.now() - (value.scannedAt || value.updatedAt) <= this.ttlMs &&
      value.updatedAt > (this.invalidated.get(root) || 0) &&
      typeof value.limited === 'boolean' &&
      typeof value.excluded === 'boolean' &&
      Number.isInteger(value.scanned) &&
      value.scanned >= 0 &&
      value.scanned <= this.limits.maxEntries &&
      Array.isArray(value.documents) &&
      value.documents.length <= this.limits.maxDocuments &&
      value.documents.every(
        (doc) =>
          doc &&
          typeof doc.path === 'string' &&
          path.isAbsolute(doc.path) &&
          within(root, doc.path) &&
          doc.path !== root &&
          doc.name === path.basename(doc.path) &&
          markdown(doc.name) &&
          doc.relativePath === path.relative(root, doc.path).split(path.sep).join('/') &&
          documentAllowed(doc.relativePath, includeArchives) &&
          Number.isFinite(doc.modifiedAt) &&
          Number.isFinite(doc.size) &&
          doc.size >= 0,
      )
    );
  }
  async readCache(root, includeArchives) {
    const key = this.key(root, includeArchives),
      cached = this.memory.get(key);
    if (cached && this.valid(cached, root, includeArchives)) return cached;
    this.memory.delete(key);
    let handle;
    try {
      handle = await fs.open(
        path.join(this.directory, key + '.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.cacheLimits.maxFileBytes) return null;
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) return null;
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (!this.valid(value, root, includeArchives)) return null;
      value.changeSequence = 0;
      this.remember(key, value);
      return value;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
  remember(key, record) {
    const existing = this.memory.get(key);
    if (existing && (existing.changeSequence || 0) > (record.changeSequence || 0)) return;
    this.memory.delete(key);
    this.memory.set(key, record);
    while (this.memory.size > this.cacheLimits.maxFiles)
      this.memory.delete(this.memory.keys().next().value);
  }
  async writeCache(key, value, epoch) {
    const valid = () =>
      !this.closed &&
      (this.epochs.get(value.root) || 0) === epoch &&
      (this.memory.get(key)?.changeSequence || 0) <= (value.changeSequence || 0);
    if (!valid()) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, key + '.' + crypto.randomUUID() + '.tmp');
    try {
      const { changeSequence, ...persisted } = value;
      await fs.writeFile(temporary, JSON.stringify(persisted), { flag: 'wx', mode: 0o600 });
      if (valid()) await fs.rename(temporary, path.join(this.directory, key + '.json'));
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    const entries = [];
    const handle = await fs.opendir(this.directory);
    for await (const entry of handle) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile()) continue;
      const filename = path.join(this.directory, entry.name),
        stat = await fs.lstat(filename).catch(() => null);
      if (stat?.isFile()) entries.push({ filename, size: stat.size, time: stat.mtimeMs });
    }
    entries.sort((a, b) => b.time - a.time || a.filename.localeCompare(b.filename));
    let bytes = 0;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (index >= this.cacheLimits.maxFiles || bytes + entry.size > this.cacheLimits.maxBytes) {
        await fs.unlink(entry.filename).catch(() => {});
        this.memory.delete(path.basename(entry.filename, '.json'));
      } else bytes += entry.size;
    }
  }
  async load(root, includeArchives, refresh, epoch) {
    const check = () => {
      if (this.closed || (this.epochs.get(root) || 0) !== epoch)
        throw fail('DOCUMENT_CATALOG_CANCELED', '已取消文档目录读取。');
    };
    await this.request('validate', root);
    check();
    if (!refresh) {
      const cached = await this.readCache(root, includeArchives);
      check();
      if (cached) {
        const changed = await this.applyChanges(cached);
        check();
        if (changed) {
          if (changed !== cached) {
            const key = this.key(root, includeArchives);
            this.remember(key, changed);
            this.persisting = this.persisting
              .catch(() => {})
              .then(() => this.writeCache(key, changed, epoch));
            await this.persisting.catch(() => {});
          }
          return { ...changed, fromCache: true };
        }
      }
    }
    const changeSequence = this.pathChanges.get(root)?.sequence || 0;
    const result = await this.request('scan', root, includeArchives);
    check();
    let record = {
      version: 1,
      root,
      includeArchives,
      ...result,
      updatedAt: Math.max(Date.now(), (this.invalidated.get(root) || 0) + 1),
      changeSequence,
    };
    record.scannedAt = record.updatedAt;
    record = (await this.applyChanges(record)) || { ...record, limited: true };
    // Long paths cannot make an otherwise bounded metadata cache unbounded.
    while (
      Buffer.byteLength(JSON.stringify(record)) > this.cacheLimits.maxFileBytes &&
      record.documents.length
    ) {
      record.documents.splice(Math.floor(record.documents.length * 0.8));
      record.limited = true;
    }
    const key = this.key(root, includeArchives);
    this.remember(key, record);
    this.persisting = this.persisting
      .catch(() => {})
      .then(() => this.writeCache(key, record, epoch));
    await this.persisting.catch(() => {});
    check();
    return { ...record, fromCache: false };
  }
  async applyChanges(record) {
    const changes = this.pathChanges.get(record.root);
    const sequence = changes?.sequence || 0;
    const paths = [...(changes?.paths || [])]
      .filter(([, revision]) => revision > (record.changeSequence || 0))
      .map(([target]) => target);
    if (!paths.length) return record;
    const delta = await this.request('metadata', record.root, record.includeArchives, paths);
    if (delta.rescan) return null;
    const documents = new Map(record.documents.map((doc) => [doc.path, doc]));
    for (const target of delta.removed) documents.delete(target);
    for (const doc of delta.documents) documents.set(doc.path, doc);
    const values = [...documents.values()];
    const updated = new Set(delta.documents.map((doc) => doc.path));
    values.sort(
      (a, b) =>
        Number(updated.has(b.path)) - Number(updated.has(a.path)) ||
        b.modifiedAt - a.modifiedAt ||
        a.path.localeCompare(b.path),
    );
    return {
      ...record,
      documents: values.slice(0, this.limits.maxDocuments),
      limited: record.limited || values.length > this.limits.maxDocuments,
      changeSequence: sequence,
      updatedAt: Math.max(Date.now(), record.updatedAt),
    };
  }
  async list(root, options = {}) {
    // Default parameters only cover `undefined`; the renderer can send null.
    const {
      query = '',
      includeArchives = false,
      refresh = false,
      sort = 'modified-desc',
    } = options || {};
    let { limit = 100, offset = 0 } = options || {};
    if (this.closed) throw fail('DOCUMENT_CATALOG_CLOSED', '文档目录已关闭。');
    if (
      typeof root !== 'string' ||
      !path.isAbsolute(root) ||
      typeof query !== 'string' ||
      query.length > 1000 ||
      typeof includeArchives !== 'boolean' ||
      typeof refresh !== 'boolean' ||
      !sorts.has(sort)
    )
      throw fail('DOCUMENT_CATALOG_OPTIONS', '文档目录参数无效。');
    root = path.resolve(root);
    if (!this.epochs.has(root)) this.epochs.set(root, 0);
    limit = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 100));
    offset = Math.max(0, Math.min(this.limits.maxDocuments, Math.floor(Number(offset)) || 0));
    const epoch = this.epochs.get(root) || 0;
    const key =
      this.key(root, includeArchives) +
      ':' +
      epoch +
      ':' +
      refresh +
      ':' +
      (this.pathChanges.get(root)?.sequence || 0);
    let task = this.loads.get(key);
    if (!task) {
      task = this.load(root, includeArchives, refresh, epoch).finally(() => {
        if (this.loads.get(key) === task) this.loads.delete(key);
      });
      this.loads.set(key, task);
    }
    let timer;
    try {
      const record = await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = fail('DOCUMENT_CATALOG_TIMEOUT', '文件夹响应较慢，请稍后刷新文档目录。');
            this.epochs.set(root, (this.epochs.get(root) || 0) + 1);
            this.stopWorker(error);
            reject(error);
          }, this.timeoutMs);
        }),
      ]);
      const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const found = record.documents.filter((doc) =>
        terms.every((term) =>
          doc.relativePath.normalize('NFKC').toLocaleLowerCase().includes(term),
        ),
      );
      found.sort((a, b) => {
        const names =
          collator.compare(a.name, b.name) ||
          collator.compare(a.relativePath, b.relativePath) ||
          (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
        if (sort === 'name-asc') return names;
        if (sort === 'name-desc') return -names;
        return (
          (sort === 'modified-desc' ? b.modifiedAt - a.modifiedAt : a.modifiedAt - b.modifiedAt) ||
          names
        );
      });
      const hasMore = offset + limit < found.length;
      return {
        documents: found.slice(offset, offset + limit),
        total: found.length,
        hasMore,
        offset,
        limited: record.limited || hasMore,
        scanned: record.scanned,
        fromCache: record.fromCache,
        updatedAt: record.updatedAt,
        excluded: record.excluded,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async invalidate(root, file) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return;
    root = path.resolve(root);
    if (
      typeof file === 'string' &&
      path.isAbsolute(file) &&
      within(root, file) &&
      !markdown(file)
    ) {
      file = path.resolve(file);
      const key = root + '\0' + file;
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          this.nonDocumentFiles.delete(key);
          this.nonDocumentFiles.set(key, Date.now());
          while (this.nonDocumentFiles.size > 512)
            this.nonDocumentFiles.delete(this.nonDocumentFiles.keys().next().value);
          return;
        }
      } catch (error) {
        if (
          error.code === 'ENOENT' &&
          Date.now() - (this.nonDocumentFiles.get(key) || 0) < CACHE.ttlMs
        )
          return;
      }
      // A directory, symlink or unknown deletion can change which documents
      // exist below this path. Only previously observed regular files are safe
      // to ignore; never infer their type from a non-Markdown suffix alone.
    }
    if (typeof file === 'string' && path.isAbsolute(file) && within(root, file) && markdown(file)) {
      file = path.resolve(file);
      const changes = this.pathChanges.get(root) || { sequence: 0, paths: new Map() };
      changes.paths.set(file, ++changes.sequence);
      this.pathChanges.set(root, changes);
      if (changes.paths.size <= 256) return;
    }
    this.pathChanges.delete(root);
    for (const key of this.nonDocumentFiles.keys())
      if (key.startsWith(root + '\0')) this.nonDocumentFiles.delete(key);
    this.epochs.set(root, (this.epochs.get(root) || 0) + 1);
    this.invalidated.set(root, Date.now());
    await Promise.all(
      [false, true].map(async (includeArchives) => {
        const key = this.key(root, includeArchives);
        this.memory.delete(key);
        await fs.unlink(path.join(this.directory, key + '.json')).catch(() => {});
      }),
    );
  }
  async cancel(root) {
    if (root !== undefined && (typeof root !== 'string' || !path.isAbsolute(root))) return;
    if (root !== undefined) root = path.resolve(root);
    for (const target of root === undefined ? this.epochs.keys() : [root])
      this.epochs.set(target, (this.epochs.get(target) || 0) + 1);
    if (root === undefined || [...this.pending.values()].some((task) => task.root === root))
      this.stopWorker(fail('DOCUMENT_CATALOG_CANCELED', '已取消文档目录读取。'));
  }
  async close() {
    this.closed = true;
    await this.cancel();
    this.memory.clear();
    this.pathChanges.clear();
    this.nonDocumentFiles.clear();
  }
}
module.exports = {
  DocumentCatalog,
  DOCUMENT_CATALOG_LIMITS: LIMITS,
  DOCUMENT_CATALOG_CACHE: CACHE,
};
