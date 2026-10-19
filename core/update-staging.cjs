const fs = require('node:fs/promises');
const path = require('node:path');
const { readJSON } = require('./state.cjs');
const { UUID } = require('./identifiers.cjs');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
const matches = (stat, expected) =>
  stat?.isDirectory() && String(stat.dev) === expected?.dev && String(stat.ino) === expected?.ino;
// Only abandoned, never-launched preparations with an ownership receipt qualify.
// Unknown directories, installed backups and uncertain transactions are retained.
async function cleanupPreparations(directory, target, { now = Date.now(), isAlive = alive } = {}) {
  let removed = 0,
    scanned = 0;
  const current = await readJSON(path.join(directory, 'installer-current.json'), {}).catch(
    () => ({}),
  );
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (++scanned > 256 || removed >= 2) break;
    if (!entry.isDirectory() || !/^install-[A-Za-z0-9-]+$/.test(entry.name)) continue;
    const transaction = path.join(directory, entry.name);
    if (transaction === current.transactionDir) continue;
    try {
      const ownerPath = path.join(transaction, 'preparation.json'),
        stat = await fs.lstat(ownerPath);
      if (!stat.isFile() || stat.size > 16384 || now - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
      const owner = await readJSON(ownerPath);
      if (
        !UUID.test(owner.id) ||
        !Number.isInteger(owner.pid) ||
        owner.pid < 1 ||
        isAlive(owner.pid)
      )
        continue;
      if (
        owner.targetPath !== target ||
        owner.transactionDir !== transaction ||
        owner.stagePath !== path.join(path.dirname(target), '.folio-update-' + owner.id + '.app')
      )
        continue;
      if (await fs.lstat(path.join(transaction, 'plan.json')).catch(() => null)) continue;
      const txStat = await fs.lstat(transaction, { bigint: true });
      const stageStat = await fs.lstat(owner.stagePath, { bigint: true }).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (
        !matches(txStat, owner.transactionIdentity) ||
        (stageStat && !matches(stageStat, owner.stageIdentity))
      )
        continue;
      if (stageStat) await fs.rm(owner.stagePath, { recursive: true });
      await fs.rm(transaction, { recursive: true });
      removed++;
    } catch {
      /* Incomplete ownership evidence is never permission to delete. */
    }
  }
  return removed;
}
module.exports = { cleanupPreparations };
