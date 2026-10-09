import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_SORT_KEY,
  createProjectDocumentListing,
  emptyDocumentListing,
  loadDocumentSort,
  saveDocumentSort,
} from '../src/project-documents.mjs';
import { FILE_SORT_KEY } from '../src/sidebar-order.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const result = (name, extra = {}) => ({
  documents: [
    { name, path: '/project/docs/' + name, relativePath: 'docs/' + name, modifiedAt: 50, size: 12 },
  ],
  limited: false,
  scanned: 1,
  fromCache: false,
  updatedAt: 100,
  excluded: false,
  total: 1,
  hasMore: false,
  offset: 0,
  ...extra,
});

test('document view defaults to latest modification without changing folder ordering', () => {
  const data = new Map([[FILE_SORT_KEY, 'name-asc']]),
    storage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    };
  assert.equal(loadDocumentSort(storage), 'modified-desc');
  for (const mode of ['name-asc', 'name-desc', 'modified-desc', 'modified-asc']) {
    assert.equal(saveDocumentSort(storage, mode), true);
    assert.equal(loadDocumentSort(storage), mode);
    assert.equal(data.get(FILE_SORT_KEY), 'name-asc');
  }
  data.set(DOCUMENT_SORT_KEY, 'obsolete');
  assert.equal(loadDocumentSort(storage), 'modified-desc');
  assert.equal(
    loadDocumentSort({
      getItem() {
        throw Error('Storage unavailable');
      },
    }),
    'modified-desc',
  );
  assert.equal(
    saveDocumentSort(
      {
        setItem() {
          throw Error('Storage unavailable');
        },
      },
      'name-desc',
    ),
    false,
  );
});

test('idle document views make no requests; opening uses cache and preserves partial-result metadata', async () => {
  const reads = [],
    cancellations = [],
    states = [];
  const listing = createProjectDocumentListing(
    async (root, options) => {
      reads.push({ root, options });
      return result('Plan.md', { limited: true, excluded: true, scanned: 300 });
    },
    async (root) => cancellations.push(root),
    (state) => states.push(state),
  );
  await listing.refresh(false);
  assert.equal(reads.length, 0);
  await listing.open('/project', { query: 'Plan', sort: 'modified-desc', limit: 100 });
  assert.deepEqual(reads, [
    {
      root: '/project',
      options: { query: 'Plan', sort: 'modified-desc', limit: 100, offset: 0, refresh: false },
    },
  ]);
  assert.equal(states.at(-1).documents[0].relativePath, 'docs/Plan.md');
  assert.equal(states.at(-1).limited, true);
  assert.equal(states.at(-1).excluded, true);
  assert.equal(states.at(-1).scanned, 300);
  listing.close();
  await tick();
  assert.deepEqual(cancellations, ['/project']);
  assert.deepEqual(states.at(-1), emptyDocumentListing());
  await listing.refresh();
  assert.equal(reads.length, 1);
});

test('late project responses and errors cannot replace the newly opened project', async () => {
  for (const rejectOld of [false, true]) {
    const first = deferred(),
      reads = [],
      states = [];
    const listing = createProjectDocumentListing(
      async (root) => {
        reads.push(root);
        return root === '/old' ? first.promise : result('Current.md');
      },
      async () => {},
      (state) => states.push(state),
    );
    const old = listing.open('/old');
    await tick();
    await listing.open('/new');
    if (rejectOld) first.reject(Error('Obsolete project failed'));
    else first.resolve(result('Stale.md', { limited: true }));
    await old;
    assert.deepEqual(reads, ['/old', '/new']);
    assert.equal(states.at(-1).documents[0].name, 'Current.md');
    assert.equal(states.at(-1).error, '');
    assert.equal(states.at(-1).limited, false);
    assert.equal(states.at(-1).loading, false);
  }
});

test('replacement filename requests wait for previous cancellation to complete', async () => {
  const oldRead = deferred(),
    cancellation = deferred(),
    calls = [];
  const listing = createProjectDocumentListing(
    async (root, options) => {
      calls.push(options.query);
      return options.query === 'old' ? oldRead.promise : result('New.md');
    },
    () => cancellation.promise,
    () => {},
  );
  const old = listing.open('/project', { query: 'old' });
  await tick();
  const next = listing.open('/project', { query: 'new' });
  await tick();
  assert.deepEqual(calls, ['old']);
  cancellation.resolve();
  await next;
  assert.deepEqual(calls, ['old', 'new']);
  oldRead.resolve(result('Old.md'));
  await old;
});

test('watcher and focus bursts coalesce and remain cache-first', async () => {
  const first = deferred(),
    second = deferred(),
    reads = [],
    states = [];
  const listing = createProjectDocumentListing(
    async (root, options) => {
      reads.push(options);
      return reads.length === 1 ? first.promise : second.promise;
    },
    async () => {},
    (state) => states.push(state),
  );
  const opened = listing.open('/project', { includeArchives: false, sort: 'modified-desc' });
  await tick();
  for (let index = 0; index < 100; index++) await listing.refresh(false);
  assert.equal(reads.length, 1);
  first.resolve(result('Old.md'));
  await opened;
  await tick();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].refresh, false);
  second.resolve(result('New.md', { fromCache: true }));
  await tick();
  assert.equal(reads.length, 2);
  assert.equal(states.at(-1).documents[0].name, 'New.md');
  assert.equal(states.at(-1).fromCache, true);
});

test('explicit cancel ignores late results and stays stopped until an explicit retry', async () => {
  const first = deferred(),
    states = [],
    cancellations = [];
  let reads = 0;
  const listing = createProjectDocumentListing(
    async () => (++reads === 1 ? first.promise : result('Retry.md')),
    async (root) => cancellations.push(root),
    (state) => states.push(state),
  );
  const opened = listing.open('/project');
  await tick();
  listing.cancel();
  first.resolve(result('Cancelled.md'));
  await opened;
  assert.equal(states.at(-1).cancelled, true);
  assert.equal(states.at(-1).loading, false);
  assert.equal(states.at(-1).documents.length, 0);
  await listing.refresh(false);
  assert.equal(reads, 1);
  await listing.refresh();
  assert.equal(reads, 2);
  assert.equal(states.at(-1).cancelled, false);
  assert.equal(states.at(-1).documents[0].name, 'Retry.md');
  assert.deepEqual(cancellations, ['/project']);
});

test('refresh errors keep valid entries visible and manual retry forces a fresh scan', async () => {
  let fail = false;
  const reads = [],
    states = [];
  const listing = createProjectDocumentListing(
    async (root, options) => {
      reads.push(options);
      if (fail) throw Error('Permission denied');
      return result('Kept.md');
    },
    async () => {},
    (state) => states.push(state),
  );
  await listing.open('/project');
  fail = true;
  await listing.refresh(false);
  assert.equal(states.at(-1).documents[0].name, 'Kept.md');
  assert.equal(states.at(-1).error, 'Permission denied');
  assert.equal(states.at(-1).loading, false);
  fail = false;
  await listing.refresh();
  assert.equal(reads.at(-1).refresh, true);
  assert.equal(states.at(-1).error, '');
});

test('pagination appends unique paths, advances the raw cursor and resets only on explicit refresh', async () => {
  const states = [],
    reads = [];
  const listing = createProjectDocumentListing(
    async (root, options) => {
      reads.push(options);
      const names =
        options.offset === 0
          ? ['A.md', 'B.md']
          : options.offset === 2
            ? ['B.md', 'C.md']
            : ['D.md'];
      return result(names[0], {
        documents: names.map((name) => result(name).documents[0]),
        offset: options.offset,
        total: 5,
        hasMore: options.offset < 4,
      });
    },
    async () => {},
    (state) => states.push(state),
  );
  await listing.open('/project', { limit: 2, sort: 'modified-desc' });
  await listing.loadMore();
  assert.deepEqual(
    states.at(-1).documents.map((document) => document.name),
    ['A.md', 'B.md', 'C.md'],
  );
  assert.equal(states.at(-1).hasMore, true);
  await listing.refresh(false);
  assert.deepEqual(
    reads.map((options) => options.offset),
    [0, 2, 0, 2],
  );
  assert.equal(states.at(-1).documents.length, 3);
  await listing.loadMore();
  assert.equal(reads.at(-1).offset, 4);
  assert.equal(states.at(-1).hasMore, false);
  assert.deepEqual(
    states.at(-1).documents.map((document) => document.name),
    ['A.md', 'B.md', 'C.md', 'D.md'],
  );
  assert(reads.every((options) => options.refresh === false));
  await listing.refresh();
  assert.equal(reads.at(-1).offset, 0);
  assert.equal(reads.at(-1).refresh, true);
  assert.deepEqual(
    states.at(-1).documents.map((document) => document.name),
    ['A.md', 'B.md'],
  );
});

test('an obsolete next page cannot append to another project or retain its total', async () => {
  const page = deferred(),
    states = [],
    reads = [];
  const listing = createProjectDocumentListing(
    async (root, options) => {
      reads.push({ root, options });
      if (root === '/old' && options.offset > 0) return page.promise;
      return result(root === '/old' ? 'Old-first.md' : 'Current.md', {
        hasMore: root === '/old',
        total: root === '/old' ? 200 : 1,
      });
    },
    async () => {},
    (state) => states.push(state),
  );
  await listing.open('/old', { limit: 100 });
  const obsolete = listing.loadMore();
  await tick();
  assert.equal(states.at(-1).loadingMore, true);
  await listing.open('/current', { query: 'Current', sort: 'name-asc', limit: 100 });
  page.resolve(result('Old-page.md', { offset: 1, total: 200, hasMore: true }));
  await obsolete;
  assert.equal(reads.at(-1).options.offset, 0);
  assert.equal(states.at(-1).documents[0].name, 'Current.md');
  assert.equal(states.at(-1).total, 1);
  assert.equal(states.at(-1).hasMore, false);
  assert.equal(states.at(-1).loadingMore, false);
});
