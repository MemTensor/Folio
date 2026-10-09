import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const { installShutdown } = require('../electron/shutdown.cjs');
const { createProjectServices } = require('../electron/projects.cjs');
const { UpdateGate } = require('../core/update-gate.cjs');
const { digest } = require('../core/state.cjs');
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within(promise, timeout = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Shutdown did not settle.')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function syncFixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-shutdown-sync-')));
  const home = path.join(temp, 'home'),
    root = path.join(home, 'Project'),
    cloudRoot = path.join(temp, 'cloud/Folio');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.dirname(cloudRoot));
  await fs.writeFile(path.join(root, 'note.md'), 'base');
  const project = { id: digest(root).slice(0, 24), name: 'Project', root };
  const services = createProjectServices({
    dataDir: path.join(temp, 'state'),
    library: { state: async () => ({ projects: [project], opened: {} }) },
    openRoot: async () => {},
    gate: new UpdateGate(),
    catalogOptions: { home },
    syncOptions: { home, cloudRoot },
  });
  t.after(async () => {
    await services.close();
    await fs.rm(temp, { recursive: true, force: true });
  });
  await services.init();
  await services.configure({ syncEnabled: true, syncProjectIds: [project.id] });
  await services.runSync();
  return {
    services,
    root,
    cloud: path.join(cloudRoot, 'Project-' + project.id),
  };
}
test('shutdown drains writes once and retries native quit outside the will-quit microtask', async () => {
  const app = new EventEmitter();
  let nativeQuitting = false,
    quitCalls = 0,
    prevented = 0,
    cleanups = 0,
    release;
  let finished;
  const quit = new Promise((resolve) => {
    finished = resolve;
  });
  app.quit = () => {
    assert.equal(nativeQuitting, false);
    quitCalls++;
    finished();
  };
  installShutdown(app, async () => {
    cleanups++;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  nativeQuitting = true;
  app.emit('will-quit', {
    preventDefault() {
      prevented++;
    },
  });
  await Promise.resolve();
  app.emit('will-quit', {
    preventDefault() {
      prevented++;
    },
  });
  release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(quitCalls, 0);
  nativeQuitting = false;
  await quit;
  assert.equal(cleanups, 1);
  assert.equal(quitCalls, 1);
  assert.equal(prevented, 2);
  app.emit('will-quit', {
    preventDefault() {
      prevented++;
    },
  });
  assert.equal(prevented, 2);
});

test('a slow cleanup reports its deadline and still drains before quitting', async () => {
  const app = new EventEmitter();
  let exits = 0,
    quits = 0;
  const drained = deferred(),
    reported = deferred(),
    exited = deferred();
  app.quit = () => {
    quits++;
    exited.resolve();
  };
  app.exit = () => {
    exits++;
  };
  installShutdown(
    app,
    () => drained.promise,
    (error) => reported.resolve(error),
    { timeout: 20 },
  );
  app.emit('will-quit', { preventDefault() {} });
  assert.equal((await within(reported.promise)).code, 'SHUTDOWN_TIMEOUT');
  assert.equal(exits, 0);
  assert.equal(quits, 0);
  let prevented = 0;
  app.emit('will-quit', {
    preventDefault() {
      prevented++;
    },
  });
  assert.equal(prevented, 1);
  drained.resolve();
  await within(exited.promise);
  assert.equal(exits, 0);
  assert.equal(quits, 1);
});

test('a slow cleanup that finishes in time still quits normally', async () => {
  const app = new EventEmitter();
  let quits = 0,
    reported = null;
  let finished;
  const quit = new Promise((resolve) => {
    finished = resolve;
  });
  app.quit = () => {
    quits++;
    finished();
  };
  app.exit = () => assert.fail('a cleanup inside the deadline must not be forced');
  installShutdown(
    app,
    () => new Promise((resolve) => setTimeout(resolve, 5)),
    (error) => {
      reported = error;
    },
    { timeout: 200 },
  );
  app.emit('will-quit', { preventDefault() {} });
  await quit;
  assert.equal(quits, 1);
  assert.equal(reported, null);
});

test('shutdown cancels a stalled sync read without changing either document', async (t) => {
  const { services, root, cloud } = await syncFixture(t);
  const note = path.join(root, 'note.md');
  await fs.writeFile(note, 'local edit');
  const open = fs.open,
    reading = deferred(),
    release = deferred(),
    closedHandle = deferred(),
    exited = deferred();
  fs.open = async (file, ...args) => {
    if (file !== note) return open(file, ...args);
    reading.resolve();
    await release.promise;
    const handle = await open(file, ...args),
      close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      closedHandle.resolve();
    };
    return handle;
  };
  const app = new EventEmitter();
  app.quit = () => exited.resolve();
  app.exit = () => assert.fail('read cancellation must not force exit');
  installShutdown(app, () => services.close());
  const running = services.runSync().catch((error) => error);
  try {
    await within(reading.promise);
    app.emit('will-quit', { preventDefault() {} });
    await within(exited.promise);
    assert.equal((await running).code, 'SYNC_CANCELED');
    assert.equal(await fs.readFile(note, 'utf8'), 'local edit');
    assert.equal(await fs.readFile(path.join(cloud, 'note.md'), 'utf8'), 'base');
  } finally {
    fs.open = open;
    release.resolve();
    await within(closedHandle.promise);
  }
});

for (const rollback of [false, true])
  test(`shutdown waits past its deadline for a captured sync replacement to ${rollback ? 'roll back' : 'finish'}`, async (t) => {
    const { services, root, cloud } = await syncFixture(t);
    const note = path.join(root, 'note.md');
    await fs.writeFile(path.join(cloud, 'note.md'), 'cloud edit');
    const open = fs.open,
      captured = deferred(),
      release = deferred(),
      reported = deferred(),
      exited = deferred();
    fs.open = async (file, ...args) => {
      if (path.basename(file).startsWith('.folio-sync-captured-')) {
        captured.resolve();
        await release.promise;
        if (rollback) throw Object.assign(Error('Captured read failed.'), { code: 'EIO' });
      }
      return open(file, ...args);
    };
    let quits = 0;
    const app = new EventEmitter();
    app.quit = () => {
      quits++;
      exited.resolve();
    };
    app.exit = () => assert.fail('a captured document must be restored before exit');
    installShutdown(
      app,
      () => services.close(),
      (error) => reported.resolve(error),
      { timeout: 20 },
    );
    const running = services.runSync().catch((error) => error);
    try {
      await within(captured.promise);
      app.emit('will-quit', { preventDefault() {} });
      assert.equal((await within(reported.promise)).code, 'SHUTDOWN_TIMEOUT');
      assert.equal(quits, 0);
      await assert.rejects(fs.stat(note), { code: 'ENOENT' });
    } finally {
      fs.open = open;
      release.resolve();
    }
    await within(exited.promise);
    assert.equal((await running).code, 'SYNC_CANCELED');
    assert.equal(quits, 1);
    assert.equal(await fs.readFile(note, 'utf8'), rollback ? 'base' : 'cloud edit');
    assert.equal(await fs.readFile(path.join(cloud, 'note.md'), 'utf8'), 'cloud edit');
    assert.deepEqual(await fs.readdir(root), ['note.md']);
  });
