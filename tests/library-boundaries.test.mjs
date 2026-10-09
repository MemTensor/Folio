import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DocumentLibrary, allowedLibraryRoot } = require('../core/library.cjs');
const { scanProject } = require('../core/library-scan.cjs');
async function setup(t) {
  const tmp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'folio-library-boundary-')),
  );
  const home = path.join(tmp, 'user'),
    root = path.join(home, 'project'),
    state = path.join(tmp, 'state');
  await fs.mkdir(root, { recursive: true });
  const recovery = [];
  const library = new DocumentLibrary(state, { home, onRecovery: (event) => recovery.push(event) });
  t.after(async () => {
    await library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return { tmp, home, root, state, library, recovery };
}
test('broad roots and home ancestors cannot enter the library', async (t) => {
  const { home, root, library } = await setup(t);
  assert(!allowedLibraryRoot('/', home));
  assert(!allowedLibraryRoot(home, home));
  assert(!allowedLibraryRoot(path.dirname(home), home));
  assert(allowedLibraryRoot(root, home));
  await assert.rejects(library.register(home), { code: 'USAGE' });
  assert.equal((await library.state()).projects.length, 0);
});
test('project scope skips other projects and retains stable nested ownership', async (t) => {
  const { root, library } = await setup(t),
    child = path.join(root, 'child');
  await fs.mkdir(child);
  const parent = await library.register(root),
    nested = await library.register(child);
  await fs.writeFile(path.join(root, 'a.md'), 'parent');
  await fs.writeFile(path.join(child, 'b.md'), 'child');
  const all = await library.snapshot();
  assert.equal(all.documents.find((d) => d.name === 'b.md').projectId, nested.id);
  const scoped = await library.snapshot({ projectId: parent.id });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.index.filesRead, 0);
  assert.equal(
    (await library.snapshot({ projectId: nested.id })).documents[0].projectId,
    nested.id,
  );
});
test('removing a project purges search data without touching its files or nested project', async (t) => {
  const { root, library } = await setup(t),
    child = path.join(root, 'child');
  await fs.mkdir(child);
  const parent = await library.register(root),
    nested = await library.register(child),
    a = path.join(root, 'a.md'),
    b = path.join(child, 'b.md');
  await fs.writeFile(a, 'parent original');
  await fs.writeFile(b, 'child original');
  await library.opened(b);
  await library.snapshot();
  await library.remove(parent.id);
  const after = await library.snapshot();
  assert.equal(after.total, 1);
  assert.equal(after.documents[0].projectId, nested.id);
  assert((await library.state()).opened[b]);
  assert.equal(await fs.readFile(a, 'utf8'), 'parent original');
  assert.equal(await fs.readFile(b, 'utf8'), 'child original');
});
test('cancel during asynchronous registry read cannot start a late worker', async (t) => {
  const { root, library } = await setup(t);
  await library.register(root);
  const read = library.state.bind(library);
  let resume, entered;
  const waiting = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (resume = r));
  library.state = async () => {
    const value = await read();
    entered();
    await gate;
    return value;
  };
  const result = library.snapshot().catch((e) => e);
  await waiting;
  await library.close();
  resume();
  assert.equal((await result).code, 'SEARCH_CANCELED');
  assert.equal(library.index.worker, null);
});
test('registry damage recovers registration, or preserves damage before resetting only rebuildable state', async (t) => {
  const { root, library, recovery } = await setup(t),
    project = await library.register(root);
  await fs.writeFile(library.file, '{"projects":');
  assert.equal((await library.state()).projects[0].id, project.id);
  assert.equal(recovery[0].source, 'backup');
  await fs.writeFile(library.file, '{');
  await fs.writeFile(library.file + '.backup', '{');
  assert.deepEqual((await library.state()).projects, []);
  assert.equal(recovery.at(-1).source, 'reset');
  assert((await fs.readdir(path.dirname(library.file))).some((name) => name.includes('damaged')));
});
test('scanner reports partial traversal when its entry or depth budget is reached', async (t) => {
  const { root } = await setup(t);
  await fs.writeFile(path.join(root, 'a.md'), 'a');
  await fs.mkdir(path.join(root, 'child'));
  await fs.writeFile(path.join(root, 'child', 'b.md'), 'b');
  const shallow = scanProject(root, {
    entries: 0,
    maxEntries: 100,
    maxDepth: 0,
    deadline: Infinity,
  });
  assert.equal(shallow.complete, false);
  assert(!shallow.files.some((p) => p.endsWith('b.md')));
  const bounded = scanProject(root, {
    entries: 0,
    maxEntries: 1,
    maxDepth: 10,
    deadline: Infinity,
  });
  assert.equal(bounded.complete, false);
  assert(bounded.files.length <= 1);
});
test('canceling a search cannot interrupt project removal', async (t) => {
  const { root, library } = await setup(t),
    project = await library.register(root);
  await fs.writeFile(path.join(root, 'a.md'), 'source');
  await library.snapshot();
  const request = library.index.request.bind(library.index);
  library.index.request = async (args) => {
    const result = request(args);
    if (args.operation === 'remove') await library.cancelSearch();
    return result;
  };
  assert.equal((await library.remove(project.id)).removed, true);
  assert.equal((await library.state()).projects.length, 0);
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'source');
});
