const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('original-fs').promises;
const crypto = require('node:crypto');
const { MacUpdateInstaller } = require('../core/update-installer.cjs');
const { bundleManifest } = require('../core/update-bundle.cjs');
(async () => {
  const temp = process.argv[2];
  const bundle = path.join(temp, 'old/Folio.app');
  const asar = path.join(bundle, 'Contents/Resources/app.asar');
  assert.equal(
    (await require('node:fs/promises').stat(asar)).isDirectory(),
    true,
    'The real Electron ASAR behavior must be active.',
  );
  const installer = new MacUpdateInstaller({
    dataDir: path.join(temp, 'state'),
    currentBundle: bundle,
    helperPath: path.resolve(__dirname, '../dist-updater/folio-update-helper'),
    currentVersion: '0.0.1',
    arch: process.arch,
  });
  await installer.inspectBundle(bundle, '0.0.1');
  const manifest = await bundleManifest(bundle);
  const entries = manifest.entries || manifest;
  const opaque = Array.isArray(entries)
    ? entries.find((e) => e.path === 'Contents/Resources/app.asar')
    : entries['Contents/Resources/app.asar'];
  assert.equal(opaque.type, 'file');
  assert.equal(
    opaque.sha256,
    crypto
      .createHash('sha256')
      .update(await fs.readFile(asar))
      .digest('hex'),
  );
  const prepared = await installer.prepare({
    archivePath: path.join(temp, 'release.zip'),
    version: '0.0.2',
    sha256: process.argv[3],
    size: Number(process.argv[4]),
  });
  await installer.abort(prepared);
  assert.equal(
    (await fs.readdir(path.dirname(bundle))).filter((p) => p.startsWith('.folio-update-')).length,
    0,
  );
  console.log(JSON.stringify({ ok: true }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
