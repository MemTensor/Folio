import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { resolveCodexRuntime, runtimePATH } = createRequire(import.meta.url)(
  '../core/codex-runtime.cjs',
);

async function layout(t, modern, directory) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-codex-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules/@openai/codex');
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.162.0' }),
  );
  const launcher = path.join(packageRoot, 'bin/codex.js');
  await fs.writeFile(launcher, '#!/usr/bin/env node\n');
  const vendor = modern
    ? path.join(packageRoot, 'node_modules/@openai/codex-darwin-arm64')
    : packageRoot;
  if (modern) {
    await fs.mkdir(vendor, { recursive: true });
    await fs.writeFile(
      path.join(vendor, 'package.json'),
      JSON.stringify({ name: '@openai/codex-darwin-arm64', version: '0.162.0-darwin-arm64' }),
    );
  }
  const native = path.join(vendor, 'vendor/aarch64-apple-darwin', directory, 'codex');
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.writeFile(native, 'generated executable', { mode: 0o755 });
  const alias = path.join(root, 'codex');
  await fs.symlink(launcher, alias);
  return { alias, native };
}

test('macOS npm resolves the platform package binary without invoking Node', async (t) => {
  for (const directory of ['bin', 'codex']) {
    const { alias, native } = await layout(t, true, directory);
    const result = await resolveCodexRuntime(alias, { platform: 'darwin', arch: 'arm64' });
    assert.equal(result.executable, await fs.realpath(native));
    assert.equal(result.source, 'npm-platform');
    assert.equal(result.version, '0.162.0');
  }
});
test('legacy npm vendor layouts remain usable and an incomplete install fails before spawning a JS launcher', async (t) => {
  const { alias, native } = await layout(t, false, 'codex');
  assert.equal(
    (await resolveCodexRuntime(alias, { platform: 'darwin', arch: 'arm64' })).source,
    'npm-legacy',
  );
  await fs.unlink(native);
  await assert.rejects(resolveCodexRuntime(alias, { platform: 'darwin', arch: 'arm64' }), {
    code: 'AGENT_MISSING',
  });
});
test('GUI runtime PATH retains existing absolute entries and includes the CLI prefix and common install locations', () => {
  const paths = runtimePATH('/generated/install/bin/codex', {
    PATH: '/usr/bin:relative:/bin',
  }).split(path.delimiter);
  assert(paths.includes('/generated/install/bin'));
  assert(paths.includes('/opt/homebrew/bin'));
  assert(paths.includes('/usr/bin'));
  assert(!paths.includes('relative'));
});
