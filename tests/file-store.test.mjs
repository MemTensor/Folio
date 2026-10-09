import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FileStore } = require('../core/file-store.cjs');
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'workspace');
  await fs.mkdir(root);
  const store = new FileStore(path.join(dir, 'state'));
  await store.setRoot(root);
  return { dir, root, store, p: path.join(root, 'note.md') };
}
test('external edits cannot be silently overwritten by stale saves', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, 'base');
  const base = await store.read(p);
  await fs.writeFile(p, 'agent');
  const r = await store.save({ path: p, content: 'human', expectedHash: base.hash });
  assert.equal(r.ok, false);
  assert.equal(r.conflict.content, 'agent');
  assert.equal(await fs.readFile(p, 'utf8'), 'agent');
});
test('serialized concurrent saves allow exactly one writer', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, 'base');
  const b = await store.read(p);
  const r = await Promise.all(
    ['one', 'two'].map((content) => store.save({ path: p, content, expectedHash: b.hash })),
  );
  assert.equal(r.filter((x) => x.ok).length, 1);
  assert.equal(r.filter((x) => !x.ok).length, 1);
});
test('CRLF, BOM, file mode and content survive save', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, '\uFEFF# 标题\r\n\r\n原文\r\n', { mode: 0o640 });
  const b = await store.read(p);
  assert.equal(b.content, '# 标题\n\n原文\n');
  await store.save({ ...b, content: b.content + '新增\n', expectedHash: b.hash });
  assert.equal(await fs.readFile(p, 'utf8'), '\uFEFF# 标题\r\n\r\n原文\r\n新增\r\n');
  assert.equal((await fs.stat(p)).mode & 0o777, 0o640);
});
test('rejects traversal and symlink escapes', async (t) => {
  const { store, dir, root } = await setup(t);
  await fs.writeFile(path.join(dir, 'outside.md'), 'private');
  await fs.symlink(path.join(dir, 'outside.md'), path.join(root, 'link.md'));
  await assert.rejects(store.read('../outside.md'));
  await assert.rejects(store.read('link.md'));
  await assert.rejects(store.save({ path: '../new.md', content: 'x', expectedHash: null }));
});
test('deleted disk file causes a conflict; recovery snapshots remain', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, 'before');
  const b = await store.read(p);
  await fs.unlink(p);
  const r = await store.save({ path: p, content: 'after', expectedHash: b.hash });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, null);
  assert.equal((await store.history(p))[0].content, 'before');
});
test('new files use exclusive creation and failed saves leave no temporary files', async (t) => {
  const { store, p, root } = await setup(t);
  assert.equal((await store.save({ path: p, content: 'first', expectedHash: null })).ok, true);
  assert.equal((await store.save({ path: p, content: 'second', expectedHash: null })).ok, false);
  assert.deepEqual(await fs.readdir(root), ['note.md']);
});
test('history and recovery drafts are kept outside the Markdown workspace', async (t) => {
  const { store, p, root } = await setup(t);
  await fs.writeFile(p, 'one');
  const b = await store.read(p);
  await store.save({ path: p, content: 'two', expectedHash: b.hash });
  const history = await store.history(p);
  assert.deepEqual(new Set(history.map((x) => x.content)), new Set(['one', 'two']));
  await store.writeDraft(p, { content: 'unsaved', base: b });
  assert.equal((await store.readDraft(p)).content, 'unsaved');
  await store.writeDraft(p, null);
  assert.equal(await store.readDraft(p), null);
  assert.deepEqual(await fs.readdir(root), ['note.md']);
});
test('search finds Chinese content and nested documents, ignores generated directories', async (t) => {
  const { store, root } = await setup(t);
  await fs.mkdir(path.join(root, 'docs'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'docs', 'one.md'), '# 文档\n你好，协作');
  await fs.writeFile(path.join(root, 'node_modules', 'ignore.md'), '协作');
  const hits = await store.search('协作');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});
test('binary and invalid UTF-8 are refused instead of destructively decoded', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, Buffer.from([0xff, 0xfe]));
  await assert.rejects(store.read(p));
  await fs.writeFile(p, 'a\0b');
  await assert.rejects(store.read(p));
});
test('choosing a remote version can preserve the unsaved human version as a checkpoint', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, 'agent');
  await store.checkpoint(p, 'human unsaved');
  assert.equal((await store.history(p))[0].content, 'human unsaved');
  assert.equal(await fs.readFile(p, 'utf8'), 'agent');
});
test('rapid draft updates serialize in order', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, 'base');
  await Promise.all(['one', 'two', 'three'].map((content) => store.writeDraft(p, { content })));
  assert.equal((await store.readDraft(p)).content, 'three');
});
test('local edits preserve mixed line endings on all untouched lines', async (t) => {
  const { store, p } = await setup(t);
  await fs.writeFile(p, 'a\r\nb\nc\r\n');
  const b = await store.read(p);
  await store.save({ ...b, content: 'A\nb\nc\n', expectedHash: b.hash });
  assert.equal(await fs.readFile(p, 'utf8'), 'A\r\nb\nc\r\n');
});
