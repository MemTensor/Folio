import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EditorState, Transaction, Compartment } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { documentChanges } from '../src/editor-changes.mjs';
import { acknowledgeSave, receiveExternal } from '../src/document-state.mjs';
const require = createRequire(import.meta.url);
const { FileStore } = require('../core/file-store.cjs');
const { KnowledgeStore } = require('../core/knowledge.cjs');
const { withLock, digest } = require('../core/state.cjs');
const { Workspaces } = require('../core/workspaces.cjs');
const { DocumentCatalog } = require('../core/document-catalog.cjs');
const { allowedLibraryRoot } = require('../core/library-root.cjs');
const { embedClipboardAssets } = require('../core/clipboard-assets.cjs');
const { MemosCloud } = require('../core/memos-cloud.cjs');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp('/private/tmp/folio-regressions-'));
  const root = path.join(dir, 'project'),
    state = path.join(dir, 'state');
  await fs.mkdir(root);
  const store = new FileStore(state);
  await store.setRoot(root);
  t.after(async () => {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, root, state, store, file: root + '/note.md' };
}
test('stale lock recovery remains exclusive across competing processes', async (t) => {
  const { dir, state } = await fixture(t);
  const key = 'generated-lock';
  const lock = path.join(state, 'locks', digest(key) + '.lock');
  await fs.mkdir(lock, { recursive: true });
  assert.throws(() => process.kill(2147483647, 0), { code: 'ESRCH' });
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  const modulePath = fileURLToPath(new URL('../core/state.cjs', import.meta.url));
  const code = `const {withLock}=require(process.argv[1]); const fs=require('node:fs/promises');
    (async()=>{for(let n=0;n<4;n++)await withLock(process.argv[2],process.argv[3],async()=>{
      const h=await fs.open(process.argv[4],'wx');await new Promise(r=>setTimeout(r,8));await h.close();await fs.unlink(process.argv[4]);
    });})().catch(e=>{console.error(e);process.exitCode=1});`;
  await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['-e', code, modulePath, state, key, dir + '/critical'],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let error = '';
          child.stderr.on('data', (d) => (error += d));
          child.on('error', reject);
          child.on('exit', (code) => (code === 0 ? resolve() : reject(Error(error))));
        }),
    ),
  );
});
test('an abruptly exited lease owner cannot block subsequent operations', async (t) => {
  const { state } = await fixture(t);
  const modulePath = fileURLToPath(new URL('../core/state.cjs', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require(process.argv[1]).withLock(process.argv[2],'crash',async()=>{process.stdout.write('held');await new Promise(()=>{});}); setInterval(()=>{},1000);`,
      modulePath,
      state,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(await withLock(state, 'crash', async () => 'recovered'), 'recovered');
});
test('close waits for writes admitted before async path checks and rejects later writes', async (t) => {
  const { store, file } = await fixture(t);
  const wait = deferred(),
    entered = deferred(),
    safe = store.safe.bind(store);
  store.safe = async (...args) => {
    entered.resolve();
    await wait.promise;
    return safe(...args);
  };
  const saving = store.save({ path: file, content: 'durable', expectedHash: null });
  const drafting = store.writeDraft(file, { content: 'draft' });
  await entered.promise;
  let closed = false;
  const closing = store.close().then(() => (closed = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, false);
  await assert.rejects(store.save({ path: file, content: 'late', expectedHash: null }), {
    code: 'CLOSING',
  });
  wait.resolve();
  await Promise.all([saving, drafting, closing]);
  assert.equal(await fs.readFile(file, 'utf8'), 'durable');
  assert.equal((await store.readDraft(file)).content, 'draft');
});
test('CRLF input is normalized once and new mixed-EOL lines follow the majority', async (t) => {
  const { store, file } = await fixture(t);
  await fs.writeFile(file, 'before\r\n');
  const before = await store.read(file);
  await store.save({ path: file, content: 'after\r\n', expectedHash: before.hash });
  assert.equal(await fs.readFile(file, 'utf8'), 'after\r\n');
  await fs.writeFile(file, 'a\nb\nc\r\n');
  const mixed = await store.read(file);
  await store.save({ path: file, content: mixed.content + 'new\r\n', expectedHash: mixed.hash });
  assert.equal(await fs.readFile(file, 'utf8'), 'a\nb\nc\r\nnew\n');
});
test('save acknowledgement clears only its own watcher echo and preserves later edits/conflicts', () => {
  const file = { path: '/generated/n.md', content: 'old', hash: 'old' };
  const current = { file, content: 'newer typing', revision: 2, saving: true };
  const saved = { ...file, content: 'written', hash: 'written' };
  const pending = receiveExternal(
    current,
    { path: file.path, file: saved },
    { reviewExternal: true },
  ).doc;
  const result = acknowledgeSave(pending, saved, 1);
  assert.equal(result.content, 'newer typing');
  assert.equal(result.pending, undefined);
  const external = { ...saved, content: 'external', hash: 'external' };
  assert.equal(acknowledgeSave({ ...pending, pending: external }, saved, 1).pending, external);
  assert.equal(acknowledgeSave({ ...current, pending: null }, saved, 1).pending, null);
  assert.equal(
    acknowledgeSave({ ...current, content: '', pending: null }, { ...saved, content: '' }, 2, true)
      .pending,
    undefined,
  );
});
test('external text additions preserve the location of earlier undo operations', () => {
  let state = EditorState.create({ doc: 'hello world', extensions: [history()] });
  state = state.update({ changes: { from: 6, to: 11, insert: 'reader' } }).state;
  const external = documentChanges(state.doc.toString(), 'hello reader\nexternal');
  assert.equal(external.resetHistory, false);
  state = state.update({
    changes: external.changes,
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  }).state;
  assert(
    undo({
      get state() {
        return state;
      },
      dispatch: (tr) => (state = tr.state),
    }),
  );
  assert.equal(state.doc.toString(), 'hello world\nexternal');
});
test('whole external replacements establish a new undo boundary', () => {
  const compartment = new Compartment();
  let state = EditorState.create({ doc: 'old', extensions: [compartment.of(history())] });
  state = state.update({ changes: { from: 3, insert: ' edit' } }).state;
  const external = documentChanges(state.doc.toString(), 'NEW');
  assert(external.resetHistory);
  state = state.update({
    changes: external.changes,
    effects: compartment.reconfigure([]),
    annotations: Transaction.addToHistory.of(false),
  }).state;
  state = state.update({ effects: compartment.reconfigure(history()) }).state;
  assert.equal(
    undo({
      get state() {
        return state;
      },
      dispatch: (tr) => (state = tr.state),
    }),
    false,
  );
  assert.equal(state.doc.toString(), 'NEW');
});
test('knowledge stores metadata only, skips unchanged writes and preserves observed changes on attribution', async (t) => {
  const { store, file } = await fixture(t);
  const knowledge = new KnowledgeStore(store);
  await fs.writeFile(file, 'alpha\nbeta\n');
  const previous = await store.read(file);
  await knowledge.observe(previous);
  const ino = (await fs.stat(knowledge.file())).ino;
  await knowledge.observe(previous);
  assert.equal((await fs.stat(knowledge.file())).ino, ino);
  const result = await store.save({
    path: file,
    content: 'alpha\ngamma\n',
    expectedHash: previous.hash,
  });
  await knowledge.observe(result.file);
  await knowledge.recordWrite(previous, result, { actor: 'fixture', origin: 'model' });
  const state = await knowledge.state(),
    doc = state.documents[file];
  assert.deepEqual(doc.events.at(-1).changes, { addedLines: 1, removedLines: 1 });
  assert(!JSON.stringify(state).includes('lastContent'));
  assert(!JSON.stringify(state).includes('gamma'));
});
test('iCloud account roots are excluded but a concrete project is allowed', () => {
  const home = '/generated/home',
    base = home + '/Library/Mobile Documents';
  assert.equal(allowedLibraryRoot(base, home), false);
  assert.equal(allowedLibraryRoot(base + '/com~apple~CloudDocs', home), false);
  assert.equal(allowedLibraryRoot(base + '/com~apple~CloudDocs/Project', home), true);
});
test('incremental catalog entries remain visible when the metadata cache is full', async () => {
  const catalog = Object.create(DocumentCatalog.prototype),
    root = '/generated',
    target = root + '/new.md';
  Object.assign(catalog, {
    pathChanges: new Map([[root, { sequence: 1, paths: new Map([[target, 1]]) }]]),
    limits: { maxDocuments: 2 },
    request: async () => ({ removed: [], documents: [{ path: target, modifiedAt: 3 }] }),
  });
  const updated = await catalog.applyChanges({
    root,
    documents: [
      { path: root + '/a.md', modifiedAt: 1 },
      { path: root + '/b.md', modifiedAt: 2 },
    ],
    changeSequence: 0,
    updatedAt: 1,
  });
  assert(updated.documents.some((d) => d.path === target));
  assert.equal(updated.documents.length, 2);
  assert(updated.limited);
});
test('rich clipboard embeds only bounded images within the source document project', async (t) => {
  const { dir, root, file, state } = await fixture(t),
    spaces = new Workspaces(state);
  await fs.writeFile(file, 'generated');
  await fs.writeFile(root + '/pic.png', Buffer.from('generated image'));
  await spaces.admit(root);
  const other = dir + '/other';
  await fs.mkdir(other);
  await fs.writeFile(other + '/private.png', 'other fixture');
  await spaces.admit(other);
  const url = (image) =>
    `folio-asset://local/?path=${encodeURIComponent(image)}&document=${encodeURIComponent(file)}`;
  const source = { text: '![Plot](pic.png)', html: `<p><img src="${url(root + '/pic.png')}"></p>` };
  const copied = await embedClipboardAssets(source, file, spaces);
  assert(copied.html.includes('src="data:image/png;base64,'));
  assert(!copied.html.includes(root));
  assert.equal(copied.text, source.text);
  await assert.rejects(
    embedClipboardAssets(
      { ...source, html: `<img src="${url(other + '/private.png')}">` },
      file,
      spaces,
    ),
  );
  await fs.writeFile(root + '/large.png', Buffer.alloc(3 * 1024 * 1024 + 1));
  await assert.rejects(
    embedClipboardAssets(
      { ...source, html: `<img src="${url(root + '/large.png')}">` },
      file,
      spaces,
    ),
    { code: 'CLIPBOARD_INPUT' },
  );
  await spaces.close();
});
test('MemOS rejects old credentials on a new endpoint and never persists temporary overrides', async (t) => {
  const { state } = await fixture(t);
  const cloud = new MemosCloud(state, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { id: 'fixture' } }) }),
  });
  await cloud.configure({ apiKey: 'generated-key', baseURL: 'https://first.invalid/v1' });
  await assert.rejects(cloud.configure({ baseURL: 'https://second.invalid/v1' }), {
    code: 'CONFIG',
  });
  const before = await fs.readFile(cloud.configPath(), 'utf8');
  cloud.overrides = {
    baseURL: 'https://second.invalid/v1',
    userId: 'temporary',
    apiKey: 'new-generated-key',
  };
  await cloud.addCollection('Generated');
  assert.equal(await fs.readFile(cloud.configPath(), 'utf8'), before);
  cloud.overrides.apiKey = undefined;
  await assert.rejects(cloud.key(), { code: 'CONFIG' });
});
test('rename retains recoverable versions and an unsaved draft at the new path', async (t) => {
  const { store, file, root } = await fixture(t);
  await fs.writeFile(file, 'before');
  const before = await store.read(file);
  await store.save({ path: file, content: 'after', expectedHash: before.hash });
  await store.writeDraft(file, { content: 'unsaved draft', base: before });
  const renamed = await store.rename(file, root + '/renamed.md');
  assert.equal(renamed.content, 'after');
  const history = await store.history(renamed.path);
  assert(history.some((entry) => entry.content === 'before'));
  assert(history.some((entry) => entry.content === 'after'));
  const draft = await store.readDraft(renamed.path);
  assert.equal(draft.content, 'unsaved draft');
  assert.equal(draft.base.path, renamed.path);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
test('index schema migration removes folded bodies while retaining searchable documents', async (t) => {
  const { state, root, file } = await fixture(t);
  const { DatabaseSync } = require('node:sqlite');
  const { DocumentIndex } = require('../core/document-index.cjs');
  await fs.mkdir(state + '/document-index', { recursive: true });
  const database = state + '/document-index/library.sqlite';
  const old = new DatabaseSync(database);
  old.exec(
    `CREATE TABLE documents(path TEXT PRIMARY KEY,root TEXT NOT NULL,name TEXT NOT NULL,relativePath TEXT NOT NULL,modifiedAt REAL NOT NULL,changedAt REAL NOT NULL,bytes INTEGER NOT NULL,inode TEXT NOT NULL,content TEXT NOT NULL,folded TEXT NOT NULL); CREATE VIRTUAL TABLE document_text USING fts5(text,tokenize='trigram',detail='none'); PRAGMA user_version=1;`,
  );
  await fs.writeFile(file, 'Generated index fixture needle');
  const stat = await fs.stat(file);
  old
    .prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      file,
      root,
      'note.md',
      'note.md',
      stat.mtimeMs,
      stat.ctimeMs,
      stat.size,
      String(stat.ino),
      'Generated index fixture needle',
      'generated index fixture needle',
    );
  old
    .prepare('INSERT INTO document_text(rowid,text) VALUES(1,?)')
    .run('generated index fixture needle');
  old.close();
  const index = new DocumentIndex(state);
  try {
    const result = await index.request({
      projects: [{ id: 'p', root }],
      opened: {},
      query: 'needle',
    });
    assert.equal(result.total, 1);
    assert.equal(result.index.filesRead, 0);
  } finally {
    await index.close();
  }
  const db = new DatabaseSync(database);
  try {
    assert.equal(db.prepare('SELECT folded FROM documents').get().folded, '');
  } finally {
    db.close();
  }
});
test('an expired indexing budget performs no further per-file filesystem probes', async (t) => {
  const { state, root } = await fixture(t);
  const vm = await import('node:vm'),
    sync = require('node:fs');
  const entry = fileURLToPath(new URL('../core/index-worker.cjs', import.meta.url)),
    local = createRequire(entry);
  let time = 0,
    stats = 0;
  const paths = Array.from({ length: 250 }, (_, i) => root + '/' + i + '.md');
  const overrides = {
    'node:fs': {
      ...sync,
      lstatSync: (...args) => {
        if (paths.includes(args[0])) {
          stats++;
          return { isFile: () => true, size: 1 };
        }
        return sync.lstatSync(...args);
      },
    },
    'node:worker_threads': { workerData: { dataDir: state }, parentPort: { on() {} } },
    './library-scan.cjs': {
      DEFAULT_SCAN_BUDGET: require('../core/library-scan.cjs').DEFAULT_SCAN_BUDGET,
      scanProject: () => {
        time = 4000;
        return { files: paths, complete: true };
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext((await fs.readFile(entry, 'utf8')) + '\nmodule.exports={snapshot};', {
    module,
    require: (name) => overrides[name] || local(name),
    performance: { now: () => time },
    TextDecoder,
    Buffer,
    console,
  });
  const result = module.exports.snapshot({ projects: [{ id: 'p', root }], opened: {} });
  assert.equal(stats, 0);
  assert.equal(result.index.filesRead, 0);
  assert.equal(result.index.limited, true);
});
test('build output expands only the version while keeping release tooling in agreement', () => {
  const { buildOutput } = require('../core/build-output.cjs');
  assert.equal(
    buildOutput('/generated/repo', {
      version: '0.5.0-beta.21',
      build: { directories: { output: 'release/v${version}' } },
    }),
    '/generated/repo/release/v0.5.0-beta.21',
  );
});
test('failed lock initialization removes its incomplete directory and releases ownership', async (t) => {
  const { state } = await fixture(t),
    write = fs.writeFile;
  fs.writeFile = async (file, ...args) => {
    if (String(file).includes('owner.json.'))
      throw Object.assign(Error('generated failure'), { code: 'EIO' });
    return write(file, ...args);
  };
  try {
    await assert.rejects(
      withLock(state, 'initialization', async () => assert.fail('must not enter')),
      { code: 'EIO' },
    );
  } finally {
    fs.writeFile = write;
  }
  assert(!(await fs.readdir(path.join(state, 'locks'))).some((name) => name.endsWith('.lock')));
  assert.equal(await withLock(state, 'initialization', async () => true), true);
});
test('legacy knowledge bodies are removed once without changing identities or events', async (t) => {
  const { store, file } = await fixture(t),
    knowledge = new KnowledgeStore(store);
  await fs.writeFile(file, 'generated original');
  const snapshot = await store.read(file);
  await knowledge.observe(snapshot);
  const old = await knowledge.state();
  old.schemaVersion = 1;
  old.documents[file].lastContent = snapshot.content;
  await fs.writeFile(knowledge.file(), JSON.stringify(old));
  const before = old.documents[file];
  await knowledge.observe(snapshot);
  const migrated = await knowledge.state();
  assert.equal(migrated.documents[file].id, before.id);
  assert.deepEqual(migrated.documents[file].events, before.events);
  assert.equal(migrated.schemaVersion, 2);
  assert(!JSON.stringify(migrated).includes('lastContent'));
  const ino = (await fs.stat(knowledge.file())).ino;
  await knowledge.observe(snapshot);
  assert.equal((await fs.stat(knowledge.file())).ino, ino);
});
test('the recreate action really writes an empty file and keeps deletion state on failure', async () => {
  const vm = await import('node:vm');
  const source = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('  async function save('),
    source.indexOf('  function schedule('),
  );
  const p = '/generated/empty.md';
  const make = () => ({
    file: { path: p, hash: 'deleted', content: '' },
    content: '',
    revision: 0,
    pending: null,
  });
  const docsRef = { current: { [p]: make() } },
    calls = [];
  const bridge = {
    save: async (args) => {
      calls.push(args);
      return { ok: true, file: { path: p, content: '', hash: 'created' } };
    },
  };
  const save = vm.runInNewContext(body + '\nsave', {
    docsRef,
    activeRef: { current: p },
    acknowledgeSave,
    bridge,
    changed: (d) => d.content !== d.file.content,
    updateDoc: (p, fn) => (docsRef.current[p] = fn(docsRef.current[p])),
    setPanel() {},
    notify() {},
    t: (s) => s,
    flushDraft: async () => {},
    setStatusText() {},
    time: () => '',
    schedule() {},
    nameOf: (x) => x,
    errorMessage: (e) => e.message,
    fail() {},
  });
  await save(p, true, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedHash, null);
  assert.equal(calls[0].content, '');
  assert.equal(docsRef.current[p].pending, undefined);
  docsRef.current[p] = make();
  bridge.save = async () => {
    throw Error('generated disk failure');
  };
  await save(p, true, true);
  assert.equal(docsRef.current[p].pending, null);
  assert.equal(docsRef.current[p].file.hash, 'deleted');
});
test('declared writes use their exact base even if the watcher missed an intermediate revision', async (t) => {
  const { store, file } = await fixture(t),
    knowledge = new KnowledgeStore(store);
  await fs.writeFile(file, 'alpha\n');
  const first = await store.read(file);
  await knowledge.observe(first);
  const middle = await store.save({
    path: file,
    content: 'beta\nextra\n',
    expectedHash: first.hash,
  });
  const last = await store.save({
    path: file,
    content: 'gamma\nextra\n',
    expectedHash: middle.file.hash,
  });
  await knowledge.observe(last.file);
  await knowledge.recordWrite(middle.file, last, { actor: 'generated', origin: 'model' });
  const event = (await knowledge.state()).documents[file].events.at(-1);
  assert.equal(event.baseRevision, middle.file.hash);
  assert.deepEqual(event.changes, { addedLines: 1, removedLines: 1 });
});
