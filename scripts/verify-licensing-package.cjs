const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const resources = path.join(process.argv[2], 'Contents/Resources');
const asar = path.join(resources, 'app.asar');
for (const file of ['LICENSE', 'NOTICE', 'AUTHORS.md', 'CITATION.cff']) {
  assert.equal(
    fs.readFileSync(path.join(asar, file), 'utf8'),
    fs.readFileSync(path.join(root, file), 'utf8'),
    'Missing or stale packaged ' + file,
  );
}
const pkg = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'));
assert.equal(pkg.license, 'Apache-2.0');
assert.equal(pkg.author, 'Zehao Lin');
const plugin = 'integrations/plugins/folio';
for (const directory of [plugin, plugin + '/skills/folio']) {
  for (const file of ['LICENSE', 'NOTICE']) {
    assert.equal(
      fs.readFileSync(path.join(resources, directory, file), 'utf8'),
      fs.readFileSync(path.join(root, file), 'utf8'),
      'Standalone integration must retain ' + file,
    );
  }
}
assert.equal(
  fs.readFileSync(path.join(resources, plugin, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
  fs.readFileSync(path.join(root, plugin, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
);
console.log(
  JSON.stringify({
    ok: true,
    license: pkg.license,
    author: pkg.author,
    applicationNotices: true,
    standaloneIntegrationNotices: true,
  }),
);
