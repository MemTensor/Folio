const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MAX_BYTES } = require('./file-store.cjs');
const { scanProject, DEFAULT_SCAN_BUDGET } = require('./library-scan.cjs');
const { allowedLibraryRoot } = require('./library-root.cjs');
const collator = new Intl.Collator('zh-CN', { numeric: true });
let db, remove, removeText, upsert, setText, rowId;
function ensureIndex() {
  if (db) return;
  const directory = path.join(workerData.dataDir, 'document-index');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(directory, 'library.sqlite');
  const schema = `PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS documents (
  path TEXT PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, relativePath TEXT NOT NULL,
  modifiedAt REAL NOT NULL, changedAt REAL NOT NULL, bytes INTEGER NOT NULL, inode TEXT NOT NULL,
  content TEXT NOT NULL, folded TEXT NOT NULL DEFAULT '');
 CREATE INDEX IF NOT EXISTS documents_root ON documents(root);
 CREATE VIRTUAL TABLE IF NOT EXISTS document_text USING fts5(text, tokenize='trigram', detail='none');
 PRAGMA user_version=2;`;
  try {
    db = new DatabaseSync(databasePath);
    db.exec(schema);
    // Keep the legacy column so an older installed CLI / updater rollback can
    // still use this derived cache, but never retain its redundant body copy.
    db.exec("UPDATE documents SET folded='' WHERE folded<>''");
  } catch (error) {
    try {
      db?.close();
    } catch {}
    if (!/malformed|not a database/i.test(error.message)) throw error;
    // This is a derived cache. Preserve a damaged copy and rebuild from files.
    const suffix = '.damaged-' + Date.now();
    for (const extension of ['', '-wal', '-shm'])
      try {
        fs.renameSync(databasePath + extension, databasePath + suffix + extension);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    db = new DatabaseSync(databasePath);
    db.exec(schema);
  }
  fs.chmodSync(databasePath, 0o600);
  remove = db.prepare('DELETE FROM documents WHERE path=?');
  removeText = db.prepare('DELETE FROM document_text WHERE rowid=?');
  upsert =
    db.prepare(`INSERT INTO documents(path,root,name,relativePath,modifiedAt,changedAt,bytes,inode,content,folded) VALUES(?,?,?,?,?,?,?,?,?,'')
 ON CONFLICT(path) DO UPDATE SET root=excluded.root,name=excluded.name,relativePath=excluded.relativePath,modifiedAt=excluded.modifiedAt,changedAt=excluded.changedAt,bytes=excluded.bytes,inode=excluded.inode,content=excluded.content,folded=''`);
  setText = db.prepare('INSERT INTO document_text(rowid,text) VALUES(?,?)');
  rowId = db.prepare('SELECT rowid FROM documents WHERE path=?');
}
function signature(s) {
  return [s.mtimeMs, s.ctimeMs, s.size, String(s.ino)];
}
function same(a, s) {
  return (
    a &&
    a.modifiedAt === s.mtimeMs &&
    a.changedAt === s.ctimeMs &&
    a.bytes === s.size &&
    a.inode === String(s.ino)
  );
}
function readStable(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) throw Error('unsupported file');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_BYTES) throw Error('too large');
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      !current.isFile() ||
      signature(before).join() !== signature(after).join() ||
      signature(after).join() !== signature(current).join()
    )
      throw Error('file changed during indexing');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    if (content.includes('\0')) throw Error('binary file');
    return { content, stat: after };
  } finally {
    fs.closeSync(fd);
  }
}
function snapshot({ projects, opened, query = '', projectId, limit = 150, offset = 0 }) {
  ensureIndex();
  const start = performance.now(),
    unavailable = new Set(),
    incomplete = new Set(),
    validRoots = [],
    found = new Map(),
    stats = { filesRead: 0, unchanged: 0, skipped: 0, limited: false };
  const budget = {
    ...DEFAULT_SCAN_BUDGET,
    entries: 0,
    bytes: 0,
    deadline: start + DEFAULT_SCAN_BUDGET.maxMs,
  };
  const selected = projects.filter((p) => !projectId || p.id === projectId);
  // Resolve nested projects consistently, independent of recent-open ordering.
  for (const project of selected.slice().sort((a, b) => a.root.length - b.root.length)) {
    try {
      if (
        fs.realpathSync(project.root) !== project.root ||
        !fs.statSync(project.root).isDirectory()
      )
        throw Error();
      validRoots.push(project.root);
    } catch {
      unavailable.add(project.root);
      continue;
    }
    const excludedRoots = new Set(
      projects
        .filter((p) => p.root !== project.root && p.root.startsWith(project.root + path.sep))
        .map((p) => p.root),
    );
    const scanned = scanProject(project.root, budget, { excludedRoots });
    if (!scanned.complete) incomplete.add(project.root);
    if (scanned.unavailable) unavailable.add(project.root);
    for (const file of scanned.files) found.set(file, project.root);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = new Map(
      db
        .prepare('SELECT rowid,path,root,modifiedAt,changedAt,bytes,inode FROM documents')
        .all()
        .map((row) => [row.path, row]),
    );
    for (const [file, root] of found) {
      if (performance.now() >= budget.deadline) {
        for (const remainingRoot of found.values()) incomplete.add(remainingRoot);
        stats.limited = true;
        break;
      }
      const old = previous.get(file);
      try {
        const s = fs.lstatSync(file);
        if (!s.isFile()) throw Error('not a file');
        if (same(old, s) && old.root === root) {
          stats.unchanged++;
          continue;
        }
        if (performance.now() >= budget.deadline || budget.bytes + s.size > budget.maxBytes) {
          incomplete.add(root);
          stats.limited = true;
          continue;
        }
        const { content, stat } = readStable(file);
        budget.bytes += stat.size;
        stats.filesRead++;
        const name = path.basename(file),
          relative = path.relative(root, file);
        upsert.run(file, root, name, relative, ...signature(stat), content);
        const id = rowId.get(file).rowid;
        removeText.run(id);
        setText.run(id, (name + '\n' + relative + '\n' + content).toLowerCase());
      } catch {
        stats.skipped++;
        if (old) {
          removeText.run(old.rowid);
          remove.run(file);
        }
      }
    }
    const registered = new Set(projects.map((p) => p.root));
    for (const [file, old] of previous)
      if (
        !registered.has(old.root) ||
        (validRoots.includes(old.root) && !incomplete.has(old.root) && !found.has(file))
      ) {
        removeText.run(old.rowid);
        remove.run(file);
      }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  stats.limited = stats.limited || incomplete.size > 0;
  stats.entries = budget.entries;
  stats.bytesRead = budget.bytes;
  const partialProjects = projects.filter((p) => incomplete.has(p.root)).map((p) => p.id);
  const scope = selected.filter((p) => validRoots.includes(p.root));
  const term = String(query).trim().toLowerCase();
  if (!scope.length)
    return {
      projects,
      documents: [],
      total: 0,
      unavailable: projects.filter((p) => unavailable.has(p.root)).map((p) => p.id),
      partialProjects,
      query,
      index: { ...stats, durationMs: performance.now() - start },
    };
  const params = scope.map((p) => p.root),
    marks = params.map(() => '?').join(',');
  let condition = `d.root IN (${marks})`;
  // LIKE can use FTS5's trigram index for substrings of >=3 characters.
  // Short terms and literal wildcard characters use exact substring matching.
  if (term) {
    if ([...term].length >= 3 && !/[%_]/.test(term)) {
      condition += ' AND d.rowid IN (SELECT rowid FROM document_text WHERE text LIKE ?)';
      params.push('%' + term + '%');
    } else {
      condition += ' AND d.rowid IN (SELECT rowid FROM document_text WHERE instr(text,?)>0)';
      params.push(term);
    }
  }
  const total = db
    .prepare('SELECT count(*) AS n FROM documents d WHERE ' + condition)
    .get(...params).n;
  // Ordering is computed on metadata, without loading every document body.
  const metadata = db
    .prepare(
      'SELECT path,root,name,relativePath,modifiedAt,bytes FROM documents d WHERE ' + condition,
    )
    .all(...params);
  const byRoot = new Map(projects.map((p) => [p.root, p]));
  metadata.sort(
    (a, b) =>
      Math.max(b.modifiedAt, opened[b.path] || 0) - Math.max(a.modifiedAt, opened[a.path] || 0) ||
      a.path.localeCompare(b.path),
  );
  const documents = metadata.slice(offset, offset + limit).map((d) => {
    let match = null;
    if (term) {
      const content = db.prepare('SELECT content FROM documents WHERE path=?').get(d.path).content,
        lines = content.split('\n'),
        line = lines.findIndex((text) => text.toLowerCase().includes(term));
      if (line >= 0) {
        const at = Math.max(0, lines[line].toLowerCase().indexOf(term) - 80);
        match = { line: line + 1, text: (at ? '…' : '') + lines[line].slice(at, at + 300) };
      }
    }
    const project = byRoot.get(d.root);
    return {
      ...d,
      projectId: project.id,
      projectName: project.name,
      lastOpenedAt: opened[d.path] || null,
      match,
    };
  });
  return {
    projects,
    documents,
    total,
    offset,
    hasMore: offset + documents.length < total,
    unavailable: projects.filter((p) => unavailable.has(p.root)).map((p) => p.id),
    partialProjects,
    query,
    index: { ...stats, durationMs: performance.now() - start },
  };
}
function removeProject(root) {
  ensureIndex();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare('SELECT rowid,path FROM documents WHERE root=?').all(root)) {
      removeText.run(row.rowid);
      remove.run(row.path);
    }
    db.exec('COMMIT');
    return { removed: true };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function filenames({ root, query = '', limit = 100 }) {
  // Match the catalog's normalisation so both search surfaces agree on what a
  // name is: Finder writes NFD, keyboards and paste usually produce NFC.
  const term = String(query).normalize('NFKC').trim().toLocaleLowerCase();
  // Empty quick-open uses the main process's recent/root entries. Do not turn
  // merely showing the palette into a recursive project scan.
  if (!term) return { documents: [], limited: false };
  if (typeof root !== 'string' || !path.isAbsolute(root) || term.length > 4096)
    throw Error('文件名查找参数无效。');
  if (!allowedLibraryRoot(root, workerData.home, { dataDir: workerData.dataDir }))
    throw Error('项目文件夹暂不可用。');
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory())
    throw Error('项目文件夹暂不可用。');
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const budget = {
    maxEntries: 20000,
    maxDepth: 16,
    entries: 0,
    deadline: performance.now() + 700,
  };
  // scanProject only inspects directory entries. In particular, do not stat,
  // open, decode, or index each document: that could hydrate iCloud placeholders.
  const scanned = scanProject(root, budget),
    documents = [];
  let limited = !scanned.complete;
  // Filtering is in-memory string work over a list scanProject already bounded to
  // maxEntries, so it carries no deadline of its own. Sharing the traversal
  // deadline here made an exhausted scan report zero matches instead of the ones
  // it had already collected, which is how a slow volume turned quick-open into a
  // search that always found nothing.
  for (const file of scanned.files) {
    if (!path.relative(root, file).normalize('NFKC').toLocaleLowerCase().includes(term)) continue;
    if (documents.length === cap) {
      limited = true;
      break;
    }
    documents.push({ path: file, name: path.basename(file) });
  }
  documents.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));
  return { documents, limited };
}
parentPort.on('message', ({ id, ...args }) => {
  try {
    parentPort.postMessage({
      id,
      result:
        args.operation === 'filenames'
          ? filenames(args)
          : args.operation === 'remove'
            ? removeProject(args.root)
            : snapshot(args),
    });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
