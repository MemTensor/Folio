import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { Diagnostics } = createRequire(import.meta.url)('../core/diagnostics.cjs');

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new Diagnostics(root, { version: '0.5.0-beta.16', ...options });
}
test('records and exports only allowlisted metadata, even when stored rows were tampered with', async (t) => {
  const log = await setup(t);
  log.record('codex-runtime', {
    stage: 'start',
    runtimeSource: 'npm-platform',
    runtimeVersion: '0.162.0',
    key: 'SECRET_TOKEN',
    url: 'https://auth.openai.com/?state=SECRET_TOKEN',
    path: '/private/user/document.md',
    content: 'SECRET_DOCUMENT',
    message: 'SECRET_MESSAGE',
    operation: 'SECRET_OPERATION',
  });
  await log.writing;
  await fs.appendFile(
    log.current,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'connection',
      stage: 'error',
      provider: 'chatgpt',
      code: 'SECRET_CODE',
      message: 'SECRET_TOKEN',
    }) + '\n',
  );
  const output = await log.snapshot();
  assert.doesNotMatch(output, /SECRET_|document\.md|auth\.openai/);
  assert.match(output, /npm-platform/);
  assert.match(output, /UNKNOWN/);
});
test('rotation never grows beyond two bounded files and burst failures are coalesced', async (t) => {
  let now = 0;
  const log = await setup(t, { maxBytes: 512, now: () => now });
  for (let i = 0; i < 30; i++) {
    now += 2100;
    log.record('ipc-failure', { operation: 'read', code: 'ENOENT' });
    await log.writing;
  }
  const files = await fs.readdir(log.directory);
  assert.equal(files.length, 2);
  for (const name of files) assert((await fs.stat(path.join(log.directory, name))).size <= 512);
  const count = JSON.parse(await log.snapshot()).entries.length;
  for (let i = 0; i < 500; i++) log.record('ipc-failure', { operation: 'read', code: 'ENOENT' });
  await log.writing;
  assert.equal(JSON.parse(await log.snapshot()).entries.length, count);
  assert(log.recent.size <= 128);
  assert.equal(log.pending, 0);
});
test('logging failure does not block work and a symlink is never followed for append', async (t) => {
  const log = await setup(t);
  await log.ensure();
  const protectedFile = path.join(path.dirname(log.directory), 'protected.txt');
  await fs.writeFile(protectedFile, 'unchanged');
  await fs.symlink(protectedFile, log.current);
  log.record('app-start');
  await log.writing;
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'unchanged');
  assert.equal(JSON.parse(await log.snapshot()).entries.length, 0);
});
