import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DocumentCatalog, DOCUMENT_CATALOG_LIMITS } = require('../core/document-catalog.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t, options = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-doc-catalog-')));
  const root = path.join(tmp, 'project'),
    dataDir = path.join(tmp, 'state');
  await fs.mkdir(root);
  const catalog = new DocumentCatalog(dataDir, options);
  t.after(async () => {
    await catalog.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  async function document(relative, time = 100, content = '# Body must not be read\n') {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    await fs.utimes(file, time, time);
    return file;
  }
  return { tmp, root, dataDir, catalog, document };
}
test('document catalog uses only metadata, excludes archival/dependency/skill clutter and sorts latest documents', async (t) => {
  const { root, catalog, document } = await setup(t, {
    workerFactory: (file, options) =>
      new Worker(
        `
      const fs = require('node:fs/promises');
      fs.readFile = fs.open = () => { throw Error('catalog must never open a document body'); };
      require(${JSON.stringify(require.resolve('../core/document-catalog-worker.cjs'))});
    `,
        { ...options, eval: true },
      ),
  });
  await document('README.md', 100);
  await document('docs/Current plan.md', 500);
  await document('src/design.txt', 300);
  await document('archive.md', 200);
  for (const folder of [
    '_backupAnything',
    'backup',
    'archive',
    '代码镜像',
    'output',
    'tmp',
    '冷存档',
  ])
    await document(folder + '/newest.md', 900);
  for (const folder of ['.git', 'git', 'node_modules', 'vendor', 'skills', 'docs/skills'])
    await document(folder + '/helper.md', 1000);
  const normal = await catalog.list(root);
  assert.deepEqual(
    normal.documents.map((doc) => doc.relativePath),
    ['docs/Current plan.md', 'src/design.txt', 'archive.md', 'README.md'],
  );
  assert.equal(normal.excluded, true);
  assert.equal(normal.fromCache, false);
  assert(normal.documents.every((doc) => Number.isFinite(doc.modifiedAt) && doc.size > 0));
  const archives = await catalog.list(root, { includeArchives: true });
  assert.equal(archives.documents.length, 11);
  assert(!archives.documents.some((doc) => /helper/.test(doc.name)));
  assert.deepEqual(
    (await catalog.list(path.join(root, 'node_modules'), { includeArchives: true })).documents,
    [],
  );
  assert.equal(
    (await catalog.list(root, { query: 'docs plan' })).documents[0].name,
    'Current plan.md',
  );
  assert.equal((await catalog.list(root, { sort: 'modified-asc' })).documents[0].name, 'README.md');
});

test('bounded scan reserves useful documentation ahead of ordinary source trees', async (t) => {
  const { root, catalog, document } = await setup(t, {
    limits: { maxDocuments: 3, maxDirectoryEntries: 8, maxEntries: 40 },
  });
  await document('README.md');
  await document('docs/one.md');
  await document('docs/two.md');
  for (let n = 0; n < 30; n++) await document(`src/code-${n}.md`, 900);
  const result = await catalog.list(root);
  assert.deepEqual(result.documents.map((doc) => doc.relativePath).sort(), [
    'README.md',
    'docs/one.md',
    'docs/two.md',
  ]);
  assert.equal(result.limited, true);
  assert(result.scanned <= 40);
  assert.equal(DOCUMENT_CATALOG_LIMITS.maxMs, 700);
  assert.equal(DOCUMENT_CATALOG_LIMITS.maxEntries, 10000);
  assert.equal(DOCUMENT_CATALOG_LIMITS.maxDocuments, 2000);
});

test('catalog pagination filters before stable sorting and reuses the complete metadata cache', async (t) => {
  let scans = 0;
  const { root, catalog, document } = await setup(t, {
    workerFactory: (file, options) => {
      const worker = new Worker(file, options),
        post = worker.postMessage.bind(worker);
      worker.postMessage = (message) => {
        if (message.operation === 'scan') scans++;
        post(message);
      };
      return worker;
    },
  });
  for (let index = 0; index < 137; index++) await document(`docs/report-${index}.md`, 100);
  for (let index = 0; index < 20; index++) await document(`docs/unrelated-${index}.md`, 900);
  const first = await catalog.list(root, { query: 'report', limit: 999 });
  assert.equal(first.documents.length, 100);
  assert.equal(first.total, 137);
  assert.equal(first.hasMore, true);
  assert.equal(first.offset, 0);
  assert.equal(first.limited, true);
  const second = await catalog.list(root, { query: 'report', offset: 100 });
  assert.equal(second.documents.length, 37);
  assert.equal(second.total, 137);
  assert.equal(second.hasMore, false);
  assert.equal(second.limited, false);
  assert.equal(second.offset, 100);
  assert.equal(second.fromCache, true);
  assert.deepEqual(
    [...first.documents, ...second.documents].map((doc) => doc.name),
    Array.from({ length: 137 }, (_, index) => `report-${index}.md`),
  );
  const repeat = await catalog.list(root, { query: 'report', offset: 100 });
  assert.deepEqual(repeat.documents, second.documents);
  const end = await catalog.list(root, { query: 'report', offset: 137 });
  assert.deepEqual(end.documents, []);
  assert.equal(end.limited, false);
  assert.equal(end.hasMore, false);
  assert.equal(end.total, 137);
  assert.equal(scans, 1);
});

test('known document changes update cached metadata without recursive rescans, including additions and removals', async (t) => {
  const operations = [];
  const { root, catalog, document } = await setup(t, {
    workerFactory: (file, options) => {
      const worker = new Worker(file, options),
        post = worker.postMessage.bind(worker);
      worker.postMessage = (message) => {
        operations.push(message.operation);
        post(message);
      };
      return worker;
    },
  });
  const original = await document('docs/original.md', 100);
  await catalog.list(root);
  assert.equal(operations.filter((op) => op === 'scan').length, 1);
  await fs.writeFile(original, 'changed body length');
  await catalog.invalidate(root, original);
  const updated = await catalog.list(root);
  assert.equal(updated.fromCache, true);
  assert.equal(updated.documents[0].size, 19);
  const added = await document('docs/new.md', 900);
  await catalog.invalidate(root, added);
  const addedResult = await catalog.list(root);
  assert.equal(addedResult.documents[0].name, 'original.md'); // writeFile gave it today's mtime
  assert.equal(addedResult.documents.length, 2);
  await fs.unlink(original);
  await catalog.invalidate(root, original);
  assert.deepEqual(
    (await catalog.list(root)).documents.map((doc) => doc.name),
    ['new.md'],
  );
  assert.equal(operations.filter((op) => op === 'scan').length, 1);
  assert.equal(operations.filter((op) => op === 'metadata').length, 3);
  await catalog.invalidate(root); // unknown directory change requires a bounded rescan
  assert.equal((await catalog.list(root)).fromCache, false);
  assert.equal(operations.filter((op) => op === 'scan').length, 2);
});

test('dirty metadata reaches both archive modes and does not leak excluded documents', async (t) => {
  const { root, catalog, document } = await setup(t);
  const archived = await document('backup/old.md');
  await document('README.md');
  await catalog.list(root);
  await catalog.list(root, { includeArchives: true });
  await fs.writeFile(archived, 'changed archival document');
  await catalog.invalidate(root, archived);
  assert.equal((await catalog.list(root)).documents.length, 1);
  const result = await catalog.list(root, { includeArchives: true });
  assert.equal(result.documents[0].relativePath, 'backup/old.md');
  assert.equal(result.documents[0].size, 25);
});

test('ordinary code and image changes do not invalidate the document catalog or trigger rescans', async (t) => {
  let scans = 0;
  const { root, catalog, document } = await setup(t, {
    workerFactory: (file, options) => {
      const worker = new Worker(file, options),
        post = worker.postMessage.bind(worker);
      worker.postMessage = (message) => {
        if (message.operation === 'scan') scans++;
        post(message);
      };
      return worker;
    },
  });
  await document('README.md');
  const code = path.join(root, 'code.py'),
    image = path.join(root, 'image.png');
  await fs.writeFile(code, 'before');
  await fs.writeFile(image, 'before');
  await catalog.list(root);
  await fs.writeFile(code, 'after');
  await catalog.invalidate(root, code);
  assert.equal((await catalog.list(root)).fromCache, true);
  await fs.writeFile(image, 'after');
  await catalog.invalidate(root, image);
  assert.equal((await catalog.list(root)).fromCache, true);
  assert.equal(scans, 1);
  await fs.unlink(code);
  await catalog.invalidate(root, code);
  assert.equal((await catalog.list(root)).fromCache, true);
  assert.equal(scans, 1);
  // Unknown deletions and directories with a code-like name remain conservative.
  await catalog.invalidate(root, path.join(root, 'unknown.py'));
  assert.equal((await catalog.list(root)).fromCache, false);
  await fs.mkdir(code);
  await fs.writeFile(path.join(code, 'design.md'), 'new document');
  await catalog.invalidate(root, code);
  const result = await catalog.list(root);
  assert.equal(result.fromCache, false);
  assert(result.documents.some((doc) => doc.relativePath === 'code.py/design.md'));
  assert.equal(scans, 3);
});

test('cache persists metadata across instances, expires by TTL and respects disk totals', async (t) => {
  const { root, dataDir, catalog, document, tmp } = await setup(t, {
    cacheLimits: { maxFiles: 2, maxBytes: 4000, maxFileBytes: 1500 },
  });
  await document('README.md');
  const first = await catalog.list(root);
  assert.equal((await catalog.list(root)).fromCache, true);
  const restored = new DocumentCatalog(dataDir);
  t.after(() => restored.close());
  assert.equal((await restored.list(root)).fromCache, true);
  const expired = new DocumentCatalog(dataDir, { ttlMs: 1 });
  t.after(() => expired.close());
  await pause(10);
  assert.equal((await expired.list(root)).fromCache, false);
  assert.equal((await catalog.list(root, { refresh: true })).fromCache, false);
  for (let index = 0; index < 3; index++) {
    const other = path.join(tmp, 'other-' + index);
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'note.md'), 'metadata');
    await catalog.list(other);
  }
  const names = (await fs.readdir(path.join(dataDir, 'document-catalog'))).filter((name) =>
    name.endsWith('.json'),
  );
  assert(names.length <= 2);
  const sizes = await Promise.all(
    names.map(async (name) => (await fs.stat(path.join(dataDir, 'document-catalog', name))).size),
  );
  assert(sizes.reduce((a, b) => a + b, 0) <= 4000);
  assert(Number.isFinite(first.updatedAt));
});

test('symlink roots/subtrees and cross-root poisoned cache entries cannot escape the chosen project', async (t) => {
  const { root, dataDir, tmp, catalog, document } = await setup(t);
  const outside = path.join(tmp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'do not read');
  await document('safe.md');
  await fs.symlink(outside, path.join(root, 'linked'));
  await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));
  await fs.symlink(root, path.join(tmp, 'root-link'));
  assert.deepEqual(
    (await catalog.list(root)).documents.map((doc) => doc.name),
    ['safe.md'],
  );
  await assert.rejects(catalog.list(path.join(tmp, 'root-link')), {
    code: 'DOCUMENT_CATALOG_PATH',
  });
  await assert.rejects(catalog.list(os.homedir()), { code: 'DOCUMENT_CATALOG_PATH' });
  const cacheFile = path.join(dataDir, 'document-catalog', catalog.key(root, false) + '.json');
  const value = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  value.documents[0].path = path.join(outside, 'secret.md');
  value.documents[0].name = 'secret.md';
  value.documents[0].relativePath = '../outside/secret.md';
  await fs.writeFile(cacheFile, JSON.stringify(value));
  const fresh = new DocumentCatalog(dataDir);
  t.after(() => fresh.close());
  const result = await fresh.list(root);
  assert.equal(result.fromCache, false);
  assert.deepEqual(
    result.documents.map((doc) => doc.name),
    ['safe.md'],
  );
  await fresh.invalidate(root, path.join(root, 'linked.md'));
  assert.deepEqual(
    (await fresh.list(root)).documents.map((doc) => doc.name),
    ['safe.md'],
  );
});

test('deadline and explicit cancellation stop a stuck scan without blocking the caller, then allow retry', async (t) => {
  class Stalled extends EventEmitter {
    ref() {}
    unref() {}
    postMessage() {}
    terminate() {
      return Promise.resolve(0);
    }
  }
  let calls = 0;
  const { root, catalog } = await setup(t, {
    timeoutMs: 150,
    workerFactory: (file, options) => (++calls === 1 ? new Stalled() : new Worker(file, options)),
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  await assert.rejects(catalog.list(root), { code: 'DOCUMENT_CATALOG_TIMEOUT' });
  clearInterval(timer);
  assert(ticks >= 5);
  assert.equal((await catalog.list(root)).fromCache, false);
  const blocked = new DocumentCatalog(path.join(root, 'state'), {
    workerFactory: () => new Stalled(),
  });
  t.after(() => blocked.close());
  const pending = blocked.list(root);
  await pause(5);
  await blocked.cancel(root);
  await assert.rejects(pending, { code: 'DOCUMENT_CATALOG_CANCELED' });
});

test('a null options argument reads as "no options" rather than crashing', async (t) => {
  const { catalog, root } = await setup(t);
  // Default parameters only cover `undefined`, and the renderer can send null.
  // That used to throw a bare TypeError that surfaced as an untranslatable
  // "Cannot read properties of null" message.
  assert.deepEqual(
    (await catalog.list(root, null)).documents,
    (await catalog.list(root)).documents,
  );
  await assert.rejects(catalog.list(root, { sort: 'nonsense' }), {
    code: 'DOCUMENT_CATALOG_OPTIONS',
  });
});
