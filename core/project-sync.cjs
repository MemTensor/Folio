const fs = require('node:fs/promises');
const { constants, watch: watchDirectory } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const MarkdownIt = require('markdown-it');
const {
  digest,
  readJSON,
  writeJSON,
  withLock,
  readRecoverableJSON,
  writeRecoverableJSON,
} = require('./state.cjs');
const { allowedLibraryRoot } = require('./library.cjs');
const md = new MarkdownIt({ html: false, linkify: false });
const MAX_FILE_BYTES = 100_000_000;
const LIMITS = Object.freeze({
  maxEntries: 10000,
  maxFiles: 2000,
  maxDepth: 16,
  maxBytes: 512 * 1024 * 1024,
  maxMs: 15000,
});
const ignored = new Set([
  'node_modules',
  'dist',
  'dist-cli',
  'dist-updater',
  'release',
  'build',
  'target',
  'vendor',
  'venv',
  'coverage',
  '__pycache__',
]);
const assetExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.heic',
  '.bmp',
  '.tif',
  '.tiff',
  '.pdf',
  '.txt',
  '.csv',
  '.tsv',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.mp4',
  '.mov',
  '.webm',
]);
const isMarkdown = (name) => /\.(md|markdown|mdown)$/i.test(name);
const eligiblePath = (name) =>
  relativeAllowed(name) &&
  (isMarkdown(name) || assetExtensions.has(path.extname(name).toLowerCase()));
const fresh = () => ({
  version: 1,
  enabled: false,
  projectIds: [],
  bindings: {},
  baselines: {},
  rotation: 0,
  lastRun: null,
});
function failure(code, message) {
  return Object.assign(Error(message), { code });
}
function checkCanceled(signal) {
  if (signal?.aborted) throw failure('SYNC_CANCELED', 'Folio 正在退出。');
}
// Cancel the caller's wait, even when a filesystem read is stalled in the OS.
// The operation must be read-only: its eventual result is discarded, and its
// own finally block still closes any handle once the OS releases the read.
function cancellableRead(operation, signal) {
  checkCanceled(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(failure('SYNC_CANCELED', 'Folio 正在退出。'));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve()
      .then(() => {
        checkCanceled(signal);
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}
function validState(value) {
  const id = (item) => typeof item === 'string' && /^[a-f0-9]{24}$/.test(item);
  const object = (item) => !!item && typeof item === 'object' && !Array.isArray(item);
  const hash = (item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.projectIds) ||
    value.projectIds.length > 20 ||
    !value.projectIds.every(id) ||
    !object(value.baselines) ||
    (value.bindings !== undefined &&
      (!object(value.bindings) ||
        !Object.entries(value.bindings).every(([key, target]) => id(key) && id(target))))
  )
    return false;
  if (
    !Object.entries(value.baselines).every(
      ([projectId, baseline]) =>
        id(projectId) &&
        object(baseline) &&
        object(baseline.files) &&
        Object.keys(baseline.files).length <= LIMITS.maxFiles &&
        Object.entries(baseline.files).every(
          ([relative, file]) =>
            relativeAllowed(relative) &&
            object(file) &&
            hash(file.hash) &&
            ['local', 'cloud'].every(
              (side) =>
                object(file[side]) &&
                hash(file[side].hash) &&
                typeof file[side].fingerprint === 'string',
            ),
        ),
    )
  )
    return false;
  return (
    value.lastRun === null ||
    (object(value.lastRun) &&
      Array.isArray(value.lastRun.conflicts) &&
      Array.isArray(value.lastRun.skipped))
  );
}
function relativeAllowed(relative) {
  return (
    typeof relative === 'string' &&
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    !relative.includes('\\') &&
    relative
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '..' &&
          !part.startsWith('.') &&
          !ignored.has(part) &&
          !/^(credentials?|secrets?|passwords?|tokens?|id_rsa|id_ed25519)([. _-]|$)/i.test(part),
      )
  );
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}
function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
async function validateRoot(root, home, dataDir) {
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    !allowedLibraryRoot(root, home, { dataDir })
  )
    throw failure('SYNC_ROOT', '请选择具体的项目文件夹。');
  const resolved = path.resolve(root);
  if ((await fs.realpath(resolved)) !== resolved || !(await fs.lstat(resolved)).isDirectory())
    throw failure('SYNC_ROOT', '项目文件夹不能是符号链接。');
  return resolved;
}
async function safeParent(root, relative, create = false) {
  if (!relativeAllowed(relative)) throw failure('SYNC_PATH', '同步路径不属于此项目。');
  if ((await fs.realpath(root)) !== root || !(await fs.lstat(root)).isDirectory())
    throw failure('SYNC_PATH', '同步目录已改变。');
  let current = root;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (create)
      await fs.mkdir(current).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(current)) !== current)
      throw failure('SYNC_PATH', '跳过符号链接或项目外的附件。');
  }
  return path.join(root, relative);
}
async function cloudMetadata(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32768)
      throw failure('SYNC_METADATA', 'iCloud 项目记录无效，已保留原内容。');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, 32769));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw failure('SYNC_METADATA', 'iCloud 项目记录正在改变。');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('SYNC_METADATA', 'iCloud 项目记录无效，已保留原内容。');
  } finally {
    await handle?.close();
  }
}
/**
 * True when iCloud has evicted the file and left a placeholder behind. The real
 * name disappears and `.<name>.icloud` takes its place, which reads as a deletion
 * unless it is recognised for what it is.
 */
async function evictedPlaceholder(file) {
  const placeholder = path.join(path.dirname(file), '.' + path.basename(file) + '.icloud');
  try {
    return (await fs.lstat(placeholder)).isFile();
  } catch {
    return false;
  }
}
const NOT_DOWNLOADED = '文件尚未下载到本机，已跳过本轮处理。';
/**
 * Refuse to carry "this file is now empty" across when the other side still holds
 * content. A writer that truncates before writing leaves a legitimate zero-byte
 * file behind for an instant, and propagating that overwrites the good copy on
 * every other device. The user resolves it instead.
 * @param {{size:number}|null} source @param {{size:number}|null} target
 */
function emptiedSide(source, target, localHash, cloudHash) {
  if (source && source.size === 0 && target && target.size > 0)
    throw Object.assign(failure('SYNC_CONFLICT', '一侧的内容变为空，请确认要保留哪个版本。'), {
      localHash,
      cloudHash,
    });
}
async function snapshot(root, relative, budget, cached) {
  let handle;
  try {
    checkCanceled(budget.signal);
    const file = await safeParent(root, relative);
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    checkCanceled(budget.signal);
    const before = await handle.stat();
    if (!before.isFile() || before.size >= MAX_FILE_BYTES)
      throw failure('SYNC_SIZE', '跳过大于或等于 100 MB 的文件。');
    // A dataless file reports its real length while holding no blocks. Reading it
    // asks iCloud to fetch the body, which can block for as long as the network
    // takes, so it is left for a later round instead.
    if (before.size > 0 && before.blocks === 0)
      throw failure('SYNC_NOT_DOWNLOADED', NOT_DOWNLOADED);
    const stamp = fingerprint(before);
    if (cached?.fingerprint === stamp && /^[a-f0-9]{64}$/.test(cached.hash))
      return { hash: cached.hash, fingerprint: stamp, size: before.size };
    if (budget.bytes + before.size > budget.maxBytes || Date.now() > budget.deadline)
      throw failure('SYNC_LIMIT', '本次同步已达到资源限额，请稍后再同步。');
    budget.bytes += before.size;
    const content = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      fingerprint(after) !== stamp ||
      fingerprint(current) !== stamp ||
      content.length !== before.size
    )
      throw failure('SYNC_CHANGED', '文件正在改变，已留待下次同步。');
    return { hash: digest(content), fingerprint: stamp, size: content.length, content };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Absent and not-yet-downloaded look identical from here, and only one of
      // them means the other side should be treated as authoritative.
      if (await evictedPlaceholder(path.join(root, relative)))
        throw failure('SYNC_NOT_DOWNLOADED', NOT_DOWNLOADED);
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
function referencedFiles(content, relative) {
  const files = new Set();
  const tokens = md.parse(content, {});
  const visit = (token) => {
    const url =
      token.type === 'image'
        ? token.attrGet('src')
        : token.type === 'link_open'
          ? token.attrGet('href')
          : null;
    if (url && !/^[a-z][a-z\d+.-]*:|^\/\//i.test(url)) {
      try {
        const decoded = decodeURIComponent(url.split(/[?#]/)[0]);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decoded));
        if (
          decoded &&
          !path.isAbsolute(decoded) &&
          relativeAllowed(target) &&
          (isMarkdown(target) || assetExtensions.has(path.extname(target).toLowerCase()))
        )
          files.add(target);
      } catch {}
    }
    token.children?.forEach(visit);
  };
  tokens.forEach(visit);
  return [...files];
}
async function collect(root, budget, cache = {}) {
  const files = new Set(),
    stack = [{ directory: root, depth: 0 }];
  let complete = true;
  const warnings = [];
  while (stack.length) {
    checkCanceled(budget.signal);
    if (budget.entries >= budget.maxEntries || Date.now() > budget.deadline) {
      complete = false;
      break;
    }
    const { directory, depth } = stack.pop();
    let handle;
    try {
      if ((await fs.realpath(directory)) !== directory) continue;
      handle = await fs.opendir(directory);
      for await (const entry of handle) {
        checkCanceled(budget.signal);
        if (
          ++budget.entries > budget.maxEntries ||
          Date.now() > budget.deadline ||
          files.size >= budget.maxFiles
        ) {
          complete = false;
          break;
        }
        const relative = path
          .relative(root, path.join(directory, entry.name))
          .split(path.sep)
          .join('/');
        if (!relativeAllowed(relative) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth < budget.maxDepth)
            stack.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
          else complete = false;
        } else if (entry.isFile() && isMarkdown(entry.name)) files.add(relative);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const references = {};
  for (const relative of [...files]) {
    checkCanceled(budget.signal);
    if (Date.now() > budget.deadline) {
      complete = false;
      break;
    }
    try {
      const stat = await fs.lstat(await safeParent(root, relative));
      const stamp = fingerprint(stat);
      let refs;
      if (cache[relative]?.fingerprint === stamp && Array.isArray(cache[relative].references))
        refs = cache[relative].references.filter(eligiblePath).slice(0, budget.maxFiles);
      else if (stat.size < 2 * 1024 * 1024) {
        const value = await snapshot(root, relative, budget);
        refs = value ? referencedFiles(value.content.toString('utf8'), relative) : [];
      } else {
        refs = [];
        complete = false;
        warnings.push({ path: relative, code: 'REFERENCE_LIMIT' });
      }
      references[relative] = { fingerprint: stamp, references: refs };
      for (const ref of refs) {
        if (files.size >= budget.maxFiles) {
          complete = false;
          break;
        }
        files.add(ref);
      }
    } catch (error) {
      if (error.code === 'SYNC_LIMIT') complete = false;
    }
  }
  return { files, references, complete, warnings };
}
class ProjectSync {
  constructor(dataDir, { cloudRoot, home = os.homedir(), limits = {} } = {}) {
    this.dataDir = dataDir;
    this.home = path.resolve(home);
    this.cloudRoot = path.resolve(
      cloudRoot || path.join(this.home, 'Library/Mobile Documents/com~apple~CloudDocs/Folio'),
    );
    this.file = path.join(dataDir, 'project-sync.json');
    this.limits = { ...LIMITS, ...limits };
    this.running = false;
    this.watchers = [];
    this.watchTimer = null;
    this.watchGeneration = 0;
    this.stopController = new AbortController();
  }
  read(operation) {
    return cancellableRead(operation, this.stopController.signal);
  }
  stop() {
    // Terminal shutdown, unlike close(), which also refreshes active watchers.
    // Reads may stop immediately; writeExpected continues until its destination
    // is complete or restored. Its owning sync/resolve promise is still drained.
    this.stopController.abort();
  }
  async watch(projects, onChange) {
    await this.close();
    checkCanceled(this.stopController.signal);
    const generation = this.watchGeneration;
    const state = await this.state();
    if (!state.enabled) return { watching: false, directories: 0, limited: false };
    let limited = false;
    for (const id of state.projectIds) {
      if (!projects.some((project) => project.id === id)) continue;
      const cloudId = state.bindings?.[id] || id;
      const cloudProject = (await this.read(() => this.listCloudProjects())).projects.find(
        (item) => item.id === cloudId,
      );
      if (!cloudProject) continue;
      const root = cloudProject.path;
      const paths = Object.keys(state.baselines[id]?.files || {}).filter(relativeAllowed);
      const directories = new Set(['.']);
      for (const relative of paths) {
        let directory = path.posix.dirname(relative);
        while (directory !== '.') {
          directories.add(directory);
          directory = path.posix.dirname(directory);
        }
      }
      for (const directory of directories) {
        if (this.watchers.length >= 128) {
          limited = true;
          break;
        }
        const absolute = path.join(root, directory);
        try {
          const valid = await this.read(
            async () =>
              (await fs.lstat(absolute)).isDirectory() &&
              (await fs.realpath(absolute)) === absolute,
          );
          if (!valid || generation !== this.watchGeneration) continue;
          const watcher = watchDirectory(
            absolute,
            { persistent: false, recursive: false },
            (_event, name) => {
              if (!name || generation !== this.watchGeneration) return;
              const relative = path.posix.join(directory, String(name));
              if (
                !relativeAllowed(relative) ||
                !(isMarkdown(relative) || paths.includes(relative) || !path.extname(relative))
              )
                return;
              clearTimeout(this.watchTimer);
              this.watchTimer = setTimeout(() => {
                this.watchTimer = null;
                if (generation === this.watchGeneration)
                  Promise.resolve(onChange()).catch(() => {});
              }, 2000);
              this.watchTimer.unref?.();
            },
          );
          watcher.on('error', () => {});
          this.watchers.push(watcher);
        } catch {
          checkCanceled(this.stopController.signal);
        }
      }
    }
    return { watching: this.watchers.length > 0, directories: this.watchers.length, limited };
  }
  async close() {
    this.watchGeneration++;
    clearTimeout(this.watchTimer);
    this.watchTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
  async state() {
    return readRecoverableJSON(this.file, {
      fallback: fresh(),
      validate: validState,
      label: 'iCloud 同步记录',
      allowReset: true,
      onRecovery: (event) => {
        this.recovery = event.source;
      },
    });
  }
  async persist(state) {
    return writeRecoverableJSON(this.file, state, {
      validate: validState,
      label: 'iCloud 同步记录',
    });
  }
  async status() {
    const state = await this.state();
    let available = false;
    try {
      available =
        (await fs.lstat(path.dirname(this.cloudRoot))).isDirectory() &&
        (await fs.realpath(path.dirname(this.cloudRoot))) === path.dirname(this.cloudRoot);
    } catch {}
    return {
      enabled: state.enabled,
      projectIds: state.projectIds,
      bindings: state.bindings || {},
      available,
      running: this.running,
      lastRun: state.lastRun,
      cloudRoot: this.cloudRoot,
      recovery: this.recovery || null,
      recoveryRoot: path.join(this.dataDir, 'sync-recovery'),
    };
  }
  async configure({ enabled, projectIds }) {
    if (
      typeof enabled !== 'boolean' ||
      !Array.isArray(projectIds) ||
      projectIds.length > 20 ||
      projectIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
    )
      throw failure('SYNC_CONFIG', '请先选择要同步的项目。');
    if (this.running) throw failure('BUSY', '同步正在进行，请完成后再修改设置。');
    await withLock(this.dataDir, 'project-sync', async () => {
      const state = await this.state();
      state.enabled = enabled;
      state.projectIds = [...new Set(projectIds)];
      if (
        new Set(state.projectIds.map((id) => state.bindings?.[id] || id)).size !==
        state.projectIds.length
      )
        throw failure('SYNC_CONFIG', '每个 iCloud 项目只能连接一个已选本地项目。');
      state.baselines = Object.fromEntries(
        Object.entries(state.baselines).filter(([id]) => state.projectIds.includes(id)),
      );
      await this.persist(state);
    });
    return this.status();
  }
  async listCloudProjects() {
    const projects = [];
    let entries = 0,
      limited = false;
    try {
      if ((await fs.realpath(this.cloudRoot)) !== this.cloudRoot) return { projects, limited };
      const directory = await fs.opendir(this.cloudRoot);
      for await (const entry of directory) {
        if (++entries > 200) {
          limited = true;
          break;
        }
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !/^[^./][^/]{0,80}-[a-f0-9]{24}$/.test(entry.name)
        )
          continue;
        const root = path.join(this.cloudRoot, entry.name),
          file = path.join(root, '.folio-project.json');
        try {
          if ((await fs.realpath(root)) !== root) continue;
          const metadata = await cloudMetadata(file);
          if (
            !metadata ||
            !/^[a-f0-9]{24}$/.test(metadata.id) ||
            !entry.name.endsWith('-' + metadata.id) ||
            typeof metadata.name !== 'string'
          )
            continue;
          projects.push({ id: metadata.id, name: metadata.name.slice(0, 100), path: root });
        } catch {}
      }
    } catch {}
    return { projects, limited };
  }
  async bindCloudProject(localProjectId, cloudId) {
    const validId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
    if (!validId(localProjectId) || (cloudId !== null && !validId(cloudId)))
      throw failure('SYNC_CONFIG', '项目 ID 无效。');
    if (this.running) throw failure('BUSY', '同步正在进行，请完成后再绑定项目。');
    return withLock(this.dataDir, 'project-sync', async () => {
      const state = await this.state();
      if (cloudId !== null) {
        const existing = (await this.listCloudProjects()).projects.find(
          (project) => project.id === cloudId,
        );
        if (!existing) throw failure('SYNC_MISSING', '这个 iCloud 项目当前不可用。');
      }
      const effective = cloudId || localProjectId;
      if (
        state.projectIds.some(
          (id) => id !== localProjectId && (state.bindings?.[id] || id) === effective,
        )
      )
        throw failure('SYNC_CONFIG', '这个 iCloud 项目已经绑定了另一个本地项目。');
      state.bindings ||= {};
      if ((state.bindings[localProjectId] || localProjectId) !== effective)
        delete state.baselines[localProjectId];
      if (cloudId === null) delete state.bindings[localProjectId];
      else state.bindings[localProjectId] = cloudId;
      await this.persist(state);
      return this.status();
    });
  }
  async cloudDirectory(projectId, name = 'Project') {
    if (!/^[a-f0-9]{24}$/.test(projectId)) throw failure('SYNC_CONFIG', '项目 ID 无效。');
    const parent = path.dirname(this.cloudRoot);
    if ((await this.read(() => fs.realpath(parent))) !== parent)
      throw failure('SYNC_UNAVAILABLE', '请先在系统设置中开启 iCloud Drive。');
    await fs.mkdir(this.cloudRoot).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    if ((await this.read(() => fs.realpath(this.cloudRoot))) !== this.cloudRoot)
      throw failure('SYNC_PATH', 'iCloud 同步目录不能是符号链接。');
    const existing = (await this.read(() => this.listCloudProjects())).projects.find(
      (project) => project.id === projectId,
    );
    const safeName =
      String(name)
        .normalize('NFC')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 64) || 'Project';
    const directory = existing?.path || path.join(this.cloudRoot, safeName + '-' + projectId);
    await fs.mkdir(directory).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const valid = await this.read(
      async () =>
        (await fs.realpath(directory)) === directory && (await fs.lstat(directory)).isDirectory(),
    );
    if (!valid) throw failure('SYNC_PATH', 'iCloud 项目目录不能是符号链接。');
    return directory;
  }
  budget() {
    return {
      ...this.limits,
      entries: 0,
      bytes: 0,
      deadline: Date.now() + this.limits.maxMs,
      signal: this.stopController.signal,
    };
  }
  async archive(projectId, root, relative, value) {
    const directory = path.join(this.dataDir, 'sync-recovery');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const extension = path.extname(relative).toLowerCase();
    const name =
      value.hash +
      (isMarkdown(relative) || assetExtensions.has(extension) ? extension : '.snapshot');
    await fs
      .writeFile(path.join(directory, name), value.content, { flag: 'wx', mode: 0o600 })
      .catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const indexFile = path.join(directory, 'index.json');
    let index = await readJSON(indexFile, []).catch(() => []);
    if (!Array.isArray(index)) index = [];
    index = index.filter(
      (item) =>
        item &&
        typeof item.snapshot === 'string' &&
        /^[a-f0-9]{64}\.[a-z0-9]+$/.test(item.snapshot) &&
        Number.isFinite(item.size) &&
        item.snapshot !== name,
    );
    index.unshift({
      projectId,
      root,
      path: relative,
      snapshot: name,
      hash: value.hash,
      size: value.size,
      createdAt: Date.now(),
    });
    let bytes = 0;
    const keep = [],
      remove = [];
    for (const item of index) {
      if (keep.length < 64 && bytes + item.size <= 512 * 1024 * 1024) {
        keep.push(item);
        bytes += item.size;
      } else remove.push(item);
    }
    await writeJSON(indexFile, keep);
    for (const item of remove) await fs.unlink(path.join(directory, item.snapshot)).catch(() => {});
  }
  async writeExpected(root, relative, content, expectedHash, budget, projectId) {
    checkCanceled(this.stopController.signal);
    const destination = await safeParent(root, relative, true);
    const before = await this.read(() => snapshot(root, relative, budget));
    if ((before?.hash || null) !== expectedHash)
      throw failure('SYNC_CONFLICT', '文件已改变，保留两边版本供你选择。');
    if (before) await this.archive(projectId, root, relative, before);
    checkCanceled(this.stopController.signal);
    if (!before) {
      const temporary = path.join(path.dirname(destination), '.folio-sync-' + crypto.randomUUID());
      try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await safeParent(root, relative);
        await fs.link(temporary, destination).catch((error) => {
          if (error.code === 'EEXIST')
            throw failure('SYNC_CONFLICT', '目标文件刚刚被创建，已保留它。');
          throw error;
        });
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    } else {
      const temporary = path.join(path.dirname(destination), '.folio-sync-' + crypto.randomUUID());
      const captured = '.folio-sync-captured-' + crypto.randomUUID();
      const capturePath = path.join(path.dirname(destination), captured);
      let moved = false,
        discardCapture = false,
        capturedArchived = false;
      try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        const current = await this.read(() => snapshot(root, relative, budget));
        if (current?.hash !== expectedHash)
          throw failure('SYNC_CONFLICT', '文件已改变，保留两边版本供你选择。');
        await safeParent(root, relative);
        checkCanceled(this.stopController.signal);
        // Capture the exact inode atomically before exclusive placement. An
        // editor saving in the narrow check/replace gap keeps its bytes: either
        // in this captured copy or at the exclusively-created destination.
        await fs.rename(destination, capturePath);
        moved = true;
        let captureHandle, capturedContent, capturedStamp;
        try {
          captureHandle = await fs.open(capturePath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await captureHandle.stat();
          if (
            !stat.isFile() ||
            stat.size >= MAX_FILE_BYTES ||
            budget.bytes + stat.size > budget.maxBytes
          )
            throw failure('SYNC_CHANGED', '文件在同步时改变，已停止替换。');
          capturedStamp = fingerprint(stat);
          budget.bytes += stat.size;
          capturedContent = await captureHandle.readFile();
          if (fingerprint(await captureHandle.stat()) !== capturedStamp)
            throw failure('SYNC_CHANGED', '文件在同步时改变，已停止替换。');
        } finally {
          await captureHandle?.close();
        }
        capturedArchived = digest(capturedContent) === expectedHash;
        if (!capturedArchived) {
          await this.archive(projectId, root, relative, {
            content: capturedContent,
            hash: digest(capturedContent),
            size: capturedContent.length,
          });
          capturedArchived = true;
          throw failure('SYNC_CONFLICT', '文件在同步时改变，已保留最新版本。');
        }
        await fs.link(temporary, destination).catch((error) => {
          if (error.code === 'EEXIST')
            throw failure('SYNC_CONFLICT', '目标文件刚刚被改变，已保留它。');
          throw error;
        });
        // A writer holding the captured inode may still be active. Keep that
        // captured file if it changed after reading instead of deleting its data.
        discardCapture = fingerprint(await fs.lstat(capturePath)) === capturedStamp;
        if (!discardCapture) throw failure('SYNC_CHANGED', '文件在同步时改变，恢复副本已保留。');
      } catch (error) {
        if (moved) {
          // Never replace a concurrent writer while restoring the captured file.
          try {
            await fs.link(capturePath, destination);
            discardCapture = true;
          } catch (restore) {
            if (restore.code !== 'EEXIST') throw restore;
            discardCapture = capturedArchived && error.code !== 'SYNC_CHANGED';
          }
        }
        throw error;
      } finally {
        await fs.unlink(temporary).catch(() => {});
        if (moved && discardCapture) await fs.unlink(capturePath).catch(() => {});
      }
    }
    const after = await snapshot(root, relative, budget);
    if (after?.hash !== digest(content))
      throw failure('SYNC_CHANGED', '目标文件在同步时发生了变化，下次同步将重新检查。');
    return after;
  }
  async sync({ projects = [] } = {}) {
    checkCanceled(this.stopController.signal);
    if (this.running) throw failure('BUSY', '同步已经在进行中。');
    this.running = true;
    try {
      return await withLock(this.dataDir, 'project-sync', async () => {
        const state = await this.state();
        if (!state.enabled) return { ...(await this.read(() => this.status())), disabled: true };
        // One deadline bounds the whole run, but each project gets its own entry
        // and byte allowance, and the starting project rotates. Sharing a single
        // counter meant a large first project consumed the run every time and the
        // projects behind it were never reached, on this run or any later one.
        const deadline = Date.now() + this.limits.maxMs;
        const rotation = Number.isSafeInteger(state.rotation) ? state.rotation : 0;
        const order = state.projectIds.map((_, index, all) => all[(index + rotation) % all.length]);
        const result = {
          startedAt: Date.now(),
          finishedAt: null,
          uploaded: 0,
          downloaded: 0,
          unchanged: 0,
          skipped: [],
          conflicts: [],
          limited: false,
          bytesRead: 0,
          entriesScanned: 0,
          projects: [],
        };
        for (const id of order) {
          checkCanceled(this.stopController.signal);
          const project = projects.find((item) => item.id === id);
          if (!project) {
            result.skipped.push({ projectId: id, code: 'PROJECT_NOT_OPEN' });
            continue;
          }
          if (Date.now() > deadline) {
            // Deferred, not skipped for good: the rotation puts this project first
            // on the next run.
            result.skipped.push({ projectId: id, code: 'SYNC_DEFERRED' });
            result.limited = true;
            continue;
          }
          const budget = {
            ...this.limits,
            entries: 0,
            bytes: 0,
            deadline,
            signal: this.stopController.signal,
          };
          try {
            const local = await this.read(() =>
              validateRoot(project.root, this.home, this.dataDir),
            );
            const cloudId = state.bindings?.[id] || id;
            const cloud = await this.cloudDirectory(cloudId, project.name || path.basename(local));
            if (inside(local, cloud) || inside(cloud, local) || local === cloud)
              throw failure('SYNC_ROOT', '项目和 iCloud 目标不能相互包含。');
            const previous = state.baselines[id] || {
              files: {},
              localReferences: {},
              cloudReferences: {},
            };
            const localFiles = await this.read(() =>
              collect(local, budget, previous.localReferences),
            );
            const cloudFiles = await this.read(() =>
              collect(cloud, budget, previous.cloudReferences),
            );
            result.limited ||= !localFiles.complete || !cloudFiles.complete;
            result.skipped.push(
              ...[...localFiles.warnings, ...cloudFiles.warnings].map((warning) => ({
                projectId: id,
                ...warning,
              })),
            );
            const paths = new Set([...localFiles.files, ...cloudFiles.files]);
            const files = { ...previous.files };
            // Only a complete scan of both sides can retire a missing baseline.
            // A one-sided deletion remains in paths and still needs preserving.
            if (localFiles.complete && cloudFiles.complete)
              for (const relative of Object.keys(files))
                if (!paths.has(relative)) delete files[relative];
            const cloudManifest = path.join(cloud, '.folio-project.json');
            const existingManifest = await this.read(() => cloudMetadata(cloudManifest));
            if (existingManifest && existingManifest.id !== cloudId)
              throw failure('SYNC_ROOT', 'iCloud 中已存在不同项目，已停止同步。');
            if (!existingManifest)
              await fs.writeFile(
                cloudManifest,
                JSON.stringify({
                  version: 1,
                  id: cloudId,
                  name: String(project.name || path.basename(local)),
                }),
                { flag: 'wx', mode: 0o600 },
              );
            for (const relative of paths) {
              checkCanceled(this.stopController.signal);
              if (Date.now() > budget.deadline) {
                result.limited = true;
                break;
              }
              if (!relativeAllowed(relative)) continue;
              try {
                const baseline = files[relative];
                let left = await this.read(() =>
                  snapshot(local, relative, budget, baseline?.local),
                );
                let right = await this.read(() =>
                  snapshot(cloud, relative, budget, baseline?.cloud),
                );
                const leftHash = left?.hash || null,
                  rightHash = right?.hash || null,
                  base = baseline?.hash;
                if (!left && !right) continue;
                if (leftHash === rightHash) result.unchanged++;
                else if (
                  (!left && base && rightHash === base) ||
                  (!right && base && leftHash === base)
                ) {
                  result.skipped.push({
                    projectId: id,
                    path: relative,
                    code: 'DELETION_PRESERVED',
                  });
                  continue;
                } else if (left && ((!right && !base) || rightHash === base)) {
                  if (!left.content)
                    left = await this.read(() => snapshot(local, relative, budget));
                  emptiedSide(left, right, leftHash, rightHash);
                  right = await this.writeExpected(
                    cloud,
                    relative,
                    left.content,
                    rightHash,
                    budget,
                    id,
                  );
                  result.uploaded++;
                } else if (right && ((!left && !base) || leftHash === base)) {
                  if (!right.content)
                    right = await this.read(() => snapshot(cloud, relative, budget));
                  emptiedSide(right, left, leftHash, rightHash);
                  left = await this.writeExpected(
                    local,
                    relative,
                    right.content,
                    leftHash,
                    budget,
                    id,
                  );
                  result.downloaded++;
                } else {
                  result.conflicts.push({
                    projectId: id,
                    path: relative,
                    localHash: leftHash,
                    cloudHash: rightHash,
                  });
                  continue;
                }
                if (left?.hash === right?.hash)
                  files[relative] = {
                    hash: left.hash,
                    local: { fingerprint: left.fingerprint, hash: left.hash },
                    cloud: { fingerprint: right.fingerprint, hash: right.hash },
                  };
              } catch (error) {
                checkCanceled(this.stopController.signal);
                if (error.code === 'SYNC_CONFLICT')
                  // Carry the hashes through: resolve() rejects a record without
                  // them, which left these conflicts with two buttons that both
                  // failed.
                  result.conflicts.push({
                    projectId: id,
                    path: relative,
                    code: error.code,
                    localHash: error.localHash ?? null,
                    cloudHash: error.cloudHash ?? null,
                  });
                else
                  result.skipped.push({
                    projectId: id,
                    path: relative,
                    code: error.code || 'SYNC_IO',
                  });
                if (error.code === 'SYNC_LIMIT') {
                  result.limited = true;
                  break;
                }
              }
            }
            state.baselines[id] = {
              files: Object.fromEntries(Object.entries(files).slice(-this.limits.maxFiles)),
              localReferences: localFiles.references,
              cloudReferences: cloudFiles.references,
            };
            result.projects.push({ id, cloudPath: cloud });
          } catch (error) {
            checkCanceled(this.stopController.signal);
            result.skipped.push({ projectId: id, code: error.code || 'SYNC_IO' });
          } finally {
            result.bytesRead += budget.bytes;
            result.entriesScanned += budget.entries;
          }
        }
        checkCanceled(this.stopController.signal);
        result.finishedAt = Date.now();
        state.rotation = order.length ? (rotation + 1) % order.length : 0;
        state.lastRun = result;
        await this.persist(state);
        return result;
      });
    } finally {
      this.running = false;
    }
  }
  async resolve({ project, path: relative, choice, localHash, cloudHash }) {
    checkCanceled(this.stopController.signal);
    if (this.running) throw failure('BUSY', '同步已经在进行中。');
    if (
      !project ||
      !['keep-local', 'use-cloud'].includes(choice) ||
      !relativeAllowed(relative) ||
      [localHash, cloudHash].some(
        (value) => value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)),
      )
    )
      throw failure('SYNC_CONFIG', '请选择冲突文件和要保留的版本。');
    this.running = true;
    try {
      return await withLock(this.dataDir, 'project-sync', async () => {
        const state = await this.state();
        if (!state.enabled || !state.projectIds.includes(project.id))
          throw failure('SYNC_DISABLED', '此项目没有开启 iCloud 同步。');
        if (
          !state.lastRun?.conflicts.some(
            (item) => item.projectId === project.id && item.path === relative,
          )
        )
          throw failure('SYNC_CONFLICT', '请先刷新同步状态。');
        const local = await this.read(() => validateRoot(project.root, this.home, this.dataDir)),
          cloud = await this.cloudDirectory(
            state.bindings?.[project.id] || project.id,
            project.name || path.basename(local),
          ),
          budget = this.budget();
        let left = await this.read(() => snapshot(local, relative, budget)),
          right = await this.read(() => snapshot(cloud, relative, budget));
        if ((left?.hash || null) !== localHash || (right?.hash || null) !== cloudHash)
          throw failure('SYNC_CONFLICT', '文件已改变，请重新同步后选择。');
        if (choice === 'keep-local' && left)
          right = await this.writeExpected(
            cloud,
            relative,
            left.content,
            cloudHash,
            budget,
            project.id,
          );
        else if (choice === 'use-cloud' && right)
          left = await this.writeExpected(
            local,
            relative,
            right.content,
            localHash,
            budget,
            project.id,
          );
        else throw failure('SYNC_MISSING', '这个版本已删除，Folio 不会把删除传播到另一边。');
        state.baselines[project.id] ||= { files: {}, localReferences: {}, cloudReferences: {} };
        state.baselines[project.id].files[relative] = {
          hash: left.hash,
          local: { fingerprint: left.fingerprint, hash: left.hash },
          cloud: { fingerprint: right.fingerprint, hash: right.hash },
        };
        state.lastRun.conflicts = state.lastRun.conflicts.filter(
          (item) => !(item.projectId === project.id && item.path === relative),
        );
        await this.persist(state);
        return this.status();
      });
    } finally {
      this.running = false;
    }
  }
}
module.exports = { ProjectSync, referencedFiles, relativeAllowed, MAX_FILE_BYTES, LIMITS };
