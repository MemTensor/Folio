// Run with the packaged Electron executable in ELECTRON_RUN_AS_NODE mode.
// This checks worker loading from app.asar and observes only generated files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const bundle = process.argv[2];
  if (!bundle || !path.isAbsolute(bundle) || !bundle.endsWith('.app'))
    throw Error('Pass an absolute Folio.app path.');
  const { WorkspaceBrowser } = require(
    path.join(bundle, 'Contents/Resources/app.asar/core/workspace-browser.cjs'),
  );
  const { WorkspaceSession } = require(
    path.join(bundle, 'Contents/Resources/app.asar/core/workspace-session.cjs'),
  );
  const { DocumentCatalog } = require(
    path.join(bundle, 'Contents/Resources/app.asar/core/document-catalog.cjs'),
  );
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'folio-package-folders-')),
  );
  const { DocumentLibrary } = require(
    path.join(bundle, 'Contents/Resources/app.asar/core/library.cjs'),
  );
  const { DocumentSearch } = require(
    path.join(bundle, 'Contents/Resources/app.asar/core/document-search.cjs'),
  );
  const documentSearch = new DocumentSearch();
  const library = new DocumentLibrary(path.join(temporary, 'library-state'));
  let session, change;
  const browser = new WorkspaceBrowser({ onChange: (event) => session.changed(event) });
  const catalog = new DocumentCatalog(path.join(temporary, 'catalog-state'));
  session = new WorkspaceSession(browser, { onDocument: (file) => change?.(file) });
  try {
    await fs.mkdir(path.join(temporary, 'mirror'));
    await fs.writeFile(path.join(temporary, 'Open.md'), '# generated fixture\n');
    await fs.writeFile(path.join(temporary, 'Unopened.md'), '# generated fixture\n');
    await fs.writeFile(path.join(temporary, 'mirror', 'Ignored.md'), '# not preloaded\n');
    const result = await session.list(temporary);
    assert.equal(result.nodes.length, 3);
    assert(result.nodes.filter((n) => n.kind === 'folder').every((n) => n.children === undefined));
    let stats = await browser.debugStats();
    assert.equal(stats.directories, 1);
    assert.equal(stats.files, 0);
    await session.setDocuments([{ root: temporary, path: path.join(temporary, 'Open.md') }]);
    let documentEvents = 0;
    change = () => documentEvents++;
    await fs.writeFile(path.join(temporary, 'Unopened.md'), '# external unobserved edit\n');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(documentEvents, 0);
    const observed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native file event was not delivered.')), 3000);
      change = (file) => {
        clearTimeout(timer);
        resolve(file);
      };
    });
    await fs.writeFile(path.join(temporary, 'Open.md'), '# external Agent edit\n');
    assert.equal((await observed).path, path.join(temporary, 'Open.md'));
    stats = await browser.debugStats();
    assert.equal(stats.files, 0);
    assert.equal(stats.directories, 1);
    const catalogRoot = path.join(temporary, 'catalog-project');
    const docs = path.join(catalogRoot, 'docs');
    await fs.mkdir(docs, { recursive: true });
    const expectedNames = [];
    for (let index = 0; index < 125; index++) {
      const name = `Report ${String(index).padStart(3, '0')}.md`;
      expectedNames.push(name);
      const file = path.join(docs, name);
      await fs.writeFile(file, '# generated catalog fixture\n');
      await fs.utimes(file, 100, 100);
    }
    await fs.writeFile(path.join(catalogRoot, 'README.md'), '# unrelated generated fixture\n');
    for (const directory of ['backup', 'node_modules', 'skills']) {
      await fs.mkdir(path.join(catalogRoot, directory));
      await fs.writeFile(
        path.join(catalogRoot, directory, 'Report excluded.md'),
        '# excluded generated fixture\n',
      );
    }
    const firstPage = await catalog.list(catalogRoot, { query: 'Report' });
    assert.equal(firstPage.fromCache, false);
    assert.equal(firstPage.total, 125);
    assert.equal(firstPage.documents.length, 100);
    assert.equal(firstPage.offset, 0);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.excluded, true);
    assert(
      firstPage.documents.every(
        (doc) =>
          doc.relativePath.startsWith('docs/') && Number.isFinite(doc.modifiedAt) && doc.size > 0,
      ),
    );
    const cachedPage = await catalog.list(catalogRoot, { query: 'Report' });
    assert.equal(cachedPage.fromCache, true);
    assert.equal(cachedPage.updatedAt, firstPage.updatedAt);
    assert.deepEqual(cachedPage.documents, firstPage.documents);
    const secondPage = await catalog.list(catalogRoot, { query: 'Report', offset: 100 });
    assert.equal(secondPage.fromCache, true);
    assert.equal(secondPage.total, 125);
    assert.equal(secondPage.documents.length, 25);
    assert.equal(secondPage.offset, 100);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.limited, false);
    assert.deepEqual(
      [...firstPage.documents, ...secondPage.documents].map((doc) => doc.name),
      expectedNames,
    );
    const filtered = await catalog.list(catalogRoot, { query: 'Report 012' });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.documents[0].name, 'Report 012.md');
    assert.equal(filtered.fromCache, true);
    const filteredPage = await catalog.list(catalogRoot, {
      query: 'Report 12',
      offset: 2,
      limit: 2,
    });
    assert.equal(filteredPage.total, 7);
    assert.deepEqual(
      filteredPage.documents.map((doc) => doc.name),
      ['Report 120.md', 'Report 121.md'],
    );
    assert.equal(filteredPage.hasMore, true);
    const edited = path.join(docs, 'Report 012.md');
    const editedContent = '# changed generated catalog fixture\n';
    await fs.writeFile(edited, editedContent);
    await catalog.invalidate(catalogRoot, edited);
    const incremental = await catalog.list(catalogRoot, { query: 'Report 012' });
    assert.equal(incremental.fromCache, true);
    assert.equal(incremental.documents[0].size, Buffer.byteLength(editedContent));
    assert.equal((await browser.debugStats()).files, 0);
    assert.equal((await browser.debugStats()).directories, 1);
    const indexed = path.join(catalogRoot, 'Index.md');
    await fs.writeFile(indexed, '# Generated index fixture\npackaged-index-keyword');
    await library.register(catalogRoot);
    const found = await library.snapshot({ query: 'packaged-index-keyword' });
    assert.equal(found.total, 1);
    assert.equal(found.documents[0].match.line, 2);
    assert.equal((await library.snapshot({ query: 'packaged-index-keyword' })).index.filesRead, 0);
    const searched = await documentSearch.search(
      catalogRoot,
      path.join(temporary, 'search-state'),
      'packaged-index-keyword',
    );
    assert.equal(searched.length, 1);
    assert.equal(searched[0].line, 2);
    console.log(
      JSON.stringify({
        packagedDocumentSearch: true,
        packagedSQLite: true,
        ok: true,
        packagedWorker: true,
        directoryWatchers: stats.directories,
        fileWatchers: stats.files,
        openDocumentChanges: true,
        unopenedDocumentBodiesRead: 0,
        documentCatalog: {
          packagedWorker: true,
          total: firstPage.total,
          firstPage: firstPage.documents.length,
          secondPage: secondPage.documents.length,
          cached: cachedPage.fromCache,
          filteredBeforePagination: true,
          incrementalMetadataUpdate: true,
          excludedArchives: true,
        },
      }),
    );
  } finally {
    documentSearch.close();
    await library.close();
    await catalog.close();
    await session.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
