import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { REPOSITORY as publishingRepository } from '../scripts/publish-release.mjs';
const require = createRequire(import.meta.url);
const updating = require('../core/update-release.cjs');
const source = await fs.readFile(new URL('../core/repository.cjs', import.meta.url), 'utf8');

function identity(url) {
  const context = {
    require: () => ({ repository: { url } }),
    module: { exports: {} },
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

test('publication and update transport share the canonical repository', () => {
  assert.equal(publishingRepository, 'MemTensor/Folio');
  assert.equal(updating.REPOSITORY, publishingRepository);
  assert.equal(updating.RELEASE_PAGE, 'https://github.com/MemTensor/Folio/releases');
});

test('repository identity rejects arbitrary endpoints and malformed paths', () => {
  for (const url of [
    'http://github.com/owner/repo.git',
    'https://github.com.attacker.invalid/owner/repo.git',
    'https://token@github.com/owner/repo.git',
    'https://github.com/owner/repo.git?token=x',
    'https://github.com/owner/repo.git#fragment',
    'https://github.com/owner/../repo.git',
    undefined,
  ])
    assert.throws(() => identity(url), /Invalid GitHub repository/);
  assert.equal(identity('https://github.com/MemTensor/Folio.git').REPOSITORY, 'MemTensor/Folio');
});

test('installation and update documentation points to the canonical release repository', async () => {
  for (const file of [
    'README.md',
    'README.zh-CN.md',
    'docs/更新说明.md',
    'docs/开源与分发说明.md',
  ]) {
    const content = await fs.readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.match(content, /https:\/\/github\.com\/MemTensor\/Folio\/releases/);
    assert.doesNotMatch(content, /https:\/\/github\.com\/glin93\/folio\/releases/);
  }
});
