const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { digest, writeJSON } = require('./state.cjs');
const { allowedLibraryRoot } = require('./library.cjs');
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 200;
const CACHE_MS = 5 * 60 * 1000;

async function smallFile(file) {
  let handle;
  try {
    if ((await fs.realpath(file)) !== file) return null;
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    // A growing config cannot bypass the advertised read budget.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_CONFIG_BYTES + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) return null;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
function tomlProjects(content) {
  const roots = [];
  // Only literal project-table names are considered. No TOML values, commands,
  // session logs, credentials or environment interpolation are evaluated.
  for (const line of String(content || '').split('\n')) {
    const match = line.match(/^\s*\[projects\.("(?:[^"\\]|\\.)*"|'[^']*')\]\s*(?:#.*)?$/);
    if (!match) continue;
    try {
      roots.push(match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1));
    } catch {}
    if (roots.length >= MAX_PROJECTS) break;
  }
  return roots;
}
function json(content) {
  try {
    return JSON.parse(content || '{}');
  } catch {
    return {};
  }
}
class ProjectCatalog {
  constructor(dataDir, { home = os.homedir(), codexHome, claudeConfig, now = Date.now } = {}) {
    this.dataDir = dataDir;
    this.home = path.resolve(home);
    this.codexHome = codexHome || path.join(this.home, '.codex');
    this.claudeConfig = claudeConfig || path.join(this.home, '.claude.json');
    this.file = path.join(dataDir, 'project-catalog-cache.json');
    this.now = now;
    this.pending = null;
    this.watcher = null;
    this.watchTimer = null;
    this.closed = false;
  }
  async watch(onChange) {
    await this.close();
    this.closed = false;
    const candidates = [
      path.join(this.codexHome, 'config.toml'),
      path.join(this.codexHome, '.codex-global-state.json'),
      this.claudeConfig,
    ];
    const files = [];
    for (const file of candidates) {
      try {
        const stat = await fs.lstat(file);
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size <= MAX_CONFIG_BYTES &&
          (await fs.realpath(file)) === file
        )
          files.push(file);
      } catch {}
    }
    if (!files.length) return { watching: false, files: 0 };
    this.watcher = require('chokidar').watch(files, {
      persistent: false,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      ignored: (target) =>
        !files.some((file) => file === target || file.startsWith(target + path.sep)),
    });
    const changed = (file) => {
      if (!files.includes(file) || this.closed) return;
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null;
        if (!this.closed) Promise.resolve(onChange()).catch(() => {});
      }, 2000);
      this.watchTimer.unref?.();
    };
    this.watcher
      .on('add', changed)
      .on('change', changed)
      .on('unlink', changed)
      .on('error', () => {});
    return { watching: true, files: files.length };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.watchTimer);
    this.watchTimer = null;
    await this.watcher?.close();
    this.watcher = null;
  }
  async snapshot({ refresh = false, registered = [] } = {}) {
    if (this.pending) return this.pending;
    this.pending = this.load({ refresh, registered });
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  async load({ refresh, registered }) {
    let cache = json(await smallFile(this.file));
    if (
      !cache ||
      !Array.isArray(cache.projects) ||
      cache.projects.length > MAX_PROJECTS ||
      !Number.isFinite(cache.refreshedAt) ||
      !cache.projects.every(
        (project) =>
          project &&
          typeof project.root === 'string' &&
          Array.isArray(project.sources) &&
          project.sources.every((source) => ['folio', 'codex', 'claude'].includes(source)),
      )
    )
      cache = null;
    if (refresh || !cache || this.now() - cache.refreshedAt >= CACHE_MS) {
      const [toml, global, claude] = await Promise.all([
        smallFile(path.join(this.codexHome, 'config.toml')),
        smallFile(path.join(this.codexHome, '.codex-global-state.json')),
        smallFile(this.claudeConfig),
      ]);
      const globalState = json(global);
      const claudeProjects = json(claude).projects;
      const candidates = tomlProjects(toml).map((root) => ({ root, source: 'codex' }));
      for (const key of [
        'electron-saved-workspace-roots',
        'active-workspace-roots',
        'workspace-root-order',
      ]) {
        if (Array.isArray(globalState[key])) {
          candidates.push(
            ...globalState[key].slice(0, MAX_PROJECTS).map((root) => ({ root, source: 'codex' })),
          );
        }
      }
      if (claudeProjects && typeof claudeProjects === 'object' && !Array.isArray(claudeProjects)) {
        candidates.push(
          ...Object.keys(claudeProjects)
            .slice(0, MAX_PROJECTS)
            .map((root) => ({ root, source: 'claude' })),
        );
      }
      cache = {
        projects: await this.validate(candidates),
        refreshedAt: this.now(),
        limited: candidates.length > MAX_PROJECTS,
      };
      await writeJSON(this.file, cache);
    }
    const projects = await this.validate([
      ...registered
        .slice(0, MAX_PROJECTS)
        .map((project) => ({ root: project.root, source: 'folio' })),
      ...cache.projects.flatMap((project) =>
        project.sources.map((source) => ({ root: project.root, source })),
      ),
    ]);
    return {
      projects,
      refreshedAt: cache.refreshedAt,
      limited: cache.limited || projects.length >= MAX_PROJECTS,
    };
  }
  async validate(candidates) {
    const map = new Map();
    for (const { root, source } of candidates) {
      if (
        typeof root !== 'string' ||
        !path.isAbsolute(root) ||
        !['folio', 'codex', 'claude'].includes(source)
      )
        continue;
      const normalized = path.resolve(root);
      if (!allowedLibraryRoot(normalized, this.home, { dataDir: this.dataDir })) continue;
      if (map.has(normalized)) {
        if (!map.get(normalized).sources.includes(source)) map.get(normalized).sources.push(source);
        continue;
      }
      if (map.size >= MAX_PROJECTS) break;
      let available = false;
      try {
        available =
          (await fs.lstat(normalized)).isDirectory() &&
          (await fs.realpath(normalized)) === normalized;
      } catch {}
      map.set(normalized, {
        id: digest(normalized).slice(0, 24),
        root: normalized,
        name: path.basename(normalized),
        sources: [source],
        available,
      });
    }
    return [...map.values()];
  }
}
module.exports = { ProjectCatalog, tomlProjects, MAX_PROJECTS, CACHE_MS };
