const fs = require('node:fs/promises');
const path = require('node:path');
const { digest, readJSON, writeJSON, withLock } = require('./state.cjs');
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_HISTORY_BYTES = 256 * 1024 * 1024;
const newest = (a, b) => b.time - a.time || b.sequence - a.sequence;
const contentOf = (record) =>
  typeof record.content === 'string'
    ? record.content
    : record.raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const validRecord = (record) =>
  record &&
  typeof record.path === 'string' &&
  HASH.test(record.hash) &&
  Number.isFinite(record.time) &&
  (typeof record.content === 'string' || typeof record.raw === 'string');
const validCatalog = (value) =>
  value?.version === 1 &&
  value.documents &&
  typeof value.documents === 'object' &&
  !Array.isArray(value.documents) &&
  Object.entries(value.documents).every(
    ([key, doc]) =>
      HASH.test(key) &&
      typeof doc.path === 'string' &&
      digest(doc.path) === key &&
      Array.isArray(doc.entries) &&
      doc.entries.every(
        (e) =>
          HASH.test(e.hash) && Number.isFinite(e.time) && Number.isFinite(e.bytes) && e.bytes >= 0,
      ),
  );

/** Snapshot content is immutable; the derived catalog only contains small metadata. */
class HistoryStore {
  constructor(dataDir, { maxBytes = DEFAULT_HISTORY_BYTES, maxEntries = 80 } = {}) {
    this.dataDir = dataDir;
    this.directory = path.join(dataDir, 'history');
    this.catalog = path.join(this.directory, 'catalog.json');
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_HISTORY_BYTES;
    this.maxEntries = Math.max(1, Math.min(80, Math.floor(maxEntries) || 80));
  }
  directoryFor(target) {
    return path.join(this.directory, digest(target));
  }
  file(target, hash) {
    if (!HASH.test(hash)) throw Error('历史版本标识无效。');
    return path.join(this.directoryFor(target), hash + '.json');
  }
  budget(db) {
    return {
      totalBytes: db.totalBytes || 0,
      maxBytes: this.maxBytes,
      overBudget: (db.totalBytes || 0) > this.maxBytes,
      protectedCopiesRetained: true,
    };
  }
  metadata(record, bytes, sequence = 0) {
    return {
      hash: record.hash,
      path: record.path,
      time: record.time,
      reason: record.reason || 'read',
      eol: record.eol || 'LF',
      bom: !!record.bom,
      contentLength: contentOf(record).length,
      bytes,
      sequence,
    };
  }
  async loadCatalog() {
    let db;
    try {
      db = await readJSON(this.catalog);
      if (db && !validCatalog(db)) throw new SyntaxError('Invalid history catalog');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await fs.rename(this.catalog, this.catalog + '.damaged-' + Date.now());
    }
    if (db && validCatalog(db)) return db;
    db = { version: 1, sequence: 0, documents: {} };
    // One-time migration / cache recovery. Read one body at a time, never all bodies in parallel.
    for (const dir of await fs.readdir(this.directory).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    })) {
      if (!HASH.test(dir)) continue;
      for (const name of await fs.readdir(path.join(this.directory, dir)).catch(() => [])) {
        if (!HASH.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
        try {
          const source = await fs.readFile(path.join(this.directory, dir, name), 'utf8'),
            record = JSON.parse(source);
          if (!validRecord(record) || digest(record.path) !== dir || name !== record.hash + '.json')
            continue;
          const doc = (db.documents[dir] ||= { path: record.path, entries: [] });
          doc.entries.push(this.metadata(record, Buffer.byteLength(source), ++db.sequence));
        } catch {
          /* Preserve unreadable legacy bodies for manual recovery. */
        }
      }
    }
    await this.prune(db);
    return db;
  }
  async inspectOrphans(db, target) {
    const key = digest(target),
      doc = (db.documents[key] ||= { path: target, entries: [] });
    let changed = false;
    const names = await fs.readdir(this.directoryFor(target)).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    const known = new Set(doc.entries.map((e) => e.hash + '.json'));
    for (const name of names) {
      if (known.has(name) || !name.endsWith('.json') || !HASH.test(name.slice(0, -5))) continue;
      try {
        const source = await fs.readFile(path.join(this.directoryFor(target), name), 'utf8'),
          record = JSON.parse(source);
        if (!validRecord(record) || record.path !== target || record.hash + '.json' !== name)
          continue;
        doc.entries.push(this.metadata(record, Buffer.byteLength(source), ++db.sequence));
        changed = true;
      } catch {
        /* An interrupted or damaged snapshot is retained, not mistaken for usable history. */
      }
    }
    return changed;
  }
  async prune(db) {
    const removable = [],
      discard = [],
      all = [];
    for (const doc of Object.values(db.documents)) {
      doc.entries.sort(newest);
      const protectedHashes = new Set(doc.entries.slice(0, 1).map((e) => e.hash));
      if (doc.latestObservedHash) protectedHashes.add(doc.latestObservedHash);
      const recovery = doc.entries.find((e) => /human|review|recovery|draft/.test(e.reason));
      if (recovery) protectedHashes.add(recovery.hash);
      let retained = protectedHashes.size;
      for (const entry of doc.entries) {
        const candidate = { doc, entry };
        all.push(candidate);
        if (!protectedHashes.has(entry.hash)) {
          if (retained >= this.maxEntries) discard.push(candidate);
          else {
            retained++;
            removable.push(candidate);
          }
        }
      }
    }
    let bytes =
      all.reduce((n, x) => n + x.entry.bytes, 0) - discard.reduce((n, x) => n + x.entry.bytes, 0);
    removable.sort((a, b) => -newest(a.entry, b.entry));
    for (const candidate of removable) {
      if (bytes <= this.maxBytes) break;
      discard.push(candidate);
      bytes -= candidate.entry.bytes;
    }
    for (const { doc, entry } of discard)
      doc.entries = doc.entries.filter((e) => e.hash !== entry.hash);
    db.totalBytes = bytes;
    db.overBudget = bytes > this.maxBytes;
    // Commit metadata before GC. A failed unlink only leaves an extra recovery copy.
    await writeJSON(this.catalog, db);
    for (const { doc, entry } of discard)
      await fs.unlink(this.file(doc.path, entry.hash)).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
  }
  async remember(snapshot, reason) {
    return withLock(this.dataDir, 'history-catalog', async () => {
      const db = await this.loadCatalog(),
        target = snapshot.path;
      let changed = await this.inspectOrphans(db, target);
      const doc = db.documents[digest(target)];
      if (doc.latestObservedHash !== snapshot.hash) {
        doc.latestObservedHash = snapshot.hash;
        changed = true;
      }
      const existing = doc.entries.find((e) => e.hash === snapshot.hash);
      if (existing && /human|review|recovery|draft/.test(reason)) {
        const file = this.file(target, existing.hash),
          record = await readJSON(file);
        if (
          record &&
          validRecord(record) &&
          record.path === target &&
          record.hash === existing.hash
        ) {
          existing.reason = reason;
          existing.time = Date.now();
          existing.sequence = ++db.sequence;
          // Promotion must survive catalog rebuilds; the snapshot text itself stays untouched.
          await writeJSON(file, { ...record, reason, time: existing.time });
          existing.bytes = (await fs.stat(file)).size;
          changed = true;
        }
      }
      if (existing) {
        try {
          await fs.stat(this.file(target, existing.hash));
          if (changed) await this.prune(db);
          return this.budget(db);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          doc.entries = doc.entries.filter((e) => e.hash !== existing.hash);
        }
      }
      const record = {
        path: target,
        hash: snapshot.hash,
        raw: snapshot.raw ?? snapshot.content,
        eol: snapshot.eol,
        bom: snapshot.bom,
        reason,
        time: Date.now(),
      };
      if (contentOf(record) !== snapshot.content) record.content = snapshot.content;
      const dest = this.file(target, record.hash);
      await writeJSON(dest, record);
      const bytes = (await fs.stat(dest)).size;
      doc.entries.push(this.metadata(record, bytes, ++db.sequence));
      await this.prune(db);
      return this.budget(db);
    });
  }
  async list(target) {
    return withLock(this.dataDir, 'history-catalog', async () => {
      const db = await this.loadCatalog();
      if (await this.inspectOrphans(db, target)) await this.prune(db);
      return (db.documents[digest(target)]?.entries || [])
        .slice()
        .sort(newest)
        .map(({ sequence, ...entry }) => entry);
    });
  }
  async entry(target, hash) {
    const file = this.file(target, hash);
    let record;
    try {
      record = await readJSON(file);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      throw Object.assign(Error('这个历史快照已损坏，原文件已保留：' + file), {
        code: 'STATE_RECOVERY_REQUIRED',
        details: { path: file },
      });
    }
    if (!record) return null;
    if (!validRecord(record) || record.path !== target || record.hash !== hash)
      throw Object.assign(Error('历史快照内容无效，原文件已保留：' + file), {
        code: 'STATE_RECOVERY_REQUIRED',
        details: { path: file },
      });
    const { raw, ...visible } = record;
    return { ...visible, content: contentOf(record) };
  }
}
module.exports = { HistoryStore, DEFAULT_HISTORY_BYTES };
