const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function dataDirectory() {
  return (
    process.env.FOLIO_DATA_DIR ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support/Folio')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA || os.homedir(), 'Folio')
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'folio'))
  );
}
async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
function recoveryError(file, label, cause) {
  return Object.assign(
    new Error(label + '已损坏，且没有可用备份。原文件已保留，请从备份恢复后重试：' + file),
    {
      code: 'STATE_RECOVERY_REQUIRED',
      cause,
      details: { path: file, backupPath: file + '.backup' },
    },
  );
}
async function checkedJSON(file, validate) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!validate(value)) throw new SyntaxError('Invalid state structure');
  return value;
}
/** Opt in only for stores whose recovery policy is explicit; ordinary readJSON stays strict. */
async function readRecoverableJSON(
  file,
  {
    fallback = null,
    validate = () => true,
    label = '本地状态',
    allowReset = false,
    onRecovery,
  } = {},
) {
  try {
    return await checkedJSON(file, validate);
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
    return withLock(path.dirname(file), 'recoverable:' + path.basename(file), async () => {
      let invalid;
      try {
        return await checkedJSON(file, validate);
      } catch (e) {
        if (e.code && e.code !== 'ENOENT') throw e;
        invalid = e;
      }
      const backupPath = file + '.backup';
      let backup,
        hasBackup = false;
      try {
        backup = await checkedJSON(backupPath, validate);
        hasBackup = true;
      } catch (e) {
        if (e.code && e.code !== 'ENOENT') throw e;
      }
      if (invalid.code === 'ENOENT' && !hasBackup) {
        // A damaged backup means this is not a fresh store. Never silently invent new identities.
        try {
          await fs.stat(backupPath);
        } catch (e) {
          if (e.code === 'ENOENT') return fallback;
          throw e;
        }
      }
      if (!hasBackup && !allowReset) throw recoveryError(file, label, invalid);
      const damagedPath =
        invalid.code === 'ENOENT'
          ? null
          : file + '.damaged-' + Date.now() + '-' + crypto.randomUUID();
      if (damagedPath)
        await fs.copyFile(file, damagedPath, require('node:fs').constants.COPYFILE_EXCL);
      const value = hasBackup ? backup : fallback;
      await writeJSON(file, value);
      await onRecovery?.({
        path: file,
        backupPath,
        damagedPath,
        source: hasBackup ? 'backup' : 'reset',
      });
      return value;
    });
  }
}
async function writeRecoverableJSON(
  file,
  value,
  { validate = () => true, label = '本地状态' } = {},
) {
  if (!validate(value))
    throw recoveryError(file, label, new SyntaxError('Invalid state structure'));
  return withLock(path.dirname(file), 'recoverable:' + path.basename(file), async () => {
    // Both files hold the newest candidate after success. A crash between writes can recover it.
    await writeJSON(file + '.backup', value);
    await writeJSON(file, value);
  });
}
async function withLock(dataDir, key, fn, { timeout = 10000 } = {}) {
  const parent = path.join(dataDir, 'locks');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  return require('./process-lock.cjs').withProcessLock(
    parent,
    key,
    (token) => withDirectoryLock(parent, key, fn, timeout, token),
    timeout,
  );
}
// Keep the directory protocol while older installed CLIs may still be running.
// Reclamation and acquisition by current clients are serialized by the lease.
async function withDirectoryLock(parent, key, fn, timeout, token) {
  const lock = path.join(parent, digest(key) + '.lock'),
    start = Date.now();
  let acquired = false;
  while (!acquired) {
    if (Date.now() - start > timeout)
      throw Object.assign(Error('另一个 Folio 操作正在处理此文件，请稍后重试。'), { code: 'BUSY' });
    try {
      await fs.mkdir(lock);
      acquired = true;
      try {
        await writeJSON(path.join(lock, 'owner.json'), {
          pid: process.pid,
          time: Date.now(),
          token,
        });
      } catch (error) {
        await fs.rm(lock, { recursive: true, force: true });
        throw error;
      }
    } catch (e) {
      if (acquired || e.code !== 'EEXIST') throw e;
      const owner = await readJSON(path.join(lock, 'owner.json')).catch(() => null);
      let stale = false;
      if (owner?.pid) {
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          stale = e.code === 'ESRCH';
        }
      } else {
        stale =
          Date.now() - (await fs.stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 30000;
      }
      if (stale) {
        const retired = lock + '.stale-' + crypto.randomUUID();
        try {
          await fs.rename(lock, retired);
          await fs.rm(retired, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        continue;
      }
      if (Date.now() - start > timeout) {
        const error = new Error('另一个 Folio 操作正在处理此文件，请稍后重试。');
        error.code = 'BUSY';
        throw error;
      }
      await new Promise((r) => setTimeout(r, 35));
    }
  }
  try {
    return await fn();
  } finally {
    const owner = await readJSON(path.join(lock, 'owner.json'));
    if (owner?.token === token) await fs.rm(lock, { recursive: true, force: true });
  }
}
module.exports = {
  dataDirectory,
  digest,
  readJSON,
  writeJSON,
  withLock,
  readRecoverableJSON,
  writeRecoverableJSON,
};
