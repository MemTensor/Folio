const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const EVENTS = new Set([
  'app-start',
  'ipc-failure',
  'codex-runtime',
  'codex-protocol',
  'codex-exit',
  'connection',
  'login',
  'agent-turn',
  'update',
]);
const OPERATIONS = new Set([
  'initialize',
  'config/read',
  'permissionProfile/list',
  'account/read',
  'account/login/start',
  'account/login/cancel',
  'model/list',
  'bootstrap',
  'accept-open',
  'choose',
  'read',
  'save',
  'save-as',
  'export',
  'rename',
  'trash',
  'open-link',
  'project-open',
  'project-sync',
  'context-menu',
  'agent-connect',
  'agent-login',
  'agent-send',
  'agent-configure',
  'agent-hints',
  'update-check',
  'update-download',
  'update-begin-install',
  'update-commit-install',
  'diagnostics-export',
]);
const CODES = new Set([
  'AGENT_MISSING',
  'AGENT_STARTUP',
  'AGENT_PROTOCOL',
  'AGENT_CONNECTION',
  'AGENT_CONFIG',
  'AGENT_EDIT_MISSING',
  'AGENT_EDIT_OVERLAP',
  'AGENT_EDIT_AMBIGUOUS',
  'AGENT_EDIT_STALE',
  'AGENT_RESPONSE_FORMAT',
  'EACCES',
  'ENOENT',
  'EPIPE',
  'EPERM',
  'ETIMEDOUT',
  'ENOSPC',
  'EBUSY',
  'EINVAL',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOTFOUND',
  'CONFLICT',
  'STALE',
  'CANCELED',
  'NETWORK',
]);
const STAGES = new Set([
  'start',
  'initialized',
  'ready',
  'idle',
  'connecting',
  'login',
  'missing',
  'error',
  'browser',
  'complete',
  'cancel',
  'repair',
  'failed',
  'interrupted',
]);
const REASONS = new Set(['node-missing', 'incompatible', 'browser-open-failed', 'unknown']);
const SOURCES = new Set(['native', 'npm-platform', 'npm-legacy']);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,6})?$/;
function safeEvent(event, input = {}, timestamp = new Date().toISOString()) {
  if (!EVENTS.has(event)) return null;
  const value = { timestamp, event };
  for (const [key, set] of Object.entries({
    operation: OPERATIONS,
    stage: STAGES,
    reason: REASONS,
    runtimeSource: SOURCES,
  }))
    if (set.has(input[key])) value[key] = input[key];
  if (typeof input.code === 'string') value.code = CODES.has(input.code) ? input.code : 'UNKNOWN';
  for (const key of ['appVersion', 'runtimeVersion', 'osVersion'])
    if (typeof input[key] === 'string' && VERSION.test(input[key])) value[key] = input[key];
  if (['darwin', 'linux', 'win32'].includes(input.platform)) value.platform = input.platform;
  if (['arm64', 'x64', 'ia32'].includes(input.arch)) value.arch = input.arch;
  if (['chatgpt', 'api'].includes(input.provider)) value.provider = input.provider;
  for (const key of ['success', 'waiting', 'hasAccount'])
    if (typeof input[key] === 'boolean') value[key] = input[key];
  for (const key of ['exitCode', 'elapsedMs', 'count', 'attempt'])
    if (Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] <= 10000000)
      value[key] = input[key];
  if (['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(input.signal))
    value.signal = input.signal;
  return value;
}
class Diagnostics {
  constructor(dataDir, { version, maxBytes = 512 * 1024, now = Date.now } = {}) {
    this.directory = path.join(dataDir, 'diagnostics');
    this.current = path.join(this.directory, 'current.jsonl');
    this.previous = path.join(this.directory, 'previous.jsonl');
    this.maxBytes = Math.max(512, Math.min(512 * 1024, maxBytes));
    this.info = {
      appVersion: version,
      platform: process.platform,
      arch: process.arch,
      osVersion: os.release(),
    };
    this.now = now;
    this.recent = new Map();
    this.pending = 0;
    this.writing = Promise.resolve();
  }
  record(event, input = {}) {
    if (this.pending >= 64) return;
    const time = this.now();
    const entry = safeEvent(event, { ...this.info, ...input }, new Date(time).toISOString());
    if (!entry) return;
    const key = [entry.event, entry.operation, entry.stage, entry.code, entry.reason].join(':');
    if (this.recent.has(key) && time - this.recent.get(key) < 2000) return;
    this.recent.set(key, time);
    if (this.recent.size > 128) this.recent.delete(this.recent.keys().next().value);
    this.pending++;
    this.writing = this.writing
      .then(() => this.append(entry))
      .catch(() => {})
      .finally(() => this.pending--);
  }
  async ensure() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('Diagnostics directory unavailable.');
  }
  async append(entry) {
    const row = JSON.stringify(entry) + '\n';
    if (Buffer.byteLength(row) > this.maxBytes) return;
    await this.ensure();
    let size = 0;
    try {
      const stat = await fs.lstat(this.current);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      size = stat.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (size + Buffer.byteLength(row) > this.maxBytes) await fs.rename(this.current, this.previous);
    const handle = await fs.open(
      this.current,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      await handle.writeFile(row);
    } finally {
      await handle.close();
    }
  }
  async snapshot() {
    await this.writing;
    const entries = [];
    await this.ensure();
    for (const file of [this.previous, this.current]) {
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > this.maxBytes) continue;
        const content = await handle.readFile('utf8');
        for (const line of content.split('\n')) {
          try {
            const parsed = JSON.parse(line);
            if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.timestamp)) continue;
            const safe = safeEvent(parsed.event, parsed, parsed.timestamp);
            if (safe) entries.push(safe);
          } catch {}
        }
      } catch {
      } finally {
        await handle?.close();
      }
    }
    return JSON.stringify({ format: 1, maximumBytes: this.maxBytes * 2, entries }) + '\n';
  }
}
module.exports = { Diagnostics, safeEvent };
