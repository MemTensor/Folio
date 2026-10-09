import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILE_SORT_KEY,
  fileSortMode,
  loadFileSort,
  saveFileSort,
  sortFileTree,
} from '../src/sidebar-order.mjs';

const file = (name, mtime, parent = '/generated') => ({
  name,
  path: parent + '/' + name,
  kind: 'file',
  ...(mtime === undefined ? {} : { mtime }),
});
const paths = (nodes) => nodes.map((node) => node.path);

test('file names sort naturally in both directions while folders stay first at each level', () => {
  const nodes = [
    file('note10.md', 10),
    {
      name: 'notes',
      path: '/generated/notes',
      kind: 'folder',
      children: [
        file('part10.md', 10, '/generated/notes'),
        file('part2.md', 20, '/generated/notes'),
      ],
    },
    file('note2.md', 20),
  ];
  const before = structuredClone(nodes);
  const ascending = sortFileTree(nodes, 'name-asc'),
    descending = sortFileTree(nodes, 'name-desc');
  assert.deepEqual(paths(ascending), [
    '/generated/notes',
    '/generated/note2.md',
    '/generated/note10.md',
  ]);
  assert.deepEqual(paths(descending), [
    '/generated/notes',
    '/generated/note10.md',
    '/generated/note2.md',
  ]);
  assert.deepEqual(paths(ascending[0].children), [
    '/generated/notes/part2.md',
    '/generated/notes/part10.md',
  ]);
  assert.deepEqual(paths(descending[0].children), [
    '/generated/notes/part10.md',
    '/generated/notes/part2.md',
  ]);
  assert.deepEqual(nodes, before);
  assert.notEqual(ascending, nodes);
  assert.notEqual(ascending[0].children, nodes[1].children);
});

test('modification order uses file metadata, keeps unknown times last and resolves ties by name', () => {
  const nodes = [
    file('unknown.md'),
    file('tie2.md', 20),
    file('new.md', 30),
    file('old.md', 10),
    file('tie1.md', 20),
    file('invalid.md', NaN),
  ];
  assert.deepEqual(
    sortFileTree(nodes, 'modified-desc').map((node) => node.name),
    ['new.md', 'tie1.md', 'tie2.md', 'old.md', 'invalid.md', 'unknown.md'],
  );
  assert.deepEqual(
    sortFileTree(nodes, 'modified-asc').map((node) => node.name),
    ['old.md', 'tie1.md', 'tie2.md', 'new.md', 'invalid.md', 'unknown.md'],
  );
  const edited = nodes.map((node) => (node.name === 'old.md' ? { ...node, mtime: 40 } : node));
  assert.equal(sortFileTree(edited, 'modified-desc')[0].name, 'old.md');
});

test('time sorting is recursive and stable for directories and duplicate labels', () => {
  const nodes = [
    {
      name: 'z',
      path: '/generated/z',
      kind: 'folder',
      mtime: 10,
      children: [file('b.md', 30), file('a.md', 20)],
    },
    file('newest.md', 100),
    { name: 'a', path: '/generated/a', kind: 'folder', mtime: 20 },
  ];
  const result = sortFileTree(nodes, 'modified-desc');
  assert.deepEqual(paths(result), ['/generated/a', '/generated/z', '/generated/newest.md']);
  assert.deepEqual(
    result[1].children.map((node) => node.name),
    ['b.md', 'a.md'],
  );
  assert.deepEqual(
    paths(
      sortFileTree(
        [file('same.md', 10, '/generated/b'), file('same.md', 10, '/generated/a')],
        'modified-desc',
      ),
    ),
    ['/generated/a/same.md', '/generated/b/same.md'],
  );
});

test('sort preference survives reloading and unavailable or invalid storage falls back safely', () => {
  const data = new Map(),
    storage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    };
  assert.equal(loadFileSort(storage), 'name-asc');
  for (const mode of ['name-asc', 'name-desc', 'modified-desc', 'modified-asc']) {
    assert.equal(saveFileSort(storage, mode), true);
    assert.equal(loadFileSort(storage), mode);
    assert.equal(data.get(FILE_SORT_KEY), mode);
  }
  data.set(FILE_SORT_KEY, 'unrecognized');
  assert.equal(loadFileSort(storage), 'name-asc');
  assert.equal(fileSortMode(null), 'name-asc');
  assert.equal(
    loadFileSort({
      getItem: () => {
        throw Error('blocked');
      },
    }),
    'name-asc',
  );
  assert.equal(
    saveFileSort(
      {
        setItem: () => {
          throw Error('blocked');
        },
      },
      'name-desc',
    ),
    false,
  );
});
