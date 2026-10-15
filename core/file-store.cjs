const fs = require('node:fs/promises');
const path = require('node:path');
const { isDependencyDirectory } = require('./ignored-directories.cjs');
const crypto = require('node:crypto');
const { encodeText, preferredEOL } = require('./encoding.cjs');
const { withLock, readRecoverableJSON, writeRecoverableJSON } = require('./state.cjs');
const { HistoryStore } = require('./history-store.cjs');
const { OperationGroup } = require('./operation-group.cjs');
const MAX_BYTES = 16 * 1024 * 1024;
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const markdown = (name) => /\.(md|markdown|mdown|mkd|txt|mdx|qmd|rmd)$/i.test(name);
const within = (root, target) =>
  target === root ||
  (!path.relative(root, target).startsWith('..' + path.sep) &&
    path.relative(root, target) !== '..' &&
    !path.isAbsolute(path.relative(root, target)));
class FileStore {
  constructor(dataDir, { historyMaxBytes, historyMaxEntries } = {}) {
    this.dataDir = dataDir;
    this.root = null;
    this.queues = new Map();
    this.operations = new OperationGroup();
    this.recovery = new HistoryStore(dataDir, {
      maxBytes: historyMaxBytes,
      maxEntries: historyMaxEntries,
    });
  }
  async setRoot(root) {
    this.root = await fs.realpath(root);
    if (!(await fs.stat(this.root)).isDirectory()) throw Error('请选择文件夹。');
    return this.root;
  }
  async safe(target, missing = false) {
    if (!this.root || typeof target !== 'string') throw Error('请先打开项目。');
    const absolute = path.resolve(this.root, target);
    let real;
    try {
      real = await fs.realpath(absolute);
    } catch (e) {
      if (!missing || e.code !== 'ENOENT') throw e;
      real = path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
    }
    if (!within(this.root, real)) throw Error('符号链接指向项目外部。');
    return real;
  }
  async snapshot(target) {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw Error('这不是普通文件。');
    if (stat.size > MAX_BYTES) throw Error('文件超过 16 MB，请使用专门的大文件编辑器。');
    const bytes = await fs.readFile(target);
    if (bytes.length > MAX_BYTES) throw Error('文件在读取时增长到 16 MB 以上。');
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (raw.includes('\0')) throw Error('不支持二进制文件。');
    const bom = raw.startsWith('\uFEFF');
    return {
      path: target,
      content: (bom ? raw.slice(1) : raw).replace(/\r\n/g, '\n'),
      hash: hash(bytes),
      eol: preferredEOL(raw),
      bom,
      mtime: stat.mtimeMs,
      size: bytes.length,
      mode: stat.mode & 0o777,
      raw,
    };
  }
  async read(target) {
    const p = await this.safe(target);
    // A project root is usually a whole repository or documents folder. Confining
    // reads to the file types Folio edits keeps opening a project from also
    // exposing the `.env`, key and config files that happen to sit beside the
    // documents. `save` has always applied the same rule.
    if (!markdown(p)) throw Error('只允许打开 Markdown 或文本文件。');
    const s = await this.snapshot(p);
    const historyBudget = await this.remember(s, 'read');
    const { raw, mode, ...visible } = s;
    return { ...visible, ...(historyBudget.overBudget ? { historyBudget } : {}) };
  }
  async checkpoint(target, content, reason = 'human-before-review') {
    return this.operations.run(() => this.checkpointQueued(target, content, reason));
  }
  async checkpointQueued(target, content, reason) {
    const p = await this.safe(target, true);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES)
      throw Error('快照内容无效。');
    return this.remember(
      { path: p, content, raw: content, hash: hash(content), eol: 'LF', bom: false },
      reason,
    );
  }
  historyDir(target) {
    return this.recovery.directoryFor(target);
  }
  async remember(snapshot, reason) {
    return this.recovery.remember(snapshot, reason);
  }
  async historyMetadata(target) {
    return this.recovery.list(await this.safe(target, true));
  }
  async historyEntry(target, revision) {
    return this.recovery.entry(await this.safe(target, true), revision);
  }
  async history(target) {
    const p = await this.safe(target, true),
      entries = [];
    for (const meta of await this.recovery.list(p)) {
      const entry = await this.recovery.entry(p, meta.hash);
      if (entry) entries.push(entry);
    }
    return entries;
  }
  /**
   * Run an operation that replaces or removes a document under the same per-file
   * lock and queue that `save` uses. Renaming or trashing outside that lock could
   * interleave with a save's temp-file-then-rename and drop the saved bytes.
   * @param {string} target @param {(resolved: string) => Promise<any>} run
   */
  async exclusive(target, run) {
    return this.operations.run(() => this.exclusiveQueued(target, run));
  }
  async exclusiveQueued(target, run) {
    const p = await this.safe(target, true);
    const prior = this.queues.get(p) || Promise.resolve();
    const job = prior.catch(() => {}).then(() => withLock(this.dataDir, 'file:' + p, () => run(p)));
    this.queues.set(p, job);
    try {
      return await job;
    } finally {
      if (this.queues.get(p) === job) this.queues.delete(p);
    }
  }
  async save(args) {
    return this.operations.run(() => this.saveQueued(args));
  }
  async rename(target, destination) {
    return this.operations.run(async () => {
      const before = await this.safe(target),
        after = await this.safe(destination, true);
      if (before === after) return this.read(before);
      if (!markdown(before) || !markdown(after)) throw Error('只能重命名 Markdown 或文本文件。');
      const keys = [before, after].sort();
      return withLock(this.dataDir, 'file:' + keys[0], () =>
        withLock(this.dataDir, 'file:' + keys[1], async () => {
          const linked = await this.snapshot(before),
            identity = await fs.stat(before);
          await fs.link(before, after);
          try {
            await this.recovery.copyTo(before, after);
            const draft = await this.readDraft(before);
            if (draft) {
              const existing = await this.readDraft(after);
              if (existing)
                await this.checkpointQueued(after, existing.content, 'recovery-before-rename');
              await this.writeDraftLocked(after, {
                ...draft,
                ...(draft.base ? { base: { ...draft.base, path: after } } : {}),
              });
            }
            const current = await fs.stat(before);
            if (
              current.ino !== identity.ino ||
              current.dev !== identity.dev ||
              (await this.snapshot(before)).hash !== linked.hash
            )
              throw Error('文档已变化，本次操作尚未应用，请重新审阅。');
            await fs.unlink(before);
          } catch (error) {
            // Do not remove a destination replaced or edited by another program.
            const current = await fs.stat(after).catch(() => null);
            if (
              current?.ino === identity.ino &&
              current?.dev === identity.dev &&
              (await this.snapshot(after).catch(() => null))?.hash === linked.hash
            )
              await fs.unlink(after).catch(() => {});
            throw error;
          }
          return this.read(after);
        }),
      );
    });
  }
  async saveQueued(args) {
    const p = await this.safe(args.path, true);
    if (!markdown(p)) throw Error('只允许写入 Markdown 或文本文件。');
    if (
      typeof args.content !== 'string' ||
      args.content.includes('\0') ||
      Buffer.byteLength(args.content) > MAX_BYTES
    )
      throw Error('文件内容无效或过大。');
    const prior = this.queues.get(p) || Promise.resolve();
    const job = prior
      .catch(() => {})
      .then(() => withLock(this.dataDir, 'file:' + p, () => this.saveLocked(p, args)));
    this.queues.set(p, job);
    try {
      return await job;
    } finally {
      if (this.queues.get(p) === job) this.queues.delete(p);
    }
  }
  async saveLocked(p, args) {
    let current = null;
    try {
      current = await this.snapshot(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if ((current?.hash ?? null) !== args.expectedHash)
      return { ok: false, conflict: current ? await this.read(p) : null };
    if (current) await this.remember(current, 'before-save');
    const eol = current?.eol || args.eol || 'LF',
      bom = current?.bom ?? args.bom ?? false;
    const raw = encodeText(args.content, { raw: current?.raw || '', eol, bom });
    const temp = path.join(path.dirname(p), '.folio-' + crypto.randomUUID() + '.tmp');
    try {
      const handle = await fs.open(temp, 'wx', current?.mode ?? 0o644);
      try {
        await handle.writeFile(raw, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Detect changes that arrived while the recovery snapshot / temp write was in progress.
      let latest = null;
      try {
        latest = await this.snapshot(p);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if ((latest?.hash ?? null) !== args.expectedHash) {
        if (latest) await this.remember(latest, 'concurrent-write');
        return { ok: false, conflict: latest ? await this.read(p) : null };
      }
      if (current) await fs.rename(temp, p);
      else {
        try {
          await fs.link(temp, p);
        } catch (e) {
          if (e.code === 'EEXIST') return { ok: false, conflict: await this.read(p) };
          throw e;
        }
      }
      const actual = await this.snapshot(p),
        { raw: actualRaw, mode, ...visible } = actual;
      const warnings = [];
      let historyBudget;
      try {
        historyBudget = await this.remember(actual, 'read');
      } catch (e) {
        warnings.push({
          code: 'HISTORY_UNAVAILABLE',
          message: '文档已写入，但恢复快照暂不可用：' + e.message,
        });
      }
      const written = { ...visible, ...(historyBudget?.overBudget ? { historyBudget } : {}) };
      if (written.hash !== hash(raw))
        return { ok: false, conflict: written, ...(warnings.length ? { warnings } : {}) };
      return { ok: true, file: written, ...(warnings.length ? { warnings } : {}) };
    } finally {
      await fs.unlink(temp).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }
  async tree() {
    if (!this.root) return [];
    let count = 0;
    const scan = async (dir, depth) => {
      if (depth > 12 || count > 10000) return [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const output = [];
      for (const item of entries) {
        if (item.name.startsWith('.') || isDependencyDirectory(item.name)) continue;
        if (++count > 10000) break;
        const p = path.join(dir, item.name);
        if (item.isDirectory()) {
          const children = await scan(p, depth + 1).catch(() => []);
          output.push({ name: item.name, path: p, kind: 'folder', children });
        } else if (item.isFile() && markdown(item.name)) {
          const stat = await fs.stat(p).catch(() => null);
          if (stat) output.push({ name: item.name, path: p, kind: 'file', mtime: stat.mtimeMs });
        }
      }
      return output.sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
          : a.kind === 'folder'
            ? -1
            : 1,
      );
    };
    return scan(this.root, 0);
  }
  async search(query) {
    if (typeof query !== 'string' || !query.trim()) return [];
    const tree = await this.tree(),
      files = [];
    const walk = (nodes) =>
      nodes.forEach((n) => (n.kind === 'file' ? files.push(n) : walk(n.children)));
    walk(tree);
    const results = [];
    const term = query.toLocaleLowerCase();
    for (const item of files) {
      if (results.length >= 200) break;
      try {
        const file = await this.snapshot(item.path);
        const lines = file.content.split('\n');
        lines.forEach((text, i) => {
          if (results.length < 200 && text.toLocaleLowerCase().includes(term))
            results.push({
              path: item.path,
              name: item.name,
              line: i + 1,
              text: text.slice(0, 300),
            });
        });
      } catch {}
    }
    return results;
  }
  async writeDraft(target, draft) {
    return this.operations.run(() => this.writeDraftQueued(target, draft));
  }
  async writeDraftQueued(target, draft) {
    if (!this.root || typeof target !== 'string') throw Error('草稿路径无效。');
    // Enqueue before asynchronous realpath checks so invocation order is preserved.
    const key = 'draft:' + path.resolve(this.root, target);
    const prior = this.queues.get(key) || Promise.resolve();
    const job = prior.catch(() => {}).then(() => this.writeDraftLocked(target, draft));
    this.queues.set(key, job);
    try {
      return await job;
    } finally {
      if (this.queues.get(key) === job) this.queues.delete(key);
    }
  }
  async writeDraftLocked(target, draft) {
    const p = await this.safe(target, true);
    const dir = path.join(this.dataDir, 'drafts');
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, hash(p) + '.json');
    if (!draft) {
      await withLock(dir, 'recoverable:' + path.basename(dest), async () => {
        for (const file of [dest, dest + '.backup'])
          await fs.unlink(file).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
      });
      return;
    }
    if (typeof draft.content !== 'string' || Buffer.byteLength(draft.content) > MAX_BYTES)
      throw Error('草稿过大。');
    await writeRecoverableJSON(dest, { ...draft, path: p, time: Date.now() });
  }
  async readDraft(target) {
    const p = await this.safe(target, true);
    return readRecoverableJSON(path.join(this.dataDir, 'drafts', hash(p) + '.json'), {
      fallback: null,
      label: '文档恢复草稿',
      validate: (d) =>
        d &&
        d.path === p &&
        typeof d.content === 'string' &&
        Buffer.byteLength(d.content) <= MAX_BYTES,
    });
  }
  async close() {
    await this.operations.close();
  }
}
module.exports = { FileStore, hash, within, markdown, MAX_BYTES };
