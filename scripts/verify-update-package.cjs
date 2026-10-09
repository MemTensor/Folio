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
    ghBinary: null,
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response('[]');
    },
  });
  assert.deepEqual(await source.listReleases(), []);
  assert.deepEqual(requests, [
    `https://api.github.com/repos/${expected}/releases?per_page=100&page=1`,
  ]);
  await assert.rejects(source.request('repos/glin93/folio/releases'), { code: 'BAD_SOURCE' });
  console.log(JSON.stringify({ ok: true, repository: REPOSITORY, page: RELEASE_PAGE }));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
