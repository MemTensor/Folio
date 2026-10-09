import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { readdirSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const { MacUpdateInstaller, MAX_EXPANDED, MAX_ENTRIES } = require('../core/update-installer.cjs');
const { machoArchitectures } = require('../core/update-bundle.cjs');
const run = promisify(execFile);
const oldVersion = '0.4.0-beta.3',
  nextVersion = '0.4.0-beta.4';
const info = (version) => ({
  CFBundleIdentifier: 'io.folio.markdown',
  CFBundleExecutable: 'Folio',
  CFBundleShortVersionString: version,
  CFBundleVersion: version,
});
function executable(arch = 'arm64') {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf);
  header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  header.writeUInt32LE(2, 12);
  return header;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries, zip64 = false) {
  const local = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.data || ''),
      compressed = deflateRawSync(data),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.size ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const meta = Buffer.alloc(46);
    meta.writeUInt32LE(0x02014b50);
    meta.writeUInt16LE(0x0314, 4);
    meta.writeUInt16LE(20, 6);
    meta.writeUInt16LE(8, 10);
    meta.writeUInt32LE(crc, 16);
    meta.writeUInt32LE(compressed.length, 20);
    meta.writeUInt32LE(entry.size ?? data.length, 24);
    meta.writeUInt16LE(name.length, 28);
    meta.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    meta.writeUInt32LE(offset, 42);
    central.push(meta, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (!zip64) return Buffer.concat([...local, directory, end]);
  const extended = Buffer.alloc(56),
    locator = Buffer.alloc(20);
  extended.writeUInt32LE(0x06064b50);
  extended.writeBigUInt64LE(44n, 4);
  extended.writeUInt16LE(45, 12);
  extended.writeUInt16LE(45, 14);
  extended.writeBigUInt64LE(BigInt(entries.length), 24);
  extended.writeBigUInt64LE(BigInt(entries.length), 32);
  extended.writeBigUInt64LE(BigInt(directory.length), 40);
  extended.writeBigUInt64LE(BigInt(offset), 48);
  locator.writeUInt32LE(0x07064b50);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([...local, directory, extended, locator, end]);
}
function bundleEntries(version = nextVersion, changes = {}) {
  return [
    {
      name: 'Folio.app/Contents/Info.plist',
      data: JSON.stringify({ ...info(version), ...changes }),
    },
    {
      name: 'Folio.app/Contents/MacOS/Folio',
      data: executable(),
      mode: 0o100755,
    },
    { name: 'Folio.app/Contents/Resources/app.asar', data: 'generated archive fixture' },
    { name: 'Folio.app/Contents/Resources/cli/folio.cjs', data: 'generated CLI fixture' },
  ];
}
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-installer-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const currentBundle = path.join(directory, 'Folio.app'),
    dataDir = path.join(directory, 'state'),
    helperPath = path.join(directory, 'helper');
  for (const entry of bundleEntries(oldVersion)) {
    const file = path.join(directory, entry.name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entry.data, { mode: entry.mode & 0o777 || 0o644 });
  }
  await fs.chmod(path.join(currentBundle, 'Contents/MacOS/Folio'), 0o755);
  if (options.architecture)
    await fs.writeFile(path.join(currentBundle, 'Contents/MacOS/Folio'), executable('x64'));
  await fs.writeFile(helperPath, '#!/bin/sh\nprintf "READY\\n"\n', { mode: 0o700 });
  const calls = [];
  const runner = async (binary, args) => {
    calls.push({ binary, args });
    if (binary.endsWith('/plutil')) return { stdout: await fs.readFile(args.at(-1), 'utf8') };
    if (binary.endsWith('/codesign')) {
      if (args[0] === '--verify') {
        if (options.invalidSignature) throw Error('signature invalid');
        return { stdout: '' };
      }
      const team = args.at(-1) === currentBundle ? options.currentTeam : options.newTeam;
      return { stderr: 'TeamIdentifier=' + (team || 'not set') + '\n' };
    }
    if (binary.endsWith('/xattr')) {
      if (options.quarantine) return { stdout: args[0] === '-px' ? '303038313b466f6c696f' : '' };
      throw Object.assign(Error('missing attribute'), {
        code: 1,
        stderr: 'No such xattr: com.apple.quarantine',
      });
    }
    throw Error('Unexpected process in test: ' + binary);
  };
  const installer = new MacUpdateInstaller({
    dataDir,
    currentBundle,
    helperPath,
    currentVersion: oldVersion,
    arch: 'arm64',
    runner,
  });
  async function archive(entries = bundleEntries(), zip64 = false) {
    const archivePath = path.join(directory, randomUUID() + '.zip'),
      bytes = zip(entries, zip64);
    await fs.writeFile(archivePath, bytes);
    return {
      archivePath,
      version: nextVersion,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return { directory, currentBundle, dataDir, helperPath, installer, calls, archive };
}
async function assertUnchanged(f) {
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.currentBundle, 'Contents/Info.plist'))),
    info(oldVersion),
  );
  assert(!(await fs.readdir(f.directory)).some((name) => name.startsWith('.folio-update-')));
}

test('verified app extracts internal framework symlinks last and abort preserves installed app', async (t) => {
  const f = await fixture(t),
    progress = [];
  const archive = await f.archive([
    ...bundleEntries(),
    { name: 'Folio.app/Contents/Frameworks/Example/Versions/A/data', data: 'framework' },
    { name: 'Folio.app/Contents/Frameworks/Example/Versions/Current', data: 'A', mode: 0o120777 },
  ]);
  const prepared = await f.installer.prepare({
    ...archive,
    onProgress: (event) => progress.push(event.phase),
  });
  assert.equal(
    await fs.readFile(
      path.join(prepared.stagePath, 'Contents/Frameworks/Example/Versions/Current/data'),
      'utf8',
    ),
    'framework',
  );
  assert.equal(prepared.stageIdentity.dev, prepared.targetIdentity.dev);
  assert(
    progress.includes('verifying') &&
      progress.includes('extracting') &&
      progress.includes('validating'),
  );
  await f.installer.abort(prepared);
  await assertUnchanged(f);
});

test('wrong SHA256 or size never changes the installed application', async (t) => {
  for (const field of ['sha256', 'size']) {
    const f = await fixture(t),
      archive = await f.archive();
    await assert.rejects(
      f.installer.prepare({
        ...archive,
        [field]: field === 'size' ? archive.size + 1 : '0'.repeat(64),
      }),
    );
    await assertUnchanged(f);
  }
});

test('ZIP64 archives retain the same size and path restrictions', async (t) => {
  const f = await fixture(t),
    prepared = await f.installer.prepare(await f.archive(undefined, true));
  assert.equal(prepared.version, nextVersion);
  await f.installer.abort(prepared);
  await assertUnchanged(f);
});

test('a symlinked installation target is rejected before staging', async (t) => {
  const f = await fixture(t),
    link = path.join(f.directory, 'Linked.app');
  await fs.symlink(f.currentBundle, link, 'dir');
  f.installer.currentBundle = link;
  await assert.rejects(f.installer.prepare(await f.archive()));
  await assertUnchanged(f);
});

test('archive traversal, symlink ancestors, external links and special files are refused', async (t) => {
  for (const extra of [
    [{ name: '../escape', data: 'no' }],
    [{ name: '/absolute', data: 'no' }],
    [{ name: 'Folio.app/Contents/link', data: '../..', mode: 0o120777 }],
    [
      { name: 'Folio.app/Contents/link', data: 'Resources', mode: 0o120777 },
      { name: 'Folio.app/Contents/link/injected', data: 'no' },
    ],
    [{ name: 'Folio.app/Contents/device', mode: 0o020644 }],
    [{ name: 'Folio.app/Contents/Info.plist', data: 'collision' }],
  ]) {
    const f = await fixture(t);
    await assert.rejects(f.installer.prepare(await f.archive([...bundleEntries(), ...extra])));
    await assertUnchanged(f);
  }
});

test('expanded byte and entry count limits stop extraction', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.installer.prepare(
      await f.archive([{ name: 'Folio.app/huge', data: 'a', size: MAX_EXPANDED + 1 }]),
    ),
  );
  await assertUnchanged(f);
  const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ name: 'Folio.app/file-' + i }));
  await assert.rejects(f.installer.prepare(await f.archive(many)));
  await assertUnchanged(f);
});

test('wrong bundle identity, version or architecture never reaches launch', async (t) => {
  for (const changes of [
    { CFBundleIdentifier: 'other.app' },
    { CFBundleShortVersionString: '99.0.0' },
    { CFBundleExecutable: '../other' },
  ]) {
    const f = await fixture(t);
    await assert.rejects(f.installer.prepare(await f.archive(bundleEntries(nextVersion, changes))));
    await assertUnchanged(f);
  }
  const f = await fixture(t, { architecture: 'x86_64' });
  await assert.rejects(f.installer.prepare(await f.archive()));
  await assertUnchanged(f);
});

test('preparation cancellation removes only the owned staging app and transaction', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await assert.rejects(
    f.installer.prepare({
      ...(await f.archive()),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'extracting') controller.abort();
      },
    }),
    { code: 'UPDATE_CANCELED' },
  );
  await assertUnchanged(f);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'updates')), []);
});

test('failed preparation does not delete an externally replaced staging directory', async (t) => {
  const f = await fixture(t),
    archive = await f.archive();
  let replacement;
  await assert.rejects(
    f.installer.prepare({
      ...archive,
      onProgress: (event) => {
        if (event.phase !== 'verifying' || event.completed !== 0) return;
        replacement = path.join(
          f.directory,
          readdirSync(f.directory).find((name) => name.startsWith('.folio-update-')),
        );
        renameSync(replacement, replacement + '.owned');
        mkdirSync(replacement);
        writeFileSync(path.join(replacement, 'user-data'), 'must survive');
        throw Error('stop after replacement');
      },
    }),
  );
  assert.equal(await fs.readFile(path.join(replacement, 'user-data'), 'utf8'), 'must survive');
});

test('existing publisher identity requires a valid candidate with the same Team ID', async (t) => {
  const f = await fixture(t, { currentTeam: 'ABCDEFGHIJ', newTeam: 'KLMNOPQRST' });
  await assert.rejects(f.installer.prepare(await f.archive()));
  await assertUnchanged(f);
  const g = await fixture(t, { currentTeam: 'ABCDEFGHIJ', newTeam: 'ABCDEFGHIJ' });
  const ready = await g.installer.prepare(await g.archive());
  assert.equal(ready.expectedTeam, 'ABCDEFGHIJ');
  assert(
    g.calls.some((call) => call.binary.endsWith('codesign') && call.args.includes('--strict')),
  );
  await g.installer.abort(ready);
  const h = await fixture(t, {
    currentTeam: 'ABCDEFGHIJ',
    newTeam: 'ABCDEFGHIJ',
    invalidSignature: true,
  });
  await assert.rejects(h.installer.prepare(await h.archive()));
  await assertUnchanged(h);
});

test('late bundle replacement invalidates a prepared install', async (t) => {
  const f = await fixture(t),
    prepared = await f.installer.prepare(await f.archive());
  const moved = prepared.stagePath + '.moved';
  await fs.rename(prepared.stagePath, moved);
  await fs.cp(moved, prepared.stagePath, { recursive: true });
  await assert.rejects(
    f.installer.launch(prepared, { requestId: randomUUID(), parentPid: process.pid }),
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.currentBundle, 'Contents/Info.plist'))),
    info(oldVersion),
  );
});

test('in-place changes to unsigned app content are rejected even when the directory inode is unchanged', async (t) => {
  for (const relative of ['Contents/Resources/app.asar', 'Contents/Resources/cli/folio.cjs']) {
    const f = await fixture(t),
      prepared = await f.installer.prepare(await f.archive());
    const before = await fs.stat(prepared.stagePath, { bigint: true });
    await fs.appendFile(path.join(prepared.stagePath, relative), 'corrupted');
    assert.equal((await fs.stat(prepared.stagePath, { bigint: true })).ino, before.ino);
    await assert.rejects(
      f.installer.launch(prepared, { requestId: randomUUID(), parentPid: process.pid }),
      /应用包在准备后发生变化/,
    );
    await f.installer.abort(prepared);
    await assertUnchanged(f);
  }
});

test('trusted helper is hashed before and after copying', async (t) => {
  const f = await fixture(t),
    prepared = await f.installer.prepare(await f.archive()),
    original = fs.copyFile;
  fs.copyFile = async (from, to, flags) => {
    await original(from, to, flags);
    if (path.basename(to) === 'installer') await fs.appendFile(to, 'corrupted');
  };
  try {
    await assert.rejects(
      f.installer.launch(prepared, { requestId: randomUUID(), parentPid: process.pid }),
      /更新助手在复制期间发生变化/,
    );
  } finally {
    fs.copyFile = original;
  }
  await f.installer.abort(prepared);
  await assertUnchanged(f);
});

test('failed helper startup removes only its matching current transaction marker', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.helperPath, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  const prepared = await f.installer.prepare(await f.archive());
  await assert.rejects(
    f.installer.launch(prepared, { requestId: randomUUID(), parentPid: process.pid }),
  );
  await assert.rejects(fs.stat(f.installer.currentFile), { code: 'ENOENT' });
  await f.installer.abort(prepared);
  await assertUnchanged(f);
});

test('missing historical transaction directories return no result', async (t) => {
  const f = await fixture(t),
    prepared = await f.installer.prepare(await f.archive());
  await fs.writeFile(
    f.installer.currentFile,
    JSON.stringify({
      id: prepared.id,
      nonce: prepared.nonce,
      version: prepared.version,
      transactionDir: prepared.transactionDir,
    }),
  );
  await fs.rm(prepared.transactionDir, { recursive: true });
  assert.equal(await f.installer.readResult(), null);
});

test('Mach-O architecture detection supports thin and universal files without developer tools', async (t) => {
  const f = await fixture(t),
    file = path.join(f.directory, 'universal');
  const fat = Buffer.alloc(112);
  fat.writeUInt32BE(0xcafebabe);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x0100000c, 8);
  fat.writeUInt32BE(48, 16);
  fat.writeUInt32BE(32, 20);
  fat.writeUInt32BE(0x01000007, 28);
  fat.writeUInt32BE(80, 36);
  fat.writeUInt32BE(32, 40);
  executable('arm64').copy(fat, 48);
  executable('x64').copy(fat, 80);
  await fs.writeFile(file, fat);
  assert.deepEqual(await machoArchitectures(file), ['arm64', 'x64']);
  fat.writeUInt32BE(10000, 36);
  await fs.writeFile(file, fat);
  await assert.rejects(machoArchitectures(file));
  await fs.writeFile(file, executable());
  assert.deepEqual(await machoArchitectures(file), ['arm64']);
  assert(!f.calls.some((call) => call.binary.endsWith('/lipo')));
});

test('download quarantine is copied to the staged app and never removed', async (t) => {
  const f = await fixture(t, { quarantine: true });
  const prepared = await f.installer.prepare(await f.archive());
  assert(
    f.calls.some(
      (call) =>
        call.binary.endsWith('/xattr') &&
        call.args[0] === '-wx' &&
        call.args.at(-1) === prepared.stagePath,
    ),
  );
  assert(
    !f.calls.some(
      (call) =>
        call.binary.endsWith('/xattr') && call.args.some((arg) => arg === '-d' || arg === '-c'),
    ),
  );
  await f.installer.abort(prepared);
});

test('launch uses a copied trusted helper; cancellation keeps its plan and writes a marker', async (t) => {
  const f = await fixture(t),
    prepared = await f.installer.prepare(await f.archive()),
    requestId = randomUUID();
  const result = await f.installer.launch(prepared, { requestId, parentPid: process.pid });
  assert(result.helperPid > 0);
  await f.installer.abort(prepared);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(prepared.transactionDir, 'cancel.json'))).nonce,
    prepared.nonce,
  );
  assert.equal(JSON.parse(await fs.readFile(prepared.planPath)).requestId, requestId);
  assert.equal(
    await fs.readFile(path.join(prepared.transactionDir, 'installer'), 'utf8'),
    await fs.readFile(f.helperPath, 'utf8'),
  );
});

test('startup ACK is bound to the installed inode, version and nonce', async (t) => {
  const f = await fixture(t),
    prepared = await f.installer.prepare(await f.archive());
  await f.installer.launch(prepared, { requestId: randomUUID(), parentPid: process.pid });
  const receipt = path.join(prepared.transactionDir, 'receipt.json');
  await fs.writeFile(
    receipt,
    JSON.stringify({
      nonce: prepared.nonce,
      status: 'installed',
      code: 'WAITING_STARTUP',
      backupAvailable: true,
    }),
  );
  assert.equal(await f.installer.acknowledgeStartup(oldVersion), false);
  const backup = prepared.targetPath + '.swap';
  await fs.rename(prepared.targetPath, backup);
  await fs.rename(prepared.stagePath, prepared.targetPath);
  await fs.rename(backup, prepared.stagePath);
  assert.equal(await f.installer.acknowledgeStartup(nextVersion), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(prepared.transactionDir, 'ack.json'))), {
    nonce: prepared.nonce,
    version: nextVersion,
  });
  assert.equal((await f.installer.readResult()).backupAvailable, true);
});

test(
  'native helper atomically swaps and rolls back generated directories without executing either app',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'folio-native-swap-')),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = path.resolve('electron/update-helper.m'),
      harness = path.join(directory, 'harness.m'),
      binary = path.join(directory, 'swap-check');
    await fs.writeFile(
      harness,
      '#define FOLIO_UPDATE_HELPER_TESTING 1\n#import ' +
        JSON.stringify(source) +
        '\nint main(int argc, const char **argv) { @autoreleasepool { NSDictionary *p=ReadJSON(@(argv[1])); if(argc>2 && strcmp(argv[2],"verify")==0)return VerifyManifest(p)?0:4; if(argc>2 && strcmp(argv[2],"prune")==0)return PruneBackup(@(argv[1]))?0:5; if(!SwapBundles(p,NO))return 2; if(argc>2 && strcmp(argv[2],"install")==0)return 0; if(!SwapBundles(p,YES))return 3; return 0; }}\n',
    );
    await run('/usr/bin/clang', [
      '-fobjc-arc',
      '-mmacosx-version-min=13.0',
      '-framework',
      'Foundation',
      '-framework',
      'AppKit',
      '-framework',
      'Security',
      harness,
      '-o',
      binary,
    ]);
    const target = path.join(directory, 'Folio.app'),
      stage = path.join(directory, '.stage.app');
    await fs.mkdir(target);
    await fs.mkdir(stage);
    await fs.writeFile(path.join(target, 'old'), 'old');
    await fs.writeFile(path.join(stage, 'new'), 'new');
    const identity = async (file) => {
      const s = await fs.lstat(file, { bigint: true });
      return { dev: String(s.dev), ino: String(s.ino) };
    };
    const plan = path.join(directory, 'plan.json');
    await fs.writeFile(
      plan,
      JSON.stringify({
        targetPath: target,
        stagePath: stage,
        targetIdentity: await identity(target),
        stageIdentity: await identity(stage),
      }),
      { mode: 0o600 },
    );
    await run(binary, [plan]);
    assert.equal(await fs.readFile(path.join(target, 'old'), 'utf8'), 'old');
    assert.equal(await fs.readFile(path.join(stage, 'new'), 'utf8'), 'new');

    const manifestFixture = await fixture(t),
      prepared = await manifestFixture.installer.prepare(await manifestFixture.archive());
    await fs.writeFile(prepared.planPath, JSON.stringify(prepared), { mode: 0o600 });
    await run(binary, [prepared.planPath, 'verify']);
    await fs.appendFile(
      path.join(prepared.stagePath, 'Contents/Resources/app.asar'),
      'native-detects-corruption',
    );
    await assert.rejects(run(binary, [prepared.planPath, 'verify']), (error) => error.code === 4);
    await manifestFixture.installer.abort(prepared);

    const pruneFixture = await fixture(t),
      prunePlan = await pruneFixture.installer.prepare(await pruneFixture.archive());
    await pruneFixture.installer.launch(prunePlan, {
      requestId: randomUUID(),
      parentPid: process.pid,
    });
    const oldPlist = path.join(prunePlan.targetPath, 'Contents/Info.plist');
    await run('/usr/bin/plutil', ['-convert', 'xml1', oldPlist]);
    const appSource = path.join(directory, 'fixture.c');
    await fs.writeFile(appSource, 'int main(void) { return 0; }\n');
    await run('/usr/bin/clang', [
      '-arch',
      'arm64',
      appSource,
      '-o',
      path.join(prunePlan.targetPath, 'Contents/MacOS/Folio'),
    ]);
    await run(binary, [prunePlan.planPath, 'install']);
    const receipt = path.join(prunePlan.transactionDir, 'receipt.json');
    await fs.writeFile(
      receipt,
      JSON.stringify({
        nonce: prunePlan.nonce,
        status: 'awaiting-confirmation',
        code: 'STARTUP_UNCONFIRMED',
        backupAvailable: true,
      }),
    );
    await assert.rejects(run(binary, [prunePlan.planPath, 'prune']), (error) => error.code === 5);
    assert((await fs.stat(prunePlan.stagePath)).isDirectory());
    await fs.writeFile(
      receipt,
      JSON.stringify({
        nonce: prunePlan.nonce,
        status: 'confirmed',
        code: 'CONFIRMED',
        backupAvailable: true,
      }),
    );
    await run(binary, [prunePlan.planPath, 'prune']);
    await assert.rejects(fs.stat(prunePlan.stagePath), { code: 'ENOENT' });
    assert((await fs.stat(prunePlan.targetPath)).isDirectory());
  },
);
