import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProjectCatalog, tomlProjects } = require('../core/project-catalog.cjs');
async function setup(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-project-catalog-')));
  const home = path.join(tmp, 'home'),
    codexHome = path.join(home, '.codex'),
    state = path.join(tmp, 'state');
  await fs.mkdir(codexHome, { recursive: true });
  const catalog = new ProjectCatalog(state, { home });
  t.after(async () => {
    await catalog.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return { tmp, home, codexHome, state, catalog };
}
test('catalog reads exact project metadata and deduplicates across harnesses without registering anything', async (t) => {
  const { home, codexHome, state, catalog } = await setup(t);
  const first = path.join(home, 'one'),
    second = path.join(home, 'two');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(
    path.join(codexHome, 'config.toml'),
    `[projects.${JSON.stringify(first)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(home)}]\ntrust_level = "trusted"`,
  );
  await fs.writeFile(
    path.join(codexHome, '.codex-global-state.json'),
    JSON.stringify({ 'electron-saved-workspace-roots': [second], unrelated: ['/never-read'] }),
  );
  await fs.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ projects: { [first]: { history: 'never copied' } }, ignored: true }),
  );
  const result = await catalog.snapshot();
  assert.equal(result.projects.length, 2);
  assert.deepEqual(result.projects.find((item) => item.root === first).sources, [
    'codex',
    'claude',
  ]);
  assert(result.projects.every((item) => item.available));
  const saved = await fs.readFile(path.join(state, 'project-catalog-cache.json'), 'utf8');
  assert(!saved.includes('never copied'));
  assert(!saved.includes('trust_level'));
  await assert.rejects(fs.stat(path.join(state, 'document-library.json')), { code: 'ENOENT' });
});
test('cached metadata stays stable until explicit refresh; known projects merge without scanning contents', async (t) => {
  const { home, codexHome, catalog } = await setup(t);
  const first = path.join(home, 'one'),
    second = path.join(home, 'two');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(codexHome, 'config.toml'), `[projects.${JSON.stringify(first)}]`);
  assert.equal((await catalog.snapshot()).projects.length, 1);
  await fs.writeFile(path.join(codexHome, 'config.toml'), `[projects.${JSON.stringify(second)}]`);
  assert.equal((await catalog.snapshot()).projects[0].root, first);
  const refreshed = await catalog.snapshot({ refresh: true, registered: [{ root: first }] });
  assert.equal(refreshed.projects.length, 2);
  assert.deepEqual(refreshed.projects[0].sources, ['folio']);
});
test('malformed, huge and symlink metadata cannot produce projects', async (t) => {
  const { home, codexHome, catalog } = await setup(t);
  await fs.writeFile(path.join(home, '.claude.json'), '{not json');
  const source = path.join(home, 'source');
  await fs.writeFile(source, `[projects.${JSON.stringify(path.join(home, 'private'))}]`);
  await fs.symlink(source, path.join(codexHome, 'config.toml'));
  const large = await fs.open(path.join(codexHome, '.codex-global-state.json'), 'w');
  await large.truncate(4 * 1024 * 1024 + 1);
  await large.close();
  assert.equal((await catalog.snapshot()).projects.length, 0);
});
test('project directory symlinks and unavailable paths cannot appear as available', async (t) => {
  const { home, codexHome, catalog } = await setup(t);
  const root = path.join(home, 'real'),
    link = path.join(home, 'linked');
  await fs.mkdir(root);
  await fs.symlink(root, link);
  await fs.writeFile(
    path.join(codexHome, 'config.toml'),
    `[projects.${JSON.stringify(link)}]\n[projects.${JSON.stringify(path.join(home, 'missing'))}]`,
  );
  assert((await catalog.snapshot()).projects.every((item) => !item.available));
});
test('watch is limited to present metadata files and can be closed without scanning projects', async (t) => {
  const { codexHome, catalog } = await setup(t);
  assert.deepEqual(await catalog.watch(() => {}), { watching: false, files: 0 });
  await fs.writeFile(path.join(codexHome, 'config.toml'), '');
  assert.deepEqual(await catalog.watch(() => {}), { watching: true, files: 1 });
  await catalog.close();
  assert.equal(catalog.watcher, null);
});
test('TOML metadata accepts quoted absolute project names without interpreting values', () => {
  assert.deepEqual(
    tomlProjects(
      '[projects."/a b"]\n[projects.\'/single\'] # okay\n[unrelated."/skip"]\nkey="/skip"',
    ),
    ['/a b', '/single'],
  );
});
