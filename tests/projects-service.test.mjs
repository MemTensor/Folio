import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createProjectServices } = require('../electron/projects.cjs');
const { UpdateGate } = require('../core/update-gate.cjs');
const { digest } = require('../core/state.cjs');
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-experience-')));
  const home = path.join(temp, 'home'),
    root = path.join(home, 'Project'),
    cloudParent = path.join(temp, 'iCloud');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(cloudParent);
  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(path.join(root, 'note.md'), '# generated document\n');
  await fs.writeFile(
    path.join(home, '.codex/config.toml'),
    `[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`,
  );
  const project = { id: digest(root).slice(0, 24), name: 'Project', root };
  let opened, language;
  const db = { projects: [project], opened: {} };
  const library = {
    state: async () => db,
    register: async (root) => {
      let value = db.projects.find((p) => p.root === root);
      if (!value) {
        value = {
          id: digest(root).slice(0, 24),
          root,
          name: path.basename(root),
          lastOpenedAt: Date.now(),
        };
        db.projects.push(value);
      }
      return value;
    },
  };
  const services = createProjectServices({
    dataDir: path.join(temp, 'state'),
    library,
    openRoot: async (p) => {
      opened = p;
      return { root: p, tree: [] };
    },
    gate: new UpdateGate(),
    onLanguage: (v) => {
      language = v;
    },
    catalogOptions: { home },
    syncOptions: { home, cloudRoot: path.join(cloudParent, 'Folio') },
  });
  t.after(async () => {
    await services.close();
    await fs.rm(temp, { recursive: true, force: true });
  });
  await services.init();
  return {
    services,
    project,
    root,
    temp,
    home,
    db,
    opened: () => opened,
    language: () => language,
  };
}
test('project preferences remain opt-in and only registered IDs can open or sync', async (t) => {
  const f = await fixture(t);
  const data = await f.services.overview();
  assert.equal(data.preferences.discoverProjects, false);
  assert.equal(data.sync.enabled, false);
  assert.equal(data.projects.length, 1);
  await assert.rejects(f.services.open('missing'));
  await assert.rejects(f.services.configure({ syncProjectIds: ['0'.repeat(24)] }));
  await assert.rejects(f.services.configure({ baseURL: 'https://example.test' }));
  await f.services.open(f.project.id);
  assert.equal(f.opened(), f.root);
});
test('partial sync preferences preserve selection and UI receives actual last-run state', async (t) => {
  const f = await fixture(t);
  await f.services.configure({ syncProjectIds: [f.project.id] });
  const enabled = await f.services.configure({
    syncEnabled: true,
    language: 'en',
    onboarded: true,
  });
  assert.deepEqual(enabled.sync.projectIds, [f.project.id]);
  assert.equal(f.language(), 'en');
  await f.services.runSync();
  const after = await f.services.overview();
  assert(after.sync.lastSyncedAt);
  assert.equal(after.sync.cloudProjects.length, 1);
  await f.services.configure({ syncEnabled: false });
  assert.deepEqual((await f.services.overview()).sync.projectIds, [f.project.id]);
  assert.equal(await fs.readFile(path.join(f.root, 'note.md'), 'utf8'), '# generated document\n');
});
test('update gate blocks project changes and cloud writes during install preparation', () => {
  const gate = new UpdateGate();
  gate.begin('request', 'owner');
  for (const channel of [
    'project-open',
    'project-configure',
    'project-sync',
    'project-sync-bind',
    'project-sync-resolve',
  ])
    assert.throws(() => gate.enter(channel), /更新/);
  const finish = gate.enter('project-overview');
  finish();
});

test('quitting waits for an in-flight sync before closing its service', async (t) => {
  const { ProjectSync } = require('../core/project-sync.cjs');
  const original = ProjectSync.prototype.sync;
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  ProjectSync.prototype.sync = async function () {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return { uploaded: 1 };
  };
  t.after(() => {
    ProjectSync.prototype.sync = original;
  });
  const f = await fixture(t);
  const running = f.services.runSync();
  await started;
  let closed = false;
  const closing = f.services.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  release();
  await running;
  await closing;
  assert.equal(closed, true);
});

test('opening a selected project does not revalidate unrelated projects or cloud state', async (t) => {
  const f = await fixture(t);
  const { ProjectCatalog } = require('../core/project-catalog.cjs'),
    { ProjectSync } = require('../core/project-sync.cjs');
  const snapshot = ProjectCatalog.prototype.snapshot,
    status = ProjectSync.prototype.status;
  ProjectCatalog.prototype.snapshot = async () => {
    throw Error('Unrelated discovery must not run');
  };
  ProjectSync.prototype.status = async () => {
    throw Error('Unrelated cloud status must not run');
  };
  t.after(() => {
    ProjectCatalog.prototype.snapshot = snapshot;
    ProjectSync.prototype.status = status;
  });
  const result = await f.services.open(f.project.id);
  assert.equal(result.root, f.root);
  assert.equal(result.autoOpen, false);
});

test('home does not enumerate Agent records until discovery is requested', async (t) => {
  const f = await fixture(t),
    { ProjectCatalog } = require('../core/project-catalog.cjs');
  let scans = 0;
  const original = ProjectCatalog.prototype.snapshot;
  ProjectCatalog.prototype.snapshot = async function (options) {
    scans++;
    return original.call(this, options);
  };
  t.after(() => {
    ProjectCatalog.prototype.snapshot = original;
  });
  await f.services.configure({ discoverProjects: true });
  assert.equal(scans, 0);
  await f.services.overview();
  assert.equal(scans, 0);
  await f.services.overview({ discover: true });
  assert.equal(scans, 1);
  const pinned = await f.services.configure({ pinnedProjects: [f.project.id] });
  assert.deepEqual(pinned.preferences.pinnedProjects, [f.project.id]);
  await assert.rejects(f.services.configure({ pinnedProjects: ['not-an-id'] }));
});

test('pinning a discovered project persists it independently of automatic discovery', async (t) => {
  const f = await fixture(t),
    other = path.join(f.home, 'Other project');
  await fs.mkdir(other);
  await fs.appendFile(
    path.join(f.home, '.codex/config.toml'),
    `[projects.${JSON.stringify(other)}]\ntrust_level="trusted"\n`,
  );
  await f.services.configure({ discoverProjects: true });
  const discovered = await f.services.overview({ discover: true, refresh: true });
  const id = discovered.projects.find((p) => p.root === other).id;
  await assert.rejects(f.services.configure({ pinnedProjects: [id, '0'.repeat(24)] }));
  assert.equal(f.db.projects.length, 1);
  const pinned = await f.services.configure({ pinnedProjects: [id] });
  assert(pinned.projects.find((p) => p.id === id).registered);
  const manual = await f.services.configure({ discoverProjects: false });
  assert(manual.projects.some((p) => p.id === id));
  assert.deepEqual(manual.preferences.pinnedProjects, [id]);
});
test('home preserves recent document metadata beyond thirty-two entries before UI noise filtering', async (t) => {
  const f = await fixture(t);
  f.db.opened[path.join(f.root, 'note.md')] = 1;
  for (let i = 0; i < 60; i++) f.db.opened[path.join(f.root, `temporary-${i}.md`)] = 100 + i;
  const data = await f.services.overview();
  assert.equal(data.recentDocuments.length, 61);
  assert(data.recentDocuments.some((d) => d.name === 'note.md'));
});
test('recently used projects remain visible after the library grows beyond two hundred entries', async (t) => {
  const f = await fixture(t);
  f.project.lastOpenedAt = 1000;
  for (let i = 0; i < 205; i++)
    f.db.projects.unshift({
      id: digest('older-' + i).slice(0, 24),
      name: 'Older ' + i,
      root: path.join(f.home, 'older-' + i),
      lastOpenedAt: i,
    });
  const data = await f.services.overview();
  assert.equal(data.projects.length, 200);
  assert.equal(data.projects[0].id, f.project.id);
});
