import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectImageImports,
  imageReferences,
  appendImageReferences,
  readImageRecovery,
  writeImageRecovery,
} from '../src/image-import.mjs';
const files = () =>
  ['one.png', 'two.png', 'three.png'].map((name) => ({ name, type: 'image/png' }));
function storage() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
}

test('switching during a multi-image copy retains every completed reference and stops remaining copies', async () => {
  let current = true,
    calls = 0;
  const result = await collectImageImports(files(), {
    isCurrent: () => current,
    importFile: async (file) => {
      calls++;
      if (calls === 2) current = false;
      return 'assets/' + file.name;
    },
  });
  assert.equal(result.interrupted, true);
  assert.equal(calls, 2);
  assert.deepEqual(
    result.items.map((i) => i.relative),
    ['assets/one.png', 'assets/two.png'],
  );
});
test('a later copy failure does not discard successful imports', async () => {
  const result = await collectImageImports(files(), {
    isCurrent: () => true,
    importFile: async (file) => {
      if (file.name === 'two.png') throw Error('generated copy failure');
      return 'assets/' + file.name;
    },
  });
  assert.equal(result.failures.length, 1);
  assert.deepEqual(
    result.items.map((i) => i.relative),
    ['assets/one.png', 'assets/three.png'],
  );
  assert.equal(result.interrupted, false);
});
test('recovery survives restart and explicit append preserves newer human text without duplicate references', () => {
  const state = storage(),
    recovery = {
      path: '/generated/project/source.md',
      items: [{ name: 'one.png', relative: 'assets/one.png' }],
    };
  assert.equal(writeImageRecovery(state, recovery), true);
  const restored = readImageRecovery(state);
  assert.deepEqual(restored, recovery);
  const current = '# Human edits\n\nNew text added during import.';
  const next = appendImageReferences(current, restored.items);
  assert(next.startsWith(current));
  assert(next.includes('![one](assets/one.png)'));
  assert.equal(appendImageReferences(next, restored.items), next);
  writeImageRecovery(state, null);
  assert.equal(readImageRecovery(state), null);
});
test('image labels escape Markdown metacharacters and invalid stored paths are ignored', () => {
  assert.equal(
    imageReferences([{ name: '[a]\\b.png', relative: 'assets/a.png' }]),
    '![\\[a\\]\\\\b](assets/a.png)\n',
  );
  const state = storage();
  writeImageRecovery(state, {
    path: '/generated/source.md',
    items: [{ name: 'bad.png', relative: '../outside.png' }],
  });
  assert.equal(readImageRecovery(state), null);
});

test('image limits fail before copying and oversized individual files do not block valid files', async () => {
  let copies = 0;
  await assert.rejects(
    collectImageImports(
      Array.from({ length: 51 }, () => files()[0]),
      {
        isCurrent: () => true,
        importFile: async () => {
          copies++;
          return 'assets/no.png';
        },
      },
    ),
  );
  assert.equal(copies, 0);
  const result = await collectImageImports(
    [{ ...files()[0], size: 22 * 1024 * 1024 }, files()[1]],
    {
      isCurrent: () => true,
      importFile: async (file) => {
        copies++;
        return 'assets/' + file.name;
      },
    },
  );
  assert.equal(result.failures.length, 1);
  assert.equal(copies, 1);
  assert.equal(result.items[0].relative, 'assets/two.png');
});
test('blocked recovery storage reports failure and does not pretend references survived', () => {
  const blocked = {
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('blocked');
    },
    removeItem() {
      throw Error('blocked');
    },
  };
  assert.equal(readImageRecovery(blocked), null);
  assert.equal(
    writeImageRecovery(blocked, {
      path: '/generated/A.md',
      items: [{ name: 'one.png', relative: 'assets/one.png' }],
    }),
    false,
  );
});
