import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  REPOSITORY,
  versionParts,
  compareVersions,
  releaseCandidate,
  checksumFor,
} = require('../core/update-release.cjs');
const { GitHubUpdateSource } = require('../core/update-source.cjs');
const { UpdateService } = require('../core/update-service.cjs');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function release(version = '0.4.0-beta.5', bytes = Buffer.from('generated zip')) {
  const name = `Folio-${version}-arm64-mac.zip`,
    sum = Buffer.from(hash(bytes) + '  ' + name + '\n');
  return {
    tag_name: 'v' + version,
    prerelease: version.includes('-'),
    draft: false,
    body: 'Improvements',
    assets: [
      { id: 10, name, size: bytes.length, state: 'uploaded', digest: 'sha256:' + hash(bytes) },
      {
        id: 11,
        name: 'SHA256SUMS.txt',
        size: sum.length,
        state: 'uploaded',
        digest: 'sha256:' + hash(sum),
      },
    ],
    sum,
    bytes,
  };
}
test('strict semantic versions respect numeric prereleases and build metadata', () => {
  for (const invalid of ['1.2', '01.2.3', '1.2.3-beta.01', '1.2.3 ', 'v1.2.3', '1.2.3-'])
    assert.equal(versionParts(invalid), null);
  assert(compareVersions('0.4.0-beta.10', '0.4.0-beta.9') > 0);
  assert(compareVersions('0.4.0', '0.4.0-beta.99') > 0);
  assert.equal(compareVersions('1.2.3+a', '1.2.3+b'), 0);
});
test('release selection never downgrades and preserves stable/beta channels', () => {
  assert.equal(releaseCandidate([release('0.4.0-beta.1')], '0.4.0-beta.3', 'arm64'), null);
  assert.equal(releaseCandidate([release('0.5.0-beta.1')], '0.4.0', 'arm64'), null);
  assert.equal(
    releaseCandidate([release('0.4.0-beta.9'), release('0.4.0-beta.10')], '0.4.0-beta.3', 'arm64')
      .version,
    '0.4.0-beta.10',
  );
  const draft = release('9.0.0');
  draft.draft = true;
  assert.equal(releaseCandidate([draft], '0.4.0', 'arm64'), null);
  const bad = release();
  bad.prerelease = false;
  assert.equal(releaseCandidate([bad], '0.4.0-beta.3', 'arm64'), null);
  const missing = release();
  missing.assets.pop();
  assert.throws(() => releaseCandidate([missing], '0.4.0-beta.3', 'arm64'), {
    code: 'NO_COMPATIBLE_ASSET',
  });
  const duplicate = release();
  duplicate.assets.push(duplicate.assets[0]);
  assert.throws(() => releaseCandidate([duplicate], '0.4.0-beta.3', 'arm64'), {
    code: 'NO_COMPATIBLE_ASSET',
  });
});
test('checksums require one exact file and cannot silently accept duplicate records', () => {
  const h = 'a'.repeat(64);
  assert.equal(checksumFor(h + '  exact.zip\n', 'exact.zip'), h);
  assert.throws(() => checksumFor(h + '  exact.zip\n' + h + '  exact.zip\n', 'exact.zip'), {
    code: 'BAD_CHECKSUM',
  });
  assert.throws(() => checksumFor(h + '  ../exact.zip\n', 'exact.zip'), { code: 'BAD_CHECKSUM' });
});
test('private transport pins GitHub and strips debug output without exposing authentication', async () => {
  let observed;
  const source = new GitHubUpdateSource({
    ghBinary: '/generated/gh',
    spawnImpl: (binary, args, options) => {
      observed = { binary, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.stdout.destroy();
        child.emit('close', 1);
      };
      queueMicrotask(() => {
        child.stdout.end('[]');
        child.stderr.end('github_pat_' + 'generated_private_secret_do_not_expose');
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.deepEqual(await source.listReleases(), []);
  assert(observed.args.includes('github.com'));
  assert.equal(observed.options.env.GH_DEBUG, undefined);
  assert.equal(observed.options.shell, false);
  assert(observed.args.at(-1).startsWith(`repos/${REPOSITORY}/releases?`));
});
test('public transport rejects redirected hosts and does not call private 404 up-to-date', async () => {
  const redirect = new GitHubUpdateSource({
    ghBinary: null,
    fetchImpl: async () =>
      new Response('', { status: 302, headers: { location: 'https://attacker.invalid/file' } }),
  });
  await assert.rejects(redirect.listReleases(), { code: 'BAD_SOURCE' });
  const privateRepo = new GitHubUpdateSource({
    ghBinary: null,
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  await assert.rejects(privateRepo.listReleases(), { code: 'AUTH_REQUIRED' });
});
test('release pagination limits report incomplete instead of claiming current', async () => {
  const source = new GitHubUpdateSource({
    ghBinary: null,
    fetchImpl: async () =>
      new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ draft: true })))),
  });
  await assert.rejects(source.listReleases(), { code: 'INCOMPLETE' });
});
async function setup(t, { corrupt = false, prepare } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-updates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const item = release(),
    calls = { prepare: 0, launch: 0, abort: 0 };
  const source = {
    listReleases: async () => [item],
    asset: async (asset, { destination, onProgress } = {}) => {
      if (!destination) return item.sum;
      await fs.writeFile(destination, corrupt ? Buffer.from('wrong') : item.bytes);
      onProgress?.(item.bytes.length);
    },
  };
  const installer = {
    readResult: async () => null,
    acknowledgeStartup: async () => true,
    prepare: async (args) => {
      calls.prepare++;
      await prepare?.();
      return { id: 'prepared', ...args };
    },
    launch: async () => {
      calls.launch++;
      return { helperPid: 123 };
    },
    abort: async () => {
      calls.abort++;
    },
  };
  const service = new UpdateService({
    currentVersion: '0.4.0-beta.3',
    platform: 'darwin',
    arch: 'arm64',
    supported: true,
    dataDir: dir,
    source,
    installer,
  });
  return { service, calls, item, dir };
}
test('download verifies bytes before allowing a one-time installation request', async (t) => {
  const { service, calls } = await setup(t);
  assert.equal((await service.check()).phase, 'available');
  assert.equal((await service.download()).phase, 'ready');
  assert.equal(calls.prepare, 0);
  const { requestId } = service.beginInstall();
  await assert.rejects(service.commitInstall({ requestId: 'old', parentPid: 1 }), {
    code: 'STALE_REQUEST',
  });
  await service.commitInstall({ requestId, parentPid: 1 });
  assert.equal(calls.prepare, 1);
  assert.equal(calls.launch, 1);
  assert.equal(service.snapshot().phase, 'installing');
  await assert.rejects(service.commitInstall({ requestId, parentPid: 1 }), {
    code: 'STALE_REQUEST',
  });
  assert(!JSON.stringify(service.snapshot()).includes('archivePath'));
});
test('a corrupt download cannot enter ready or launch an installer', async (t) => {
  const { service, calls } = await setup(t, { corrupt: true });
  await service.check();
  const state = await service.download();
  assert.equal(state.phase, 'error');
  assert.equal(state.errorCode, 'BAD_CHECKSUM');
  assert.equal(calls.launch, 0);
  assert.throws(() => service.beginInstall(), { code: 'NOT_READY' });
});
test('document changes while extracting cancel the installation without launching', async (t) => {
  let unchanged = true;
  const { service, calls } = await setup(t, {
    prepare: async () => {
      unchanged = false;
    },
  });
  await service.check();
  await service.download();
  const { requestId } = service.beginInstall();
  await assert.rejects(service.commitInstall({ requestId, parentPid: 1, guard: () => unchanged }), {
    code: 'DOCUMENT_CHANGED',
  });
  assert.equal(calls.launch, 0);
  assert.equal(calls.abort, 1);
});
test('post-launch changes disarm the waiting helper instead of allowing a later ordinary exit to update', async (t) => {
  const { service, calls } = await setup(t);
  let unchanged = true;
  service.installer.launch = async () => {
    calls.launch++;
    unchanged = false;
    return { helperPid: 123 };
  };
  await service.check();
  await service.download();
  const { requestId } = service.beginInstall();
  await assert.rejects(service.commitInstall({ requestId, parentPid: 1, guard: () => unchanged }), {
    code: 'DOCUMENT_CHANGED',
  });
  assert.equal(calls.abort, 1);
  assert.equal(service.snapshot().phase, 'error');
});

for (const scenario of ['canceled', 'busy'])
  test(`an actual installer ${scenario} error keeps the verified download ready to retry`, async (t) => {
    const { service, dir } = await setup(t);
    const { MacUpdateInstaller } = require('../core/update-installer.cjs');
    await service.check();
    await service.download();
    const downloaded = service.downloaded,
      originalInstaller = service.installer;
    const installer = new MacUpdateInstaller({
      dataDir: dir,
      currentBundle: path.join(dir, 'Folio.app'),
      helperPath: path.join(dir, 'helper'),
      currentVersion: service.currentVersion,
      arch: 'arm64',
    });
    if (scenario === 'busy') installer.busy = true;
    else {
      const prepare = installer.prepare.bind(installer);
      installer.prepare = (args) => {
        service.controller.abort();
        return prepare(args);
      };
    }
    service.installer = installer;
    const { requestId } = service.beginInstall();
    const error = await service.commitInstall({ requestId, parentPid: 123 }).catch((e) => e);
    const status = service.snapshot();
    const code = scenario === 'busy' ? 'UPDATE_BUSY' : 'UPDATE_CANCELED';
    assert.equal(status.phase, 'ready');
    assert.equal(status.errorCode, code);
    assert.equal(error.code, code);
    assert.equal(error.cause.code, code);
    assert.equal(error.message, status.message);
    assert.match(status.message, /重试安装/);
    assert.doesNotMatch(status.message, /重新下载|损坏|校验失败/);
    assert.equal(service.downloaded, downloaded);
    assert.equal(service.ticket, null);
    assert.equal(service.controller, null);
    // Existing ready-state controls can retry the same verified archive.
    service.installer = originalInstaller;
    const retry = service.beginInstall();
    await service.commitInstall({ ...retry, parentPid: 123 });
    assert.equal(service.snapshot().phase, 'installing');
    assert.equal(service.snapshot().errorCode, undefined);
    assert.equal(service.downloaded, downloaded);
  });

test('installer failures publish actionable status and matching safe IPC errors', async (t) => {
  const scenarios = [
    {
      name: 'permission',
      code: 'EACCES',
      diagnostic: 'Permission denied: /private/example/Folio.app',
      publicCode: 'PERMISSION',
      phase: 'ready',
      message: '没有权限写入更新位置。请将 Folio 放在可写的应用程序文件夹后重试。',
    },
    {
      name: 'permission policy',
      code: 'EPERM',
      diagnostic: 'Operation not permitted: /private/example/Folio.app',
      publicCode: 'PERMISSION',
      phase: 'ready',
      message: '没有权限写入更新位置。请将 Folio 放在可写的应用程序文件夹后重试。',
    },
    {
      name: 'disk full',
      code: 'ENOSPC',
      diagnostic: 'No space left on /private/example',
      publicCode: 'DISK_FULL',
      phase: 'ready',
      message: '可用空间不足，请释放磁盘空间后重试。',
    },
    {
      name: 'installation location',
      code: 'UPDATE_INSTALL',
      diagnostic: '请先将 Folio 安装到可写的应用程序目录。',
      phase: 'ready',
      message: '请先将 Folio 移到本机可写的应用程序文件夹，再重试安装更新。',
    },
    {
      name: 'package verification',
      code: 'UPDATE_INSTALL',
      diagnostic: '安装包 SHA256 校验失败。',
      phase: 'error',
      message: '安装包未通过安全校验，原应用保持不变。请重新下载更新；若仍失败，请查看发布页面。',
    },
    {
      name: 'installer helper launch',
      stage: 'launch',
      code: 'UPDATE_INSTALL',
      diagnostic: '更新助手未能启动。',
      phase: 'error',
      message:
        '更新安装助手未能启动或通过检查，原应用保持不变。请重新打开 Folio 后重试；若仍失败，请从发布页面手动安装。',
    },
    {
      name: 'unknown installer diagnostic',
      code: 'UPDATE_INSTALL',
      diagnostic: '安装包 SHA256 校验失败。 /private/example github_pat_' + 'a'.repeat(30),
      phase: 'error',
      message: '更新未完成，原应用已保留，请重试。',
    },
    {
      name: 'unknown update error',
      code: 'UPDATE_FUTURE_FAILURE',
      diagnostic: 'Failed at /private/example with sk-' + 'b'.repeat(30),
      phase: 'error',
      message: '更新未完成，原应用已保留，请重试。',
    },
  ];
  for (const scenario of scenarios)
    await t.test(scenario.name, async (t) => {
      const { service, calls } = await setup(t);
      await service.check();
      await service.download();
      const original = Object.assign(Error(scenario.diagnostic), { code: scenario.code });
      service.installer[scenario.stage || 'prepare'] = async () => {
        throw original;
      };
      const ticket = service.beginInstall();
      const rejection = await service.commitInstall({ ...ticket, parentPid: 123 }).catch((e) => e);
      const status = service.snapshot();
      assert.equal(status.phase, scenario.phase);
      assert.equal(status.errorCode, scenario.publicCode || scenario.code);
      assert.equal(status.message, scenario.message);
      assert.equal(rejection.message, status.message);
      assert.equal(rejection.code, scenario.code);
      assert.equal(rejection.cause, original);
      assert.equal(original.message, scenario.diagnostic);
      assert.doesNotMatch(
        JSON.stringify(status) + rejection.message,
        /private\/example|github_pat_|sk-/,
      );
      assert.equal(calls.abort, scenario.stage === 'launch' ? 1 : 0);
      if (scenario.phase === 'error')
        assert.throws(() => service.beginInstall(), { code: 'NOT_READY' });
    });
});

test('main-process update gate rejects stale windows, file changes and new writes', () => {
  const { UpdateGate } = require('../core/update-gate.cjs'),
    gate = new UpdateGate();
  const saving = gate.enter('save');
  assert.throws(() => gate.begin('first', 'window-a'));
  saving();
  gate.begin('first', 'window-a');
  assert.throws(() => gate.enter('save'));
  const draft = gate.enter('draft-put');
  assert.equal(gate.valid('first', 'window-a'), false);
  draft();
  assert.equal(gate.valid('first', 'window-a'), true);
  assert.equal(gate.valid('first', 'window-b'), false);
  gate.commit('first', 'window-a');
  assert.throws(() => gate.enter('draft-put'));
  gate.changed();
  assert.equal(gate.valid('first', 'window-a'), false);
  gate.cancel('old');
  assert(gate.ticket);
  gate.cancel('first');
  assert.equal(gate.ticket, null);
});
test('an unanswered install ticket expires instead of freezing edits and quit', () => {
  const { UpdateGate } = require('../core/update-gate.cjs');
  let clock = 1000;
  const gate = new UpdateGate({ now: () => clock, ttl: 500 });
  gate.begin('first', 'window-a');
  assert(gate.activeTicket(), 'the ticket holds while the renderer is answering');
  assert.throws(() => gate.enter('save'));
  clock += 501;
  // A renderer that stopped answering never commits and never aborts. Editing and
  // quitting have to recover on their own.
  assert.equal(gate.activeTicket(), null);
  assert.equal(gate.valid('first', 'window-a'), false);
  const saving = gate.enter('save');
  saving();
  gate.begin('second', 'window-a');
  assert(gate.activeTicket());
});
test('a ticket being committed is never dropped by its deadline', () => {
  const { UpdateGate } = require('../core/update-gate.cjs');
  let clock = 1000;
  const gate = new UpdateGate({ now: () => clock, ttl: 500 });
  gate.begin('first', 'window-a');
  gate.commit('first', 'window-a');
  clock += 5000;
  // The bundle swap is already under way; expiring here would let a write land
  // against an application that is being replaced.
  assert(gate.activeTicket());
  assert.throws(() => gate.enter('save'));
});
test('expired preparation clears both the gate and service and permits a fresh install', async (t) => {
  const { service, calls } = await setup(t);
  await service.check();
  await service.download();
  const { UpdateGate } = require('../core/update-gate.cjs');
  let clock = 1000;
  const gate = new UpdateGate({
    now: () => clock,
    ttl: 500,
    onExpire: ({ requestId }) => service.expireInstall(requestId),
  });
  t.after(() => gate.cancel());
  const first = service.beginInstall();
  gate.begin(first.requestId, 'window-a');
  clock += 501;
  assert.throws(() => gate.commit(first.requestId, 'window-a'), {
    code: 'UPDATE_DOCUMENT_CHANGED',
  });
  assert.equal(gate.ticket, null);
  assert.equal(service.ticket, null);
  assert.equal(service.snapshot().phase, 'ready');
  assert.doesNotThrow(() => service.cancel());
  const second = service.beginInstall();
  assert.notEqual(second.requestId, first.requestId);
  gate.begin(second.requestId, 'window-a');
  // A late timeout or abort from the old request cannot clear the new one.
  assert.equal(service.expireInstall(first.requestId), false);
  await service.abortInstall(first.requestId);
  assert.equal(service.ticket.requestId, second.requestId);
  assert.equal(gate.valid(second.requestId, 'window-b'), false);
  gate.commit(second.requestId, 'window-a');
  await service.commitInstall({
    requestId: second.requestId,
    parentPid: 1,
    guard: () => gate.valid(second.requestId, 'window-a'),
  });
  assert.equal(calls.launch, 1);
  assert.equal(service.expireInstall(second.requestId), false);
  assert.equal(service.snapshot().phase, 'installing');
});
test('preparation expiry recovers the service without another renderer request', async (t) => {
  const { service } = await setup(t);
  await service.check();
  await service.download();
  const { UpdateGate } = require('../core/update-gate.cjs');
  let recover;
  const recovered = new Promise((resolve) => {
    recover = resolve;
  });
  const gate = new UpdateGate({
    ttl: 20,
    onExpire: ({ requestId }) => {
      service.expireInstall(requestId);
      recover();
    },
  });
  t.after(() => gate.cancel());
  const { requestId } = service.beginInstall();
  gate.begin(requestId, 'window-a');
  let timeout;
  try {
    await Promise.race([
      recovered,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error('Expiry did not notify the update service.')),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(gate.ticket, null);
  assert.equal(service.ticket, null);
  assert.equal(service.snapshot().phase, 'ready');
});
test('canceling an active download removes its partial archive and permits retry', async (t) => {
  const { service, dir } = await setup(t);
  let started;
  const waiting = new Promise((resolve) => (started = resolve)),
    original = service.source.asset;
  service.source.asset = async (asset, options = {}) => {
    if (!options.destination) return original(asset, options);
    await fs.writeFile(options.destination, 'partial');
    started();
    await new Promise((resolve, reject) =>
      options.signal.addEventListener(
        'abort',
        () => reject(Object.assign(Error('cancel'), { code: 'CANCELED' })),
        { once: true },
      ),
    );
  };
  await service.check();
  const downloading = service.download();
  await waiting;
  service.cancel();
  assert.equal((await downloading).phase, 'available');
  assert.deepEqual(await fs.readdir(path.join(dir, 'updates/downloads')), []);
  service.source.asset = original;
  assert.equal((await service.download()).phase, 'ready');
});
test('a finished update names its version through the dictionary, not by concatenation', async (t) => {
  const { service } = await setup(t);
  service.installer.readResult = async () => ({ status: 'confirmed', version: '0.4.0-beta.3' });
  const status = await service.status();
  // The version travels beside the message. Joining them here would leave a string
  // that matches no dictionary entry, so an English window would read it in Chinese.
  assert.equal(status.message, '已更新到 {version}。');
  assert.deepEqual(status.messageVars, { version: '0.4.0-beta.3' });
  const english = require('../src/translations.en.json')[status.message];
  assert.equal(
    english.replace('{version}', status.messageVars.version),
    'Updated to 0.4.0-beta.3.',
  );
  // A later message arrives without values and must not keep the version behind it.
  assert.equal((await service.check()).messageVars, undefined);
});
test('a damaged old install receipt does not block finding a new release', async (t) => {
  const { service } = await setup(t);
  service.installer.readResult = async () => {
    throw Error('generated damaged receipt');
  };
  assert.equal((await service.status()).phase, 'idle');
  assert.equal((await service.check()).phase, 'available');
});
test('aborted preparation must settle before a new install request can begin', async (t) => {
  let entered, release;
  const started = new Promise((r) => (entered = r)),
    wait = new Promise((r) => (release = r));
  const { service } = await setup(t, {
    prepare: async () => {
      entered();
      await wait;
    },
  });
  await service.check();
  await service.download();
  const first = service.beginInstall();
  const commit = service.commitInstall({ ...first, parentPid: 1 }).catch((e) => e);
  await started;
  await service.abortInstall(first.requestId);
  assert.throws(() => service.beginInstall(), { code: 'NOT_READY' });
  release();
  assert.equal((await commit).code, 'STALE_REQUEST');
  assert.equal(service.ticket, null);
});

test('a consumed ticket does not expire during slow extraction, while document guards remain active', async (t) => {
  const { service, calls } = await setup(t);
  await service.check();
  await service.download();
  const { requestId } = service.beginInstall();
  const prepare = service.installer.prepare;
  service.installer.prepare = async (args) => {
    const result = await prepare(args);
    service.ticket.expires = 0;
    return result;
  };
  await service.commitInstall({ requestId, parentPid: process.pid });
  assert.equal(calls.launch, 1);
  assert.equal(calls.abort, 0);
});

test('an unconfirmed startup explains the retained backup instead of silently looking idle', async (t) => {
  const { service } = await setup(t);
  service.installer.readResult = async () => ({ status: 'awaiting-confirmation' });
  const status = await service.status();
  assert.match(status.message, /启动确认/);
  assert.match(status.message, /备份/);
});
