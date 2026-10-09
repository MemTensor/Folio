import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { Workspaces } = require('../core/workspaces.cjs');
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-workspaces-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const roots = await Promise.all(
    ['a', 'b'].map(async (name) => {
      const p = path.join(temp, name);
      await fs.mkdir(p);
      await fs.writeFile(path.join(p, 'notes.md'), name);
      return fs.realpath(p);
    }),
  );
  const spaces = new Workspaces(path.join(temp, 'state'));
  await Promise.all(roots.map((root) => spaces.admit(root)));
  return { spaces, roots, temp };
}
test('switching projects cannot redirect a save or draft in a background tab', async (t) => {
  const { spaces, roots } = await fixture(t);
  spaces.activate(roots[0]);
  const a = await spaces.forPath(path.join(roots[0], 'notes.md')),
    before = await a.store.read('notes.md');
  const save = a.store.save({ path: before.path, content: 'edited A', expectedHash: before.hash });
  spaces.activate(roots[1]);
  await a.store.writeDraft(before.path, { content: 'unsaved A', base: before });
  assert((await save).ok);
  assert.equal((await a.store.read(before.path)).content, 'edited A');
  assert.equal((await a.store.readDraft(before.path)).content, 'unsaved A');
  assert.equal((await spaces.current().store.read('notes.md')).content, 'b');
  assert.equal(await spaces.current().store.readDraft('notes.md'), null);
  assert.equal(a.store.root, roots[0]);
});
test('same named documents retain separate history and project identity', async (t) => {
  const { spaces, roots } = await fixture(t);
  const files = roots.map((root) => path.join(root, 'notes.md'));
  for (const file of files) {
    const { store } = await spaces.forPath(file);
    await store.read(file);
  }
  const a = (await spaces.forPath(files[0])).store,
    b = (await spaces.forPath(files[1])).store;
  assert.equal((await a.history(files[0]))[0].content, 'a');
  assert.equal((await b.history(files[1]))[0].content, 'b');
  await fs.unlink(files[0]);
  assert.equal((await spaces.forPath(files[0], { missing: true })).store, a);
});
test('an open project does not authorize another project through a symlink', async (t) => {
  const { spaces, roots, temp } = await fixture(t);
  await fs.symlink(path.join(roots[1], 'notes.md'), path.join(roots[0], 'escape.md'));
  await assert.rejects(spaces.forPath(path.join(roots[0], 'escape.md')), /项目外部/);
  await assert.rejects(spaces.forPath(path.join(temp, 'unopened.md'), { missing: true }), /不属于/);
  assert.throws(() => spaces.activate(temp), /先打开/);
});
