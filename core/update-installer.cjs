const { promises: fs, constants, createWriteStream } = require('./update-fs.cjs');
const { Readable } = require('node:stream');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { writeJSON, readJSON } = require('./state.cjs');
const {
  sha256File,
  machoArchitectures,
  bundleManifest,
  verifyManifest,
  MAX_MANIFEST_BYTES,
} = require('./update-bundle.cjs');

const BUNDLE_ID = 'io.folio.markdown';
const MAX_ENTRIES = 20000;
const MAX_EXPANDED = 2 * 1024 ** 3;
const MAX_ARCHIVE = 1024 ** 3;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UUID = /^[a-f0-9-]{36}$/;
const RECEIPT_CODES = new Set([
  'WAITING_EXIT',
  'WAITING_STARTUP',
  'CONFIRMED',
  'PARENT_TIMEOUT',
  'APP_BUSY',
  'INVALID_PLAN',
  'BUNDLE_CHANGED',
  'SWAP_FAILED',
  'LAUNCH_FAILED',
  'STARTUP_FAILED',
  'STARTUP_UNCONFIRMED',
  'ROLLBACK_FAILED',
  'INTERNAL_ERROR',
  'CANCELED',
]);
const STATUSES = new Set([
  'waiting-exit',
  'installed',
  'confirmed',
  'rolled-back',
  'failed',
  'awaiting-confirmation',
]);
const fail = (message, code = 'UPDATE_INSTALL') => Object.assign(Error(message), { code });
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
function aborted(signal) {
  if (signal?.aborted) throw fail('更新准备已取消。', 'UPDATE_CANCELED');
}
function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
async function removeOwned(directory, expected) {
  if (!directory || !expected) return;
  const stat = await fs.lstat(directory, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isDirectory() && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino)
    await fs.rm(directory, { recursive: true, force: true });
}
async function plainDirectory(directory) {
  const resolved = path.resolve(directory);
  const real = await fs.realpath(resolved);
  if (real !== resolved || !(await fs.lstat(resolved)).isDirectory())
    throw fail('更新目录不能使用符号链接。');
  return real;
}
async function hashFile(handle, signal) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (true) {
    aborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}
function openZip(handle, size) {
  // FileHandle owns the descriptor. yauzl may close its reader on malformed ZIPs,
  // so do not give its FdSlicer independent ownership of that same descriptor.
  class Reader extends yauzl.RandomAccessReader {
    _readStreamForRange(start, end) {
      return Readable.from(
        (async function* () {
          let position = start;
          while (position < end) {
            const buffer = Buffer.alloc(Math.min(65536, end - position));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead) throw fail('安装包意外截断。');
            position += bytesRead;
            yield buffer.subarray(0, bytesRead);
          }
        })(),
      );
    }
    read(buffer, offset, length, position, callback) {
      handle
        .read(buffer, offset, length, position)
        .then((result) => callback(null, result.bytesRead, result.buffer), callback);
    }
    close(callback) {
      callback(null);
    }
  }
  return new Promise((resolve, reject) =>
    yauzl.fromRandomAccessReader(
      new Reader(),
      size,
      {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => (error ? reject(error) : resolve(zip)),
    ),
  );
}
function streamEntry(zip, entry) {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream))),
  );
}
function archiveName(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\\]/.test(value)) throw fail('安装包包含无效路径。');
  const name = value.replace(/\/$/, '');
  if (
    !name ||
    path.posix.isAbsolute(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw fail('安装包包含越界路径。');
  if (name !== 'Folio.app' && !name.startsWith('Folio.app/'))
    throw fail('安装包只能包含 Folio.app。');
  return name;
}
async function inspectArchive(zip, signal) {
  let total = 0;
  const entries = [],
    names = new Map();
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.once('end', resolve);
    zip.on('entry', (entry) => {
      try {
        aborted(signal);
        const name = archiveName(entry.fileName),
          folded = name.normalize('NFC').toLowerCase();
        if (names.has(folded)) throw fail('安装包包含重复路径。');
        names.set(folded, name);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff,
          type = mode & 0o170000;
        const directory = entry.fileName.endsWith('/');
        if (entry.generalPurposeBitFlag & 1) throw fail('不支持加密安装包。');
        if (![0, 0o100000, 0o040000, 0o120000].includes(type) || mode & 0o6000)
          throw fail('安装包包含不支持的文件类型。');
        if ((type === 0o040000 && !directory) || (directory && type && type !== 0o040000))
          throw fail('安装包文件类型不一致。');
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0)
          throw fail('安装包大小无效。');
        total += entry.uncompressedSize;
        if (entries.length >= MAX_ENTRIES || total > MAX_EXPANDED)
          throw fail('安装包解压大小或文件数量超出限制。');
        if (type === 0o120000 && entry.uncompressedSize > 4096) throw fail('安装包符号链接过长。');
        entries.push({ entry, name, directory, symlink: type === 0o120000, mode });
        zip.readEntry();
      } catch (error) {
        reject(error);
      }
    });
    zip.readEntry();
  });
  const links = new Set(
    entries.filter((e) => e.symlink).map((e) => e.name.normalize('NFC').toLowerCase()),
  );
  for (const item of entries) {
    const parts = item.name.normalize('NFC').toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++)
      if (links.has(parts.slice(0, i).join('/'))) throw fail('安装包不能向符号链接目录写入文件。');
  }
  return { entries, total };
}
async function unpack(zip, archive, stage, signal, onProgress) {
  let completed = 0;
  const target = (item) => path.join(stage, ...item.name.split('/').slice(1));
  for (const item of archive.entries.filter((e) => !e.symlink)) {
    aborted(signal);
    const dest = target(item);
    if (item.directory) await fs.mkdir(dest, { recursive: true, mode: 0o755 });
    else {
      if (dest === stage) throw fail('Folio.app 必须是目录。');
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
      await pipeline(
        await streamEntry(zip, item.entry),
        createWriteStream(dest, { flags: 'wx', mode: item.mode & 0o111 ? 0o755 : 0o644 }),
        { signal },
      );
      completed += item.entry.uncompressedSize;
      onProgress?.({ phase: 'extracting', completed, total: archive.total });
    }
  }
  // No regular files are extracted after symlink creation.
  const links = [];
  for (const item of archive.entries.filter((e) => e.symlink)) {
    aborted(signal);
    const chunks = [];
    for await (const part of await streamEntry(zip, item.entry)) chunks.push(part);
    const link = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const dest = target(item);
    if (
      !link ||
      /[\x00-\x1f\\]/.test(link) ||
      path.isAbsolute(link) ||
      !inside(stage, path.resolve(path.dirname(dest), link))
    )
      throw fail('安装包包含越界符号链接。');
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
    await fs.symlink(link, dest);
    links.push(dest);
  }
  for (const link of links)
    if (!inside(stage, await fs.realpath(link)))
      throw fail('安装包符号链接必须位于 Folio.app 内。');
}

class MacUpdateInstaller {
  constructor({
    dataDir,
    currentBundle,
    helperPath,
    currentVersion,
    arch,
    runner = promisify(execFile),
  }) {
    this.dataDir = path.resolve(dataDir);
    this.currentBundle = path.resolve(currentBundle);
    this.helperPath = path.resolve(helperPath);
    this.currentVersion = currentVersion;
    this.arch = arch;
    this.runner = runner;
    this.prepared = new Map();
    this.launched = new Map();
    this.busy = false;
    this.directory = path.join(this.dataDir, 'updates');
    this.currentFile = path.join(this.directory, 'installer-current.json');
  }
  async inspectBundle(bundle, version) {
    await plainDirectory(bundle);
    for (const directory of [
      'Contents',
      'Contents/MacOS',
      'Contents/Resources',
      'Contents/Resources/cli',
    ])
      await plainDirectory(path.join(bundle, directory));
    for (const file of [
      'Contents/Info.plist',
      'Contents/MacOS/Folio',
      'Contents/Resources/app.asar',
      'Contents/Resources/cli/folio.cjs',
    ]) {
      const stat = await fs.lstat(path.join(bundle, file));
      if (!stat.isFile() || stat.size === 0) throw fail('安装包缺少必要文件。');
    }
    await fs.access(path.join(bundle, 'Contents/MacOS/Folio'), constants.X_OK);
    const { stdout } = await this.runner(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const info = JSON.parse(stdout);
    if (
      info.CFBundleIdentifier !== BUNDLE_ID ||
      info.CFBundleExecutable !== 'Folio' ||
      info.CFBundleShortVersionString !== version ||
      info.CFBundleVersion !== version
    )
      throw fail('安装包的应用标识或版本不匹配。');
    const executable = path.join(bundle, 'Contents/MacOS/Folio');
    if (!(await machoArchitectures(executable)).includes(this.arch))
      throw fail('安装包架构与当前应用不匹配。');
    let signature;
    try {
      signature = await this.runner('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], {
        timeout: 10000,
        maxBuffer: 65536,
      });
    } catch (error) {
      if (!String(error.stderr).includes('not signed at all')) throw error;
      signature = { stderr: '' };
    }
    const team = /(?:^|\n)TeamIdentifier=([^\r\n]+)/.exec(
      String(signature.stderr || '') + '\n' + String(signature.stdout || ''),
    )?.[1];
    if (team && team !== 'not set' && !/^[A-Z0-9]{10}$/.test(team))
      throw fail('安装包签名信息无效。');
    const teamIdentifier = team && team !== 'not set' ? team : null;
    if (teamIdentifier)
      await this.runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
        timeout: 30000,
        maxBuffer: 65536,
      });
    return { ...identity(await fs.lstat(bundle, { bigint: true })), teamIdentifier };
  }
  async prepare({ archivePath, version, sha256, size, signal, onProgress }) {
    if (this.busy) throw fail('另一个更新操作正在进行。', 'UPDATE_BUSY');
    if (
      !VERSION.test(version) ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_ARCHIVE ||
      !['arm64', 'x64'].includes(this.arch)
    )
      throw fail('更新安装参数无效。');
    this.busy = true;
    let transactionDir, stagePath, handle, zip, transactionIdentity, createdStageIdentity;
    try {
      aborted(signal);
      await this.prunePreviousBackup();
      const targetPath = await plainDirectory(this.currentBundle),
        parent = await plainDirectory(path.dirname(targetPath));
      if (
        !targetPath.endsWith('.app') ||
        targetPath.includes('/AppTranslocation/') ||
        targetPath.startsWith('/Volumes/')
      )
        throw fail('请先将 Folio 安装到可写的应用程序目录。');
      await fs.access(parent, constants.W_OK);
      const targetIdentity = await this.inspectBundle(targetPath, this.currentVersion);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await plainDirectory(this.directory);
      const id = crypto.randomUUID(),
        nonce = crypto.randomBytes(32).toString('hex');
      transactionDir = await fs.mkdtemp(path.join(this.directory, 'install-'));
      transactionIdentity = identity(await fs.lstat(transactionDir, { bigint: true }));
      stagePath = path.join(parent, '.folio-update-' + id + '.app');
      await fs.mkdir(stagePath, { mode: 0o700 });
      createdStageIdentity = identity(await fs.lstat(stagePath, { bigint: true }));
      handle = await fs.open(path.resolve(archivePath), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== size) throw fail('安装包大小不匹配。');
      onProgress?.({ phase: 'verifying', completed: 0, total: size });
      if ((await hashFile(handle, signal)) !== sha256) throw fail('安装包 SHA256 校验失败。');
      onProgress?.({ phase: 'verifying', completed: size, total: size });
      zip = await openZip(handle, size);
      const archive = await inspectArchive(zip, signal);
      await unpack(zip, archive, stagePath, signal, onProgress);
      if ((await hashFile(handle, signal)) !== sha256) throw fail('安装包在解压期间发生变化。');
      // ZIP extraction through Node must not silently drop a download quarantine.
      let quarantine;
      try {
        quarantine = await this.runner(
          '/usr/bin/xattr',
          ['-px', 'com.apple.quarantine', path.resolve(archivePath)],
          { timeout: 5000, maxBuffer: 8192 },
        );
      } catch (error) {
        if (error.code !== 1 || !String(error.stderr).includes('No such xattr')) throw error;
      }
      if (quarantine) {
        const hex = String(quarantine.stdout).replace(/\s/g, '');
        if (!hex || hex.length > 8192 || hex.length % 2 || !/^[a-f0-9]+$/i.test(hex))
          throw fail('安装包隔离属性无效。');
        await this.runner('/usr/bin/xattr', ['-wx', 'com.apple.quarantine', hex, stagePath], {
          timeout: 5000,
          maxBuffer: 8192,
        });
      }
      aborted(signal);
      onProgress?.({ phase: 'validating', completed: 0, total: 1 });
      const stageIdentity = await this.inspectBundle(stagePath, version);
      if (
        stageIdentity.dev !== createdStageIdentity.dev ||
        stageIdentity.ino !== createdStageIdentity.ino
      )
        throw fail('准备中的应用目录被替换。');
      if (
        targetIdentity.teamIdentifier &&
        targetIdentity.teamIdentifier !== stageIdentity.teamIdentifier
      )
        throw fail('新版应用必须由同一开发者签名。');
      if (stageIdentity.dev !== targetIdentity.dev) throw fail('更新必须在同一磁盘卷内进行。');
      await fs.chmod(stagePath, 0o755);
      const transactionNow = identity(await fs.lstat(transactionDir, { bigint: true }));
      if (
        transactionNow.dev !== transactionIdentity.dev ||
        transactionNow.ino !== transactionIdentity.ino
      )
        throw fail('更新事务目录被替换。');
      const manifestPath = path.join(transactionDir, 'manifest.json');
      await writeJSON(manifestPath, await bundleManifest(stagePath, signal));
      if ((await fs.stat(manifestPath)).size > MAX_MANIFEST_BYTES) throw fail('应用校验清单过大。');
      const manifestSHA256 = await sha256File(manifestPath, signal);
      const plan = Object.freeze({
        id,
        nonce,
        version,
        previousVersion: this.currentVersion,
        arch: this.arch,
        dataDir: this.dataDir,
        transactionDir,
        transactionIdentity: Object.freeze(transactionIdentity),
        planPath: path.join(transactionDir, 'plan.json'),
        stagePath,
        targetPath,
        archiveSHA256: sha256,
        archiveSize: size,
        targetIdentity: Object.freeze(targetIdentity),
        stageIdentity: Object.freeze(stageIdentity),
        expectedTeam: targetIdentity.teamIdentifier || stageIdentity.teamIdentifier,
        manifestPath,
        manifestSHA256,
      });
      this.prepared.set(id, plan);
      onProgress?.({ phase: 'validating', completed: 1, total: 1 });
      return plan;
    } catch (error) {
      await removeOwned(stagePath, createdStageIdentity);
      await removeOwned(transactionDir, transactionIdentity);
      if (signal?.aborted || error.name === 'AbortError')
        throw fail('更新准备已取消。', 'UPDATE_CANCELED');
      throw error;
    } finally {
      zip?.close();
      await handle?.close();
      this.busy = false;
    }
  }
  async launch(prepared, { requestId, parentPid }) {
    const plan = this.prepared.get(prepared?.id);
    if (
      plan !== prepared ||
      typeof requestId !== 'string' ||
      !UUID.test(requestId) ||
      !Number.isSafeInteger(parentPid) ||
      parentPid <= 1
    )
      throw fail('更新计划无效，请重新下载。');
    if (this.busy) throw fail('另一个更新操作正在进行。', 'UPDATE_BUSY');
    this.busy = true;
    try {
      await verifyManifest(plan.stagePath, plan.manifestPath, plan.manifestSHA256);
      if (
        JSON.stringify(await this.inspectBundle(plan.stagePath, plan.version)) !==
          JSON.stringify(plan.stageIdentity) ||
        JSON.stringify(await this.inspectBundle(plan.targetPath, plan.previousVersion)) !==
          JSON.stringify(plan.targetIdentity)
      )
        throw fail('应用包在准备后发生变化。');
      const source = await fs.lstat(this.helperPath);
      if (!source.isFile()) throw fail('更新安装助手不可用。');
      const helper = path.join(plan.transactionDir, 'installer');
      const helperSHA256 = await sha256File(this.helperPath);
      await fs.copyFile(this.helperPath, helper, constants.COPYFILE_EXCL);
      await fs.chmod(helper, 0o700);
      if ((await sha256File(helper)) !== helperSHA256) throw fail('更新助手在复制期间发生变化。');
      const executablePlan = { ...plan, requestId, parentPid, bundleId: BUNDLE_ID, helperSHA256 };
      await writeJSON(plan.planPath, executablePlan);
      await writeJSON(this.currentFile, {
        id: plan.id,
        transactionDir: plan.transactionDir,
        version: plan.version,
        nonce: plan.nonce,
      });
      const helperPid = await new Promise((resolve, reject) => {
        const child = spawn(helper, [plan.planPath], {
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { PATH: '/usr/bin:/bin' },
          cwd: plan.transactionDir,
        });
        let ready = false,
          output = '';
        const timer = setTimeout(() => {
          if (!ready) {
            child.kill('SIGTERM');
            reject(fail('更新助手未能启动。'));
          }
        }, 10000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', () => {
          clearTimeout(timer);
          if (!ready) reject(fail('更新助手校验失败，尚未退出应用。'));
        });
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (!ready && output.includes('READY\n')) {
            ready = true;
            clearTimeout(timer);
            child.stdout.destroy();
            child.unref();
            resolve(child.pid);
          } else if (output.length > 1024 && !ready) {
            clearTimeout(timer);
            child.kill('SIGTERM');
            reject(fail('更新助手返回异常。'));
          }
        });
      });
      this.prepared.delete(plan.id);
      this.launched.set(plan.id, plan);
      return { id: plan.id, requestId, helperPid };
    } catch (error) {
      await this.clearCurrent(plan);
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async abort(prepared) {
    const plan = this.prepared.get(prepared?.id) || this.launched.get(prepared?.id);
    if (plan !== prepared) throw fail('更新计划无效。');
    if (this.launched.has(plan.id)) {
      await writeJSON(path.join(plan.transactionDir, 'cancel.json'), { nonce: plan.nonce });
      return;
    }
    await removeOwned(plan.stagePath, plan.stageIdentity);
    await this.clearCurrent(plan);
    await removeOwned(plan.transactionDir, plan.transactionIdentity);
    this.prepared.delete(plan.id);
  }
  async clearCurrent(plan) {
    const current = await readJSON(this.currentFile).catch(() => null);
    if (current?.id === plan.id && current?.nonce === plan.nonce)
      await fs.unlink(this.currentFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  async prunePreviousBackup() {
    try {
      const previous = await this.currentPlan();
      if (!previous || (await this.readResult())?.status !== 'confirmed') return false;
      if (
        path.dirname(previous.stagePath) !== path.dirname(this.currentBundle) ||
        path.basename(previous.stagePath) !== '.folio-update-' + previous.id + '.app'
      )
        return false;
      const stat = await fs.lstat(previous.stagePath, { bigint: true });
      if (
        !stat.isDirectory() ||
        String(stat.dev) !== previous.targetIdentity.dev ||
        String(stat.ino) !== previous.targetIdentity.ino
      )
        return false;
      const { stdout } = await this.runner(this.helperPath, ['--prune', previous.planPath], {
        timeout: 15000,
        maxBuffer: 4096,
      });
      return JSON.parse(stdout).pruned === true;
    } catch {
      return false;
    } // Uncertain backups are retained; cleanup never blocks a new download.
  }
  async currentPlan() {
    const current = await readJSON(this.currentFile);
    if (!current) return null;
    if (
      !UUID.test(current.id) ||
      typeof current.transactionDir !== 'string' ||
      path.dirname(current.transactionDir) !== this.directory ||
      !path.basename(current.transactionDir).startsWith('install-')
    )
      throw fail('更新状态无效。');
    try {
      await plainDirectory(current.transactionDir);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const plan = await readJSON(path.join(current.transactionDir, 'plan.json'));
    if (
      !plan ||
      plan.id !== current.id ||
      plan.nonce !== current.nonce ||
      plan.version !== current.version ||
      plan.targetPath !== this.currentBundle
    )
      throw fail('更新状态与当前应用不匹配。');
    return plan;
  }
  async readResult() {
    const plan = await this.currentPlan();
    if (!plan) return null;
    const result = await readJSON(path.join(plan.transactionDir, 'receipt.json'));
    if (!result) return null;
    if (
      result.nonce !== plan.nonce ||
      !STATUSES.has(result.status) ||
      !RECEIPT_CODES.has(result.code)
    )
      throw fail('更新结果无效。');
    return {
      status: result.status,
      code: result.code,
      version: plan.version,
      previousVersion: plan.previousVersion,
      requestId: plan.requestId,
      backupAvailable: result.backupAvailable === true,
    };
  }
  async acknowledgeStartup(version) {
    const plan = await this.currentPlan();
    if (!plan || plan.version !== version) return false;
    const result = await this.readResult();
    if (!result || !['installed', 'awaiting-confirmation'].includes(result.status)) return false;
    const actual = await this.inspectBundle(this.currentBundle, version);
    if (actual.dev !== plan.stageIdentity.dev || actual.ino !== plan.stageIdentity.ino)
      return false;
    await writeJSON(path.join(plan.transactionDir, 'ack.json'), { nonce: plan.nonce, version });
    if (result.status === 'awaiting-confirmation')
      await writeJSON(path.join(plan.transactionDir, 'receipt.json'), {
        nonce: plan.nonce,
        status: 'confirmed',
        code: 'CONFIRMED',
        backupAvailable: true,
      });
    return true;
  }
}
module.exports = { MacUpdateInstaller, BUNDLE_ID, MAX_ENTRIES, MAX_EXPANDED };
