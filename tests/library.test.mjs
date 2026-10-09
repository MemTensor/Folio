import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { DocumentLibrary } = require('../core/library.cjs');
test('library finds agent-created documents across projects without any memory service', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-library-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const a = path.join(tmp, 'project-a'),
    b = path.join(tmp, 'project-b');
  await fs.mkdir(a);
  await fs.mkdir(b);
  const library = new DocumentLibrary(path.join(tmp, 'state'));
  await library.register(a);
  await library.register(b);
  await fs.writeFile(path.join(a, 'alpha.md'), '# Alpha\nShared experiment');
  await fs.writeFile(path.join(b, 'beta.md'), '# Beta\nShared experiment');
  const all = await library.snapshot();
  assert.equal(all.total, 2);
  const search = await library.snapshot({ query: 'Shared' });
  assert.equal(search.documents.length, 2);
  assert.equal(new Set(search.documents.map((d) => d.projectId)).size, 2);
  const one = await library.snapshot({
    projectId: all.projects.find((p) => p.name === 'project-a').id,
  });
  assert.equal(one.total, 1);
});
test('library preserves a known project root and refuses unopened folders', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-library-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  const file = path.join(root, 'docs', 'note.md');
  await fs.writeFile(file, 'note');
  const library = new DocumentLibrary(path.join(tmp, 'state'));
  await library.register(root);
  assert.equal((await library.locate(file)).root, await fs.realpath(root));
  await fs.writeFile(path.join(tmp, 'outside.md'), 'outside');
  await assert.rejects(library.locate(path.join(tmp, 'outside.md')));
});
test('a long document cannot hide other body matches from the library', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-library-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.md'), 'needle\n'.repeat(250));
  await fs.writeFile(path.join(root, 'b.md'), 'prefix '.repeat(100) + 'needle');
  const library = new DocumentLibrary(path.join(tmp, 'state'));
  await library.register(root);
  const result = await library.snapshot({ query: 'needle' });
  assert.equal(result.total, 2);
  assert(result.documents.find((d) => d.name === 'b.md').match.text.includes('needle'));
});
test('persistent index reads only changed files and removes renamed or deleted hits', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-index-')),
    root = path.join(tmp, 'project'),
    state = path.join(tmp, 'state');
  await fs.mkdir(root);
  const library = new DocumentLibrary(state);
  t.after(async () => {
    await library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  await library.register(root);
  await fs.writeFile(path.join(root, 'a.md'), '旧的试验数据');
  await fs.writeFile(path.join(root, 'b.md'), '另一个文档');
  assert.equal((await library.snapshot()).index.filesRead, 2);
  assert.equal((await library.snapshot({ query: '试验' })).index.filesRead, 0);
  await fs.writeFile(path.join(root, 'a.md'), '新的实验结论');
  const edited = await library.snapshot({ query: '实验' });
  assert.equal(edited.total, 1);
  assert.equal(edited.index.filesRead, 1);
  assert.equal((await library.snapshot({ query: '试验' })).total, 0);
  await fs.rename(path.join(root, 'a.md'), path.join(root, 'renamed.md'));
  await fs.unlink(path.join(root, 'b.md'));
  const renamed = await library.snapshot();
  assert.equal(renamed.total, 1);
  assert.equal(renamed.documents[0].name, 'renamed.md');
  await library.close();
  const reopened = new DocumentLibrary(state);
  try {
    assert.equal((await reopened.snapshot()).index.filesRead, 0);
  } finally {
    await reopened.close();
  }
});
test('search treats punctuation literally and supports Chinese short terms and pagination', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-index-')),
    root = path.join(tmp, 'project');
  await fs.mkdir(root);
  const library = new DocumentLibrary(path.join(tmp, 'state'));
  t.after(async () => {
    await library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  await library.register(root);
  await fs.writeFile(path.join(root, 'a.md'), '公式 query 100% foo_bar ABCDEF');
  await fs.writeFile(path.join(root, 'b.md'), '公式 query 1000 fooXbar');
  await fs.writeFile(path.join(root, 'c.md'), '公式 query');
  assert.equal((await library.snapshot({ query: '100%' })).total, 1);
  assert.equal((await library.snapshot({ query: 'foo_bar' })).total, 1);
  assert.equal((await library.snapshot({ query: 'bcde' })).total, 1);
  assert.equal((await library.snapshot({ query: '公式' })).total, 3);
  assert.equal((await library.snapshot({ query: '" OR *' })).total, 0);
  const first = await library.snapshot({ query: '公式', limit: 2 }),
    second = await library.snapshot({ query: '公式', limit: 2, offset: 2 });
  assert(first.hasMore);
  assert(!second.hasMore);
  assert.equal(new Set([...first.documents, ...second.documents].map((d) => d.path)).size, 3);
});
test('replacing an indexed file with a symlink cannot retain stale or outside content', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-index-')),
    root = path.join(tmp, 'project');
  await fs.mkdir(root);
  const library = new DocumentLibrary(path.join(tmp, 'state'));
  t.after(async () => {
    await library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  await library.register(root);
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, 'inside');
  await library.snapshot();
  await fs.writeFile(path.join(tmp, 'outside.md'), 'private outside');
  await fs.unlink(file);
  await fs.symlink(path.join(tmp, 'outside.md'), file);
  assert.equal((await library.snapshot({ query: 'inside' })).total, 0);
  assert.equal((await library.snapshot({ query: 'outside' })).total, 0);
});
test('a damaged derived index rebuilds without changing source documents', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-index-')),
    root = path.join(tmp, 'project'),
    state = path.join(tmp, 'state');
  await fs.mkdir(root);
  const library = new DocumentLibrary(state);
  t.after(async () => {
    await library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  await library.register(root);
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, 'recoverable source');
  await fs.mkdir(path.join(state, 'document-index'));
  await fs.writeFile(path.join(state, 'document-index', 'library.sqlite'), 'damaged cache');
  assert.equal((await library.snapshot({ query: 'recoverable' })).total, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'recoverable source');
  assert(
    (await fs.readdir(path.join(state, 'document-index'))).some((name) =>
      name.includes('.damaged-'),
    ),
  );
});

test('actively opening a document also refreshes its owning project recency', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-recent-owner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const file = path.join(root, 'Note.md');
  await fs.writeFile(file, '# generated\n');
  const library = new DocumentLibrary(path.join(directory, 'state'));
  t.after(() => library.close());
  await library.register(root);
  await library.mutate((state) => {
    state.projects[0].lastOpenedAt = 1;
  });
  await library.opened(file);
  const state = await library.state();
  assert(state.projects[0].lastOpenedAt > 1);
  assert.equal(state.projects[0].lastOpenedAt, state.opened[await fs.realpath(file)]);
});
