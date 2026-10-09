import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { WorkspaceSession } = createRequire(import.meta.url)('../core/workspace-session.cjs');
const root = '/generated/project';
function fixture() {
  const calls = [],
    documents = [],
    trees = [];
  const browser = {
    list: async () => ({ nodes: [], limited: false }),
    watch: async (...args) => {
      calls.push(['watch', ...args]);
    },
    unwatch: async (...args) => {
      calls.push(['unwatch', ...args]);
    },
    closeRoot: async () => {},
    close: async () => {},
  };
  const session = new WorkspaceSession(browser, {
    onTree: (root) => trees.push(root),
    onDocument: (file) => documents.push(file.path),
  });
  return { session, browser, calls, documents, trees };
}
test('only open document bodies are observed, including directory-wide events', async () => {
  const f = fixture();
  await f.session.list(root);
  await f.session.setDocuments([{ root, path: root + '/open.md' }]);
  f.session.changed({ root, directory: root, path: root + '/unopened.md' });
  assert.deepEqual(f.documents, []);
  f.session.changed({ root, directory: root, path: root + '/open.md' });
  assert.deepEqual(f.documents, [root + '/open.md']);
  f.session.changed({ root, directory: root });
  assert.equal(f.documents.length, 2);
  assert.equal(f.trees.length, 3);
});
test('collapsing a folder retains a document parent until its last tab closes', async () => {
  const f = fixture(),
    directory = root + '/notes';
  await f.session.list(root, directory);
  await f.session.setDocuments([{ root, path: directory + '/open.md' }]);
  f.calls.length = 0;
  await f.session.release(root, directory);
  assert.deepEqual(f.calls, []);
  await f.session.setDocuments([]);
  assert.deepEqual(f.calls, [['unwatch', root, directory]]);
});
test('a directory response that arrives after collapse cannot leak a watcher', async () => {
  const f = fixture();
  let done;
  f.browser.list = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  const pending = f.session.list(root, root + '/slow');
  await f.session.release(root, root + '/slow');
  done({ nodes: [], limited: false });
  await pending;
  assert.equal(f.session.visible.size, 0);
  assert.equal(f.calls.filter((c) => c[0] === 'unwatch').length, 2);
});

test('a replaced metadata worker restores parents of background open documents', async () => {
  const f = fixture();
  f.browser.generation = 1;
  f.session.generation = 1;
  await f.session.setDocuments([{ root, path: root + '/background/open.md' }]);
  f.calls.length = 0;
  f.browser.generation = 2;
  await f.session.list(root);
  await f.session.restoreIfNeeded();
  assert(f.calls.some((c) => c[0] === 'watch' && c[2] === root + '/background'));
});

test('document-list folder subscriptions are bounded and never read unopened bodies', async () => {
  const f = fixture();
  await f.session.setCatalogDirectories(
    root,
    Array.from({ length: 30 }, (_, i) => root + '/docs-' + i),
  );
  assert.equal(f.calls.filter((c) => c[0] === 'watch').length, 16);
  f.session.changed({ root, directory: root + '/docs-0', path: root + '/docs-0/new.md' });
  assert.deepEqual(f.trees, [root]);
  assert.deepEqual(f.documents, []);
  await f.session.setCatalogDirectories(root, []);
  assert.equal(f.calls.filter((c) => c[0] === 'unwatch').length, 16);
});
test('closing a document list retains its open-document parent subscription', async () => {
  const f = fixture(),
    directory = root + '/docs';
  await f.session.setDocuments([{ root, path: directory + '/open.md' }]);
  await f.session.setCatalogDirectories(root, [directory]);
  f.calls.length = 0;
  await f.session.setCatalogDirectories(root, []);
  assert.deepEqual(f.calls, []);
  await f.session.setDocuments([]);
  assert.deepEqual(f.calls, [['unwatch', root, directory]]);
});

test('interleaved catalog pages release superseded directories when the view closes', async () => {
  const f = fixture(),
    watched = new Set();
  let resume;
  f.browser.watch = async (_root, directory) => {
    watched.add(directory);
    if (directory === root + '/first-page' && !resume)
      await new Promise((resolve) => {
        resume = resolve;
      });
  };
  f.browser.unwatch = async (_root, directory) => watched.delete(directory);
  await f.session.setCatalogDirectories(root, [root + '/old-page']);
  const first = f.session.setCatalogDirectories(root, [root + '/first-page']);
  await new Promise((resolve) => setImmediate(resolve));
  const second = f.session.setCatalogDirectories(root, [
    root + '/first-page',
    root + '/second-page',
  ]);
  resume();
  await Promise.all([first, second]);
  assert.deepEqual([...watched].sort(), [root + '/first-page', root + '/second-page']);
  await f.session.setCatalogDirectories(root, []);
  assert.equal(watched.size, 0);
  assert.equal(f.session.catalogOwned.size, 0);
  assert.equal(f.session.catalogTasks.size, 0);
});

test('catalog cancellation during a pending watch preserves document and visible-folder references', async () => {
  const f = fixture(),
    watched = new Set(),
    documentParent = root + '/open-doc',
    visibleFolder = root + '/expanded',
    obsolete = root + '/old-page',
    pendingFolder = root + '/pending-page';
  let resume;
  f.browser.watch = async (_root, directory) => {
    watched.add(directory);
    if (directory === pendingFolder)
      await new Promise((resolve) => {
        resume = resolve;
      });
  };
  f.browser.list = async (_root, directory) => {
    watched.add(directory);
    return { nodes: [], limited: false };
  };
  f.browser.unwatch = async (_root, directory) => watched.delete(directory);
  await f.session.setDocuments([{ root, path: documentParent + '/open.md' }]);
  await f.session.list(root, visibleFolder);
  await f.session.setCatalogDirectories(root, [documentParent, visibleFolder, obsolete]);
  const pending = f.session.setCatalogDirectories(root, [pendingFolder]);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = f.session.setCatalogDirectories(root, []);
  resume();
  await Promise.all([pending, cancelled]);
  assert.deepEqual([...watched].sort(), [visibleFolder, documentParent].sort());
  assert.equal(f.session.catalogOwned.size, 0);
  await f.session.release(root, visibleFolder);
  await f.session.setDocuments([]);
  assert.equal(watched.size, 0);
});
