import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
const require = createRequire(import.meta.url);
const { WorkspaceBrowser, WORKSPACE_BROWSER_LIMITS } = require('../core/workspace-browser.cjs');

async function setup(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-browser-')));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const changes = [],
    notices = [];
  const browser = new WorkspaceBrowser({
    onChange: (event) => changes.push(event),
    onNotice: (event) => notices.push(event),
    ...options,
  });
  t.after(async () => {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { root, directory, browser, changes, notices };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await pause(20);
  }
  assert(predicate(), 'expected directory notification');
}

test('workspace browsing reads one metadata layer and watches no individual files or child directories', async (t) => {
  const { root, browser, changes, notices } = await setup(t, {
    workerFactory: (file, options) =>
      new Worker(
        `
      const fs = require('node:fs');
      const original = fs.watch;
      fs.watch = (target, ...args) => {
        if (!fs.statSync(target).isDirectory()) throw Error('must never watch a file');
        return original(target, ...args);
      };
      require('node:fs/promises').readFile = () => { throw Error('must never read document bodies'); };
      require(${JSON.stringify(require.resolve('../core/workspace-browser-worker.cjs'))});
    `,
        { ...options, eval: true },
      ),
  });
  const child = path.join(root, 'nested');
  await fs.mkdir(child);
  await fs.mkdir(path.join(root, '.hidden'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, '2.md'), '# metadata only');
  await fs.writeFile(path.join(root, '10.md'), 'body');
  await fs.writeFile(path.join(root, 'binary.pdf'), Buffer.alloc(1024));
  await fs.writeFile(path.join(child, 'inside.md'), 'nested');
  const result = await browser.list(root);
  assert.deepEqual(
    result.nodes.map((node) => node.name),
    ['nested', '2.md', '10.md'],
  );
  assert.equal(result.limited, false);
  assert.equal(result.watching, true);
  assert.equal('children' in result.nodes[0], false);
  assert.equal(result.nodes[1].size, 15);
  assert(Number.isFinite(result.nodes[1].mtime));
  assert.deepEqual(await browser.debugStats(), { directories: 1, files: 0, roots: 1, pending: 0 });
  await fs.writeFile(path.join(child, 'inside.md'), 'not watched yet');
  await pause(200);
  assert.equal(changes.length, 0);
  await browser.list(root, child);
  // Test steady-state native events separately from the deterministic cold
  // subscription gap regression below. fs.watch has no native-ready callback.
  await pause(600);
  changes.length = 0;
  await fs.writeFile(path.join(child, 'inside.md'), 'now watched');
  await until(() => changes.some((event) => event.path === path.join(child, 'inside.md'))).catch(
    (error) => {
      throw new Error('Directory notification missing: ' + JSON.stringify({ notices, changes }), {
        cause: error,
      });
    },
  );
  assert(changes.every((event) => event.root === root && event.directory === child));
});

test('one metadata reconciliation covers dropped cold-start events and never turns into polling', async (t) => {
  const { root, browser, changes } = await setup(t, {
    workerFactory: (file, options) =>
      new Worker(
        `
      const fs = require('node:fs');
      const { EventEmitter } = require('node:events');
      // A native stream that has not started sends no events. Also change a
      // document in the precise gap between listing and watcher registration.
      fs.watch = (directory) => {
        fs.writeFileSync(require('node:path').join(directory, 'gap.md'), 'created during registration');
        const watcher = new EventEmitter();
        watcher.close = () => {};
        return watcher;
      };
      require('node:fs/promises').readFile = () => { throw Error('metadata checks must not read bodies'); };
      require(${JSON.stringify(require.resolve('../core/workspace-browser-worker.cjs'))});
    `,
        { ...options, eval: true },
      ),
  });
  await fs.writeFile(path.join(root, 'edited.md'), 'before');
  await fs.writeFile(path.join(root, 'removed.md'), 'before');
  const listing = await browser.list(root);
  assert.equal(
    listing.nodes.some((node) => node.name === 'gap.md'),
    false,
  );
  await fs.writeFile(path.join(root, 'edited.md'), 'after a cold start');
  await fs.writeFile(path.join(root, 'created.md'), 'new');
  await fs.unlink(path.join(root, 'removed.md'));
  await until(() => new Set(changes.map((event) => path.basename(event.path))).size === 4);
  assert.deepEqual(changes.map((event) => path.basename(event.path)).sort(), [
    'created.md',
    'edited.md',
    'gap.md',
    'removed.md',
  ]);
  const count = changes.length;
  await fs.writeFile(path.join(root, 'later.md'), 'not observed by a one-shot reconcile');
  await pause(650);
  assert.equal(changes.length, count);

  // A collapsed directory must not deliver its scheduled startup check.
  const child = path.join(root, 'child');
  await fs.mkdir(child);
  await browser.list(root, child);
  await browser.unwatch(root, child);
  await pause(650);
  assert.equal(changes.length, count);
});

test('workspace browsing rejects outside roots, symlinks and ignored subtrees', async (t) => {
  const { root, directory, browser } = await setup(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, 'vendor'));
  await fs.symlink(outside, path.join(root, 'linked'));
  await fs.symlink(root, path.join(directory, 'root-link'));
  await fs.symlink(path.join(outside, 'missing.md'), path.join(root, 'file.md'));
  await assert.rejects(browser.list(root, outside), { code: 'WORKSPACE_PATH' });
  await assert.rejects(browser.list(root, path.join(root, 'linked')), { code: 'WORKSPACE_PATH' });
  await assert.rejects(browser.list(path.join(directory, 'root-link')), { code: 'WORKSPACE_PATH' });
  await assert.rejects(browser.watch(root, path.join(root, 'vendor')), { code: 'WORKSPACE_PATH' });
  await assert.rejects(browser.list(os.homedir()), { code: 'WORKSPACE_PATH' });
  assert.deepEqual((await browser.list(root)).nodes, []);
});

test('listing enforces both total metadata and displayed-node budgets', async (t) => {
  const { root, browser } = await setup(t, { limits: { maxEntries: 4, maxNodes: 2 } });
  await Promise.all(
    Array.from({ length: 8 }, (_, n) => fs.writeFile(path.join(root, `${n}.md`), 'x')),
  );
  const first = await browser.list(root);
  assert.equal(first.nodes.length, 2);
  assert.equal(first.limited, true);
  assert(first.scanned <= 4);
  const other = path.join(root, 'assets');
  await fs.mkdir(other);
  await Promise.all(
    Array.from({ length: 8 }, (_, n) => fs.writeFile(path.join(other, `${n}.png`), 'x')),
  );
  const second = await browser.list(root, other);
  assert.deepEqual(second.nodes, []);
  assert.equal(second.scanned, 4);
  assert.equal(second.limited, true);
  assert.equal(WORKSPACE_BROWSER_LIMITS.maxDirectories, 128);
  assert.equal(WORKSPACE_BROWSER_LIMITS.maxEntries, 2000);
  assert.equal(WORKSPACE_BROWSER_LIMITS.maxNodes, 500);
});

test('global watcher limit and per-root subscriptions release without disrupting other roots', async (t) => {
  const { root, browser, notices } = await setup(t, { limits: { maxDirectories: 2 } });
  const child = path.join(root, 'child'),
    other = path.join(root, 'other');
  await fs.mkdir(child);
  await fs.mkdir(other);
  await browser.watch(root);
  await browser.watch(root, child);
  await browser.watch(child);
  assert.deepEqual(await browser.watch(root, other), { watching: false, limited: true });
  assert.equal(notices.filter((n) => n.code === 'WORKSPACE_WATCH_LIMIT').length, 1);
  assert.deepEqual(await browser.unwatch(root, child), { closed: 0 });
  assert.equal((await browser.debugStats()).directories, 2);
  assert.deepEqual(await browser.closeRoot(root), { closed: 1 });
  assert.deepEqual(await browser.debugStats(), { directories: 1, files: 0, roots: 1, pending: 0 });
  assert.deepEqual(await browser.closeRoot(child), { closed: 1 });
  assert.equal((await browser.debugStats()).directories, 0);
  assert.equal((await browser.watch(root, other)).watching, true);
});

test('late directory listings cannot resurrect a collapsed folder watcher', async (t) => {
  const { root, browser } = await setup(t, {
    workerFactory: (file, options) =>
      new Worker(
        `
      const fs = require('node:fs/promises');
      const original = fs.lstat;
      fs.lstat = async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 80));
        return original(...args);
      };
      require(${JSON.stringify(require.resolve('../core/workspace-browser-worker.cjs'))});
    `,
        { ...options, eval: true },
      ),
  });
  // Warm the worker so the collapse deterministically follows list dispatch.
  await browser.request('stats');
  const pending = browser.list(root);
  await pause(15);
  await browser.unwatch(root);
  await assert.rejects(pending, { code: 'WORKSPACE_CLOSED' });
  assert.equal((await browser.debugStats()).directories, 0);
  assert.equal((await browser.list(root)).watching, true);
});

test('worker timeout rejects all pending requests, leaves the main loop responsive and permits retry', async (t) => {
  class UnresponsiveWorker extends EventEmitter {
    ref() {}
    unref() {}
    postMessage() {}
    terminate() {
      this.terminated = true;
      return new Promise(() => {});
    }
  }
  const stalled = new UnresponsiveWorker();
  let created = 0;
  const { root, browser, notices } = await setup(t, {
    timeoutMs: 200,
    workerFactory: (file, options) => (++created === 1 ? stalled : new Worker(file, options)),
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = Date.now();
  assert.equal(browser.generation, 0);
  const results = await Promise.allSettled([browser.list(root), browser.watch(root)]);
  clearInterval(timer);
  assert(
    results.every(
      (result) => result.status === 'rejected' && result.reason.code === 'WORKSPACE_TIMEOUT',
    ),
  );
  assert(Date.now() - started < 1000);
  assert(ticks >= 5);
  assert.equal(stalled.terminated, true);
  assert.equal(browser.generation, 1);
  assert.equal(notices[0].code, 'WORKSPACE_TIMEOUT');
  assert.equal((await browser.list(root)).watching, true);
  assert.equal(created, 2);
  assert.equal(browser.generation, 2);
  await browser.close();
  await assert.rejects(browser.list(root), { code: 'WORKSPACE_CLOSED' });
});
