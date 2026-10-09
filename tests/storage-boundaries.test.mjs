import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FileStore, hash } = require('../core/file-store.cjs');
const { KnowledgeStore } = require('../core/knowledge.cjs');
const { encodeText } = require('../core/encoding.cjs');
const { readRecoverableJSON, writeRecoverableJSON } = require('../core/state.cjs');
const text = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i + '\n').join('');
async function fixture(t, options) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-storage-'))),
    root = path.join(directory, 'project'),
    state = path.join(directory, 'state');
  await fs.mkdir(root);
  const store = new FileStore(state, options);
  await store.setRoot(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root, state, store, file: path.join(root, 'note.md') };
}

test('4k and 8k complete rewrites keep uniform EOL and BOM without quadratic work', () => {
  for (const n of [4000, 8000])
    for (const eol of ['LF', 'CRLF']) {
      const before = text('before-', n),
        after = text('after-', n),
        raw = '\uFEFF' + (eol === 'CRLF' ? before.replace(/\n/g, '\r\n') : before),
        start = performance.now();
      assert.equal(
        encodeText(after, { raw, eol, bom: true }),
        '\uFEFF' + (eol === 'CRLF' ? after.replace(/\n/g, '\r\n') : after),
      );
      assert(performance.now() - start < 500, 'Uniform EOL rewrite should remain linear.');
    }
  assert.equal(encodeText('new', { raw: '\uFEFFold', bom: false }), 'new');
  assert.equal(encodeText('new\n', { raw: '', eol: 'CRLF', bom: true }), '\uFEFFnew\r\n');
  assert.equal(encodeText('a\nb\n', { raw: 'a\r\nb\n', eol: 'CRLF' }), 'a\r\nb\n');
});

test('mixed EOL budget exhaustion stops save without changing disk or losing a draft', async (t) => {
  const { store, file, root } = await fixture(t);
  const original = Array.from(
    { length: 8000 },
    (_, i) => 'before-' + i + (i % 2 ? '\n' : '\r\n'),
  ).join('');
  await fs.writeFile(file, original);
  const previous = await store.read(file),
    content = text('after-', 8000);
  await store.writeDraft(file, { content, restorePending: true });
  const start = performance.now();
  await assert.rejects(store.save({ path: file, content, expectedHash: previous.hash }), {
    code: 'ENCODING_BUDGET',
  });
  assert(performance.now() - start < 1000);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal((await store.readDraft(file)).content, content);
  assert.equal((await store.readDraft(file)).restorePending, true);
  assert.deepEqual(await fs.readdir(root), ['note.md']);
});

test('8k line attribution preserves identity and explicitly omits over-budget statistics', async (t) => {
  const { store, file } = await fixture(t);
  const knowledge = new KnowledgeStore(store);
  await fs.writeFile(file, text('old-', 8000));
  const previous = await store.read(file),
    before = await knowledge.observe(previous);
  await fs.writeFile(file, text('new-', 8000));
  const next = await store.read(file),
    start = performance.now(),
    after = await knowledge.observe(next);
  assert(performance.now() - start < 1000);
  assert.equal(after.id, before.id);
  assert.equal(after.revision, next.hash);
  assert.equal(after.events.at(-1).changes, null);
  assert.equal(after.events.at(-1).changesUnavailable, 'diff-budget');
});

test('reading a known document and listing history never load old snapshot bodies', async (t) => {
  const { store, file } = await fixture(t);
  await fs.writeFile(file, 'present\n');
  for (let i = 0; i < 20; i++) await store.checkpoint(file, 'past ' + i + '\n');
  await store.read(file);
  const originalRead = fs.readFile,
    bodies = [],
    filePath = file;
  fs.readFile = async function (file, ...args) {
    if (String(file).startsWith(store.historyDir(filePath) + path.sep)) bodies.push(String(file));
    return originalRead.call(this, file, ...args);
  };
  try {
    await store.read(file);
    const metadata = await store.historyMetadata(file);
    assert.equal(metadata.length, 21);
    assert(
      metadata.every((m) => !('content' in m) && !('raw' in m) && Number.isFinite(m.contentLength)),
    );
    assert.deepEqual(bodies, []);
    const entry = await store.historyEntry(file, metadata[0].hash);
    assert.equal(entry.content, 'present\n');
    assert.equal(bodies.length, 1);
  } finally {
    fs.readFile = originalRead;
  }
});

test('history byte quota prunes oldest bodies while retaining latest recovery, source and drafts', async (t) => {
  const { store, file, root, state } = await fixture(t, { historyMaxBytes: 1500 });
  const other = path.join(root, 'other.md');
  await fs.writeFile(file, 'source');
  await fs.writeFile(other, 'other source');
  await store.writeDraft(file, { content: 'unsaved human text', restorePending: true });
  await store.checkpoint(file, 'human checkpoint ' + 'x'.repeat(200), 'human-before-review');
  for (let i = 0; i < 10; i++)
    for (const target of [file, other])
      await store.remember(
        {
          path: target,
          hash: hash(target + i),
          content: 'revision ' + i + 'y'.repeat(200),
          raw: 'revision ' + i + 'y'.repeat(200),
          eol: 'LF',
          bom: false,
        },
        'read',
      );
  const a = await store.history(file),
    b = await store.history(other);
  assert(a.some((e) => e.content.startsWith('human checkpoint')));
  assert(a.some((e) => e.content.startsWith('revision 9')));
  assert(b.some((e) => e.content.startsWith('revision 9')));
  assert(a.length + b.length < 21);
  assert.equal((await store.readDraft(file)).content, 'unsaved human text');
  assert.equal(await fs.readFile(file, 'utf8'), 'source');
  const catalog = JSON.parse(
    await fs.readFile(path.join(state, 'history', 'catalog.json'), 'utf8'),
  );
  let bytes = 0;
  for (const doc of Object.values(catalog.documents))
    for (const entry of doc.entries)
      bytes += (await fs.stat(path.join(store.historyDir(doc.path), entry.hash + '.json'))).size;
  assert.equal(bytes, catalog.totalBytes);
  assert(bytes <= 1500 || catalog.overBudget);
});

test('history migrates old full-body records once and rebuilds a damaged metadata catalog', async (t) => {
  const { store, file, state } = await fixture(t);
  await fs.writeFile(file, 'source');
  const dir = store.historyDir(file);
  await fs.mkdir(dir, { recursive: true });
  const content = 'old\n',
    revision = hash(content);
  await fs.writeFile(
    path.join(dir, revision + '.json'),
    JSON.stringify({
      path: file,
      hash: revision,
      raw: content,
      content,
      eol: 'LF',
      bom: false,
      time: 1,
      reason: 'read',
    }),
  );
  assert.equal((await store.historyMetadata(file))[0].contentLength, 4);
  assert.equal((await store.historyEntry(file, revision)).content, content);
  await fs.writeFile(path.join(state, 'history', 'catalog.json'), '{');
  assert.equal((await store.historyMetadata(file)).length, 1);
  assert(
    (await fs.readdir(path.join(state, 'history'))).some((n) =>
      n.startsWith('catalog.json.damaged-'),
    ),
  );
  await fs.writeFile(path.join(dir, revision + '.json'), '{');
  await assert.rejects(store.historyEntry(file, revision), { code: 'STATE_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(path.join(dir, revision + '.json'), 'utf8'), '{');
});

test('protected snapshots exceeding the quota return a visible soft-limit status', async (t) => {
  const { store, file } = await fixture(t, { historyMaxBytes: 1 });
  await fs.writeFile(file, 'must retain');
  const result = await store.read(file);
  assert.equal(result.historyBudget.overBudget, true);
  assert.equal(result.historyBudget.maxBytes, 1);
  assert(result.historyBudget.totalBytes > 1);
  assert.equal((await store.historyEntry(file, result.hash)).content, 'must retain');
});

test('per-document history limit and reopening an older version keep recovery copies', async (t) => {
  const { store, file } = await fixture(t);
  await fs.writeFile(file, 'first');
  const first = await store.read(file);
  for (let i = 0; i < 85; i++) await store.checkpoint(file, 'checkpoint ' + i);
  assert.equal((await store.historyMetadata(file)).length, 80);
  await store.read(file);
  await store.checkpoint(file, 'last checkpoint');
  assert.equal((await store.historyMetadata(file)).length, 80);
  assert.equal((await store.historyEntry(file, first.hash)).content, 'first');
});

test('checkpointing an existing read version promotes it to a protected human recovery copy', async (t) => {
  const { store, file, state } = await fixture(t, { historyMaxBytes: 800 });
  await fs.writeFile(file, 'original ' + 'x'.repeat(100));
  const original = await store.read(file);
  await store.checkpoint(file, original.content, 'human-before-review');
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(file, 'later ' + i + 'y'.repeat(100));
    await store.read(file);
  }
  await fs.unlink(path.join(state, 'history', 'catalog.json'));
  const meta = await store.historyMetadata(file);
  assert(meta.some((e) => e.hash === original.hash && e.reason === 'human-before-review'));
  assert.equal((await store.historyEntry(file, original.hash)).content, original.content);
  assert.equal((await store.historyEntry(file, original.hash)).reason, 'human-before-review');
});

test('post-write history failure returns saved source with warning; pre-write failure still stops', async (t) => {
  const { store, file } = await fixture(t);
  await fs.writeFile(file, 'before');
  const previous = await store.read(file),
    remember = store.remember.bind(store);
  store.remember = async (snapshot, reason) => {
    if (reason === 'read') throw Error('injected history failure');
    return remember(snapshot, reason);
  };
  const result = await store.save({ path: file, content: 'after', expectedHash: previous.hash });
  assert.equal(result.ok, true);
  assert.equal(result.file.content, 'after');
  assert.equal(result.warnings[0].code, 'HISTORY_UNAVAILABLE');
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
  store.remember = async () => {
    throw Error('injected before-save failure');
  };
  await assert.rejects(
    store.save({ path: file, content: 'must not write', expectedHash: result.file.hash }),
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('knowledge recovery keeps document identities and publication journals; no backup never resets them', async (t) => {
  const { store, file } = await fixture(t);
  await fs.writeFile(file, 'source');
  const knowledge = new KnowledgeStore(store),
    initial = await knowledge.provenance(file);
  await knowledge.mutate((db) => {
    db.publications.pending = { id: 'publication-id', documentId: initial.id, state: 'uncertain' };
  });
  await fs.writeFile(knowledge.file(), '{"documents":');
  const recovered = await knowledge.state();
  assert.equal(recovered.documents[file].id, initial.id);
  assert.equal(recovered.publications.pending.state, 'uncertain');
  assert((await fs.readdir(path.dirname(knowledge.file()))).some((n) => n.includes('.damaged-')));
  await fs.writeFile(knowledge.file(), '{}');
  await fs.unlink(knowledge.file() + '.backup');
  await assert.rejects(knowledge.state(), { code: 'STATE_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(knowledge.file(), 'utf8'), '{}');
});

test('recoverable state rejects damaged backups instead of treating a missing primary as fresh', async (t) => {
  const { state } = await fixture(t);
  await fs.mkdir(state);
  const file = path.join(state, 'identity.json');
  await fs.writeFile(file + '.backup', '{');
  await assert.rejects(readRecoverableJSON(file, { fallback: { ids: [] } }), {
    code: 'STATE_RECOVERY_REQUIRED',
  });
  await writeRecoverableJSON(file, { ids: ['preserved'] });
  await fs.unlink(file);
  assert.deepEqual(await readRecoverableJSON(file), { ids: ['preserved'] });
});

test('draft recovery preserves restorePending and clearing a draft also clears its backup', async (t) => {
  const { store, file, state } = await fixture(t);
  await fs.writeFile(file, 'source');
  await store.writeDraft(file, { content: 'human', restorePending: true });
  const draft = path.join(state, 'drafts', hash(file) + '.json');
  await fs.writeFile(draft, '{');
  assert.equal((await store.readDraft(file)).restorePending, true);
  assert.equal((await store.readDraft(file)).content, 'human');
  await store.writeDraft(file, null);
  assert.equal(await store.readDraft(file), null);
  await assert.rejects(fs.stat(draft + '.backup'), { code: 'ENOENT' });
});

test('opening a project does not make its credentials and config readable', async (t) => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=secret');
  await fs.writeFile(path.join(root, 'id_rsa'), 'PRIVATE KEY');
  await fs.writeFile(path.join(root, 'config.yaml'), 'token: secret');
  await fs.writeFile(path.join(root, 'note.md'), '# Document');
  // A project root is usually a whole repository. Reads stay on the file types
  // Folio actually edits, matching the rule save has always enforced.
  for (const name of ['.env', 'id_rsa', 'config.yaml'])
    await assert.rejects(store.read(path.join(root, name)), /Markdown/);
  assert.equal((await store.read(path.join(root, 'note.md'))).content, '# Document');
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'API_KEY=secret');
});
