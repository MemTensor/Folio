import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const text = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const json = (path) => JSON.parse(text(path));

test('license and attribution remain present in independently distributed plugin and skill', () => {
  for (const folder of ['integrations/plugins/folio', 'integrations/plugins/folio/skills/folio']) {
    assert.equal(text(folder + '/LICENSE'), text('LICENSE'));
    assert.equal(text(folder + '/NOTICE'), text('NOTICE'));
  }
  assert.match(
    text('integrations/plugins/folio/THIRD_PARTY_NOTICES.md'),
    /Copyright \(c\) 2020 Phosphor Icons/,
  );
});

test('license metadata matches the approved author and copyright holder without changing repository visibility', () => {
  const pkg = json('package.json'),
    lock = json('package-lock.json');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(lock.packages[''].license, pkg.license);
  assert.equal(pkg.author, 'Zehao Lin');
  assert.match(text('NOTICE'), /Copyright 2026 MemTensor/);
  assert.match(text('NOTICE'), /Author: Zehao Lin/);
  assert.match(text('NOTICE'), /Source: https:\/\/github.com\/MemTensor\/Folio/);
  for (const type of ['codex', 'claude'])
    assert.equal(
      json(`integrations/plugins/folio/.${type}-plugin/plugin.json`).author.name,
      pkg.author,
    );
});
