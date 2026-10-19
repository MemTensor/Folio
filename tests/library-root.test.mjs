import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentLibrary, allowedLibraryRoot } = require('../core/library.cjs');
const { Workspaces } = require('../core/workspaces.cjs');
const { WorkspaceBrowser } = require('../core/workspace-browser.cjs');
const { WorkspaceSession } = require('../core/workspace-session.cjs');
const { ProjectCatalog } = require('../core/project-catalog.cjs');
const { writeJSON } = require('../core/state.cjs');

async function fixture(t, layout = 'default') {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'folio-library-root-')),
  );
  const home = path.join(temporary, 'home');
  const dataDir =
    layout === 'default'
      ? path.join(home, 'Library/Application Support/Folio')
      : layout === 'custom-library'
        ? path.join(home, 'Library/Application Support/Custom Folio Profile')
        : path.join(temporary, 'custom-profile');
  await fs.mkdir(dataDir, { recursive: true });
  const library = new DocumentLibrary(dataDir, { home });
  t.after(async () => {
    await library.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { temporary, home, dataDir, library };
}

test('root policy admits only owned Welcome and specific cloud projects inside Library', async (t) => {
  const { home, dataDir, library } = await fixture(t);
  const accepted = [
    path.join(dataDir, 'Welcome'),
    path.join(home, 'Documents/Notes'),
    path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs/Notes'),
    path.join(home, 'Library/CloudStorage/Dropbox/Notes'),
    path.join(home, 'Library/CloudStorage/OneDrive-Team/Research'),
    path.join(home, 'Library/CloudStorage/GoogleDrive-generated/My Drive/Notes'),
  ];
  for (const root of accepted) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'Note.md'), '# Generated note\n');
    assert.equal(library.allowsRoot(root), true, root);
    await library.register(root);
    assert.equal((await library.locate(path.join(root, 'Note.md'))).root, root);
    assert.equal(
      (await library.index.request({ operation: 'filenames', root, query: 'Note' })).documents
        .length,
      1,
      root,
    );
  }
  assert.equal((await library.snapshot()).total, accepted.length);
  assert.equal((await library.snapshot()).blocked.length, 0);

  const rejected = [
    path.parse(home).root,
    path.dirname(home),
    home,
    path.join(home, 'Library'),
    path.join(home, 'Library/CloudStorage'),
    path.join(home, 'Library/CloudStorage/Dropbox'),
    path.join(home, 'Library/CloudStorage/Dropbox/.cache/Notes'),
    path.join(home, 'Library/Caches'),
    path.join(home, 'Library/Keychains'),
    path.join(home, 'Library/Containers'),
    dataDir,
    path.join(dataDir, 'document-index'),
    path.join(home, 'Library/Application Support/Other App/Welcome'),
  ];
  for (const root of rejected) {
    if (root.startsWith(home + path.sep)) await fs.mkdir(root, { recursive: true });
    assert.equal(library.allowsRoot(root), false, root);
    await assert.rejects(library.register(root), { code: 'USAGE' }, root);
    await assert.rejects(
      library.index.request({ operation: 'filenames', root, query: 'Note' }),
      /项目文件夹暂不可用/,
      root,
    );
  }
  assert.equal(allowedLibraryRoot(path.join(dataDir, 'Welcome'), home), false);

  const catalog = new ProjectCatalog(dataDir, { home });
  const registered = (await library.state()).projects;
  const projects = await catalog.validate(
    registered.map((project) => ({ root: project.root, source: 'folio' })),
  );
  assert.equal(projects.length, accepted.length);
});

test('the owned Welcome exception cannot follow a replacement symlink into app state', async (t) => {
  const { home, dataDir, library } = await fixture(t);
  const target = path.join(home, 'Library/Caches/Private');
  await fs.mkdir(target, { recursive: true });
  await fs.symlink(target, path.join(dataDir, 'Welcome'));
  await assert.rejects(library.register(path.join(dataDir, 'Welcome')), { code: 'USAGE' });
});

// Execute the production bootstrap and watchRoot bodies, not a replacement
// bridge returning a fixed root. Only Electron's app paths/event registration
// are supplied by the fixture; registration, browsing, persistence and search
// run through the actual implementations and worker threads.
const main = await fs.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
function productionBootstrap(context) {
  const start = main.indexOf('async function watchRoot(root)');
  const end = main.indexOf('function refreshObservedDocument', start);
  const bootstrapStart = main.indexOf("  handle('bootstrap',");
  const bootstrapEnd = main.indexOf("  handle('choose',", bootstrapStart);
  assert(start >= 0 && end > start && bootstrapStart >= 0 && bootstrapEnd > bootstrapStart);
  let bootstrap;
  vm.runInNewContext(
    main.slice(start, end) + main.slice(bootstrapStart, bootstrapEnd),
    {
      require,
      fs,
      path,
      process,
      setImmediate,
      writeJSON,
      pendingFile: null,
      language: 'zh-CN',
      drainDeferredOpens: () => {},
      handle(name, fn) {
        assert.equal(name, 'bootstrap');
        bootstrap = fn;
      },
      ...context,
    },
    { filename: 'electron/main.cjs:bootstrap-regression' },
  );
  return bootstrap;
}

for (const language of ['zh-CN', 'en'])
  for (const layout of ['default', 'custom-library', 'custom-outside']) {
    test(`production bootstrap opens and reopens Welcome using ${layout} dataDir in ${language}`, async (t) => {
      const { temporary, dataDir, library } = await fixture(t, layout);
      const appPath = path.join(temporary, 'generated-app');
      const names =
        language === 'en'
          ? ['en/Welcome to Folio.md', 'en/Markdown Guide.md', 'AGENTS.md', 'CLAUDE.md']
          : [
              '欢迎使用 Folio.md',
              'Markdown 语法手册.md',
              '公式、图与表.md',
              'AGENTS.md',
              'CLAUDE.md',
            ];
      await fs.mkdir(path.join(appPath, 'examples/assets'), { recursive: true });
      await fs.mkdir(path.join(appPath, 'examples/en'), { recursive: true });
      for (const name of names)
        await fs.writeFile(path.join(appPath, 'examples', name), '# Generated fixture\n');
      await fs.writeFile(path.join(appPath, 'examples/assets/example-curve.png'), 'fixture asset');

      const browser = new WorkspaceBrowser();
      const workspaceSession = new WorkspaceSession(browser);
      t.after(() => workspaceSession.close());
      const workspaces = new Workspaces(dataDir);
      const configuration = {};
      const bootstrap = productionBootstrap({
        language,
        library,
        workspaceSession,
        workspaces,
        configuration,
        app: {
          getPath(name) {
            assert.equal(name, 'userData');
            return dataDir;
          },
          getAppPath: () => appPath,
        },
      });
      const result = await bootstrap();
      const welcome = path.join(dataDir, 'Welcome');
      assert.equal(result.root, welcome);
      assert.equal(configuration.root, welcome);
      assert.deepEqual(
        result.tree
          .filter((node) => node.kind === 'file')
          .map((node) => node.name)
          .sort(),
        names.map((name) => path.basename(name)).sort(),
      );
      assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'))).root, welcome);
      assert.equal((await library.state()).projects[0].root, welcome);
      assert.equal((await library.snapshot()).total, names.length);
      const note = path.join(welcome, path.basename(names[0]));
      assert.equal((await library.locate(note)).root, welcome);
      assert.equal((await workspaces.current().store.read(note)).content, '# Generated fixture\n');
      assert.equal(
        (
          await library.index.request({
            operation: 'filenames',
            root: welcome,
            query: path.basename(names[0]),
          })
        ).documents.length,
        1,
      );

      await fs.writeFile(note, '# User changes to the generated fixture\n');
      assert.equal((await bootstrap()).root, welcome);
      configuration.root = path.join(temporary, 'missing-project');
      assert.equal((await bootstrap()).root, welcome);
      assert.equal(await fs.readFile(note, 'utf8'), '# User changes to the generated fixture\n');
      assert.equal((await library.state()).projects.length, 1);
    });
  }
