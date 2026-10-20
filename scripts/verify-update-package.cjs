// Run through the packaged Electron runtime. Observe its actual request URL,
// without network, credentials, user documents or application state.
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const [bundle, expected] = process.argv.slice(2);
  assert(path.isAbsolute(bundle) && bundle.endsWith('.app'));
  assert.equal(expected, 'MemTensor/Folio');
  const resource = path.join(bundle, 'Contents/Resources/app.asar');
  const { REPOSITORY, RELEASE_PAGE } = require(path.join(resource, 'core/update-release.cjs'));
  const { GitHubUpdateSource } = require(path.join(resource, 'core/update-source.cjs'));
  assert.equal(REPOSITORY, expected);
  assert.equal(RELEASE_PAGE, `https://github.com/${expected}/releases`);
  const requests = [];
  const source = new GitHubUpdateSource({
    ghBinary: '/generated/expired-gh',
    spawnImpl: () => {
      throw Error('Public updates must not invoke gh.');
    },
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.headers.Authorization, undefined);
      return new Response(url.includes('/assets/') ? 'generated package update' : '[]');
    },
  });
  assert.deepEqual(await source.listReleases(), []);
  assert.deepEqual(requests, [
    `https://api.github.com/repos/${expected}/releases?per_page=25&page=1`,
  ]);
  const bytes = await source.asset({ id: 23, size: Buffer.byteLength('generated package update') });
  assert.equal(bytes.toString(), 'generated package update');
  assert.equal(requests.at(-1), `https://api.github.com/repos/${expected}/releases/assets/23`);
  await assert.rejects(source.request('repos/glin93/folio/releases'), { code: 'BAD_SOURCE' });
  const { contextItems, popupContext } = require(path.join(resource, 'electron/context-menu.cjs'));
  assert.equal(typeof popupContext, 'function');
  const context = contextItems(
    { kind: 'document', editable: false, selection: true },
    (value) => value,
    () => {},
  );
  assert.equal(context.find((item) => item.id === 'copy-preview').enabled, true);
  assert.equal(context.find((item) => item.role === 'paste').enabled, false);
  console.log(JSON.stringify({ ok: true, repository: REPOSITORY, page: RELEASE_PAGE }));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
