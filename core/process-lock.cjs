const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A short SQLite transaction arbitrates ownership. No transaction (or blocking
// busy timeout) is held while the asynchronous protected operation is running.
// Checking a dead PID and replacing its lease happen in the same transaction,
// so a second reaper cannot remove a newly acquired lock.
const databases = new Map();
const busy = (error) =>
  [5, 6].includes(error.errcode & 255) ||
  /(?:database|table).*\b(?:locked|busy)\b/i.test(error.message || '');
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
const busyError = () =>
  Object.assign(Error('另一个 Folio 操作正在处理此文件，请稍后重试。'), { code: 'BUSY' });
function database(directory) {
  let db = databases.get(directory);
  if (db) {
    databases.delete(directory);
    databases.set(directory, db);
    return db;
  }
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(directory, 'ownership.sqlite');
  const fd = fs.openSync(file, 'a', 0o600);
  fs.closeSync(fd);
  db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=128;
      CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL);`);
  } catch (error) {
    db.close();
    throw error;
  }
  databases.set(directory, db);
  if (databases.size > 16) {
    const oldest = databases.keys().next().value;
    databases.get(oldest).close();
    databases.delete(oldest);
  }
  return db;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
function acquire(directory, key, token) {
  const db = database(directory);
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.prepare('SELECT pid FROM leases WHERE key=?').get(key);
    if (owner && alive(owner.pid)) {
      db.exec('ROLLBACK');
      return false;
    }
    db.prepare('INSERT OR REPLACE INTO leases(key,token,pid) VALUES(?,?,?)').run(
      key,
      token,
      process.pid,
    );
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
async function retry(operation, deadline) {
  for (;;) {
    try {
      if (operation()) return;
    } catch (error) {
      if (!busy(error)) throw error;
    }
    if (Date.now() >= deadline) throw busyError();
    await pause();
  }
}
async function withProcessLock(directory, key, fn, timeout) {
  const token = crypto.randomUUID();
  await retry(() => acquire(directory, key, token), Date.now() + timeout);
  try {
    return await fn(token);
  } finally {
    await retry(() => {
      database(directory).prepare('DELETE FROM leases WHERE key=? AND token=?').run(key, token);
      return true;
    }, Date.now() + timeout);
  }
}
module.exports = { withProcessLock };
