const fs = require('node:fs/promises');
const { watch: watchDirectory } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parentPort, workerData } = require('node:worker_threads');
const { isDependencyDirectory } = require('./ignored-directories.cjs');
const limits = workerData.limits;
const visible = (name) => !!name && !name.startsWith('.') && !isDependencyDirectory(name);
const markdown = (name) => /\.(md|markdown|mdown|mkd|txt|mdx|qmd|rmd)$/i.test(name);
const within = (root, target) => {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};
const fail = (code, message) => Object.assign(Error(message), { code });
const directories = new Map();
const rootEpochs = new Map();
const directoryEpochs = new Map();
const epochFor = (root, directory) =>
  `${rootEpochs.get(root) || 0}:${directoryEpochs.get(root + '\0' + directory) || 0}`;
const collator = new Intl.Collator('zh-CN', { numeric: true });
let limitNotice = false;
function canonicalInput(root, directory) {
  if (
    typeof root !== 'string' ||
    typeof directory !== 'string' ||
    !path.isAbsolute(root) ||
    !path.isAbsolute(directory)
  )
    throw fail('WORKSPACE_PATH', '请选择项目内的文件夹。');
  root = path.resolve(root);
  directory = path.resolve(directory);
  if (root === path.parse(root).root || within(root, os.homedir()) || !within(root, directory))
    throw fail('WORKSPACE_PATH', '请选择具体项目内的文件夹。');
  if (
    path
      .relative(root, directory)
      .split(path.sep)
      .some((part) => part && !visible(part))
  )
    throw fail('WORKSPACE_PATH', '此文件夹不参与文档浏览。');
  return { root, directory };
}
async function validate(root, directory) {
  ({ root, directory } = canonicalInput(root, directory));
  for (const target of new Set([root, directory])) {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(target)) !== target)
      throw fail('WORKSPACE_PATH', '文件夹不能是符号链接或指向项目外部。');
  }
  return { root, directory };
}
function notice(value) {
  parentPort.postMessage({ event: 'notice', value });
}
function queueChange(entry, directory, type, name = '') {
  if (directories.get(directory) !== entry) return;
  if (entry.changes.size < 64) entry.changes.set(name, type);
  else {
    entry.changes.clear();
    entry.changes.set('', 'rename');
  }
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (directories.get(directory) !== entry) return;
    for (const [name, type] of entry.changes)
      for (const root of entry.roots)
        parentPort.postMessage({
          event: 'change',
          value: {
            root,
            directory,
            ...(name ? { path: path.join(directory, name) } : {}),
            type,
          },
        });
    entry.changes.clear();
  }, 80);
  entry.timer.unref();
}
function watch(root, directory, baseline) {
  const existing = directories.get(directory);
  if (existing) {
    existing.roots.add(root);
    return { watching: true, limited: false };
  }
  if (directories.size >= limits.maxDirectories) {
    if (!limitNotice) {
      limitNotice = true;
      notice({
        code: 'WORKSPACE_WATCH_LIMIT',
        root,
        message: '已达到文件夹监听上限，未监听的文件夹可手动刷新。',
      });
    }
    return { watching: false, limited: true };
  }
  const entry = {
    roots: new Set([root]),
    watcher: null,
    timer: null,
    reconcileTimer: null,
    changes: new Map(),
  };
  try {
    entry.watcher = watchDirectory(
      directory,
      { recursive: false, persistent: false },
      (type, name) => {
        name = name?.toString();
        if (name && (name !== path.basename(name) || !visible(name))) return;
        queueChange(entry, directory, type, name || '');
      },
    );
    entry.watcher.on('error', () => {
      clearTimeout(entry.timer);
      clearTimeout(entry.reconcileTimer);
      entry.watcher.close();
      directories.delete(directory);
      notice({
        code: 'WORKSPACE_WATCH_UNAVAILABLE',
        root,
        directory,
        message: '此文件夹暂不能监听，可手动刷新。',
      });
    });
    directories.set(directory, entry);
    // Darwin's native event stream starts asynchronously. Recheck metadata once
    // against the listing taken before subscription, covering both the
    // list-to-watch gap and writes during native startup. This never repeats.
    entry.reconcileTimer = setTimeout(async () => {
      entry.reconcileTimer = null;
      if (directories.get(directory) !== entry) return;
      try {
        const currentRoot = entry.roots.values().next().value;
        await validate(currentRoot, directory);
        const current = await scan(directory);
        await validate(currentRoot, directory);
        if (directories.get(directory) !== entry) return;
        if (baseline.limited || current.limited) queueChange(entry, directory, 'change');
        else
          for (const name of new Set([
            ...baseline.fingerprints.keys(),
            ...current.fingerprints.keys(),
          ]))
            if (baseline.fingerprints.get(name) !== current.fingerprints.get(name))
              queueChange(entry, directory, 'change', name);
      } catch {
        // Do not turn one slow/unavailable metadata check into periodic scans.
      }
    }, 400);
    entry.reconcileTimer.unref();
    return { watching: true, limited: false };
  } catch {
    notice({
      code: 'WORKSPACE_WATCH_UNAVAILABLE',
      root,
      directory,
      message: '此文件夹暂不能监听，可手动刷新。',
    });
    return { watching: false, limited: false };
  }
}
async function scan(directory) {
  const nodes = [];
  const fingerprints = new Map();
  let scanned = 0,
    limited = false;
  const handle = await fs.opendir(directory);
  try {
    for await (const entry of handle) {
      if (++scanned > limits.maxEntries) {
        limited = true;
        break;
      }
      if (!visible(entry.name) || entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !(entry.isFile() && markdown(entry.name))) continue;
      if (nodes.length >= limits.maxNodes) {
        limited = true;
        break;
      }
      const target = path.join(directory, entry.name);
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        nodes.push({ name: entry.name, path: target, kind: 'folder' });
        fingerprints.set(entry.name, 'folder');
      } else if (stat.isFile() && markdown(entry.name)) {
        nodes.push({
          name: entry.name,
          path: target,
          kind: 'file',
          size: stat.size,
          mtime: stat.mtimeMs,
        });
        fingerprints.set(
          entry.name,
          [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'),
        );
      }
    }
  } finally {
    await handle.close().catch((error) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  nodes.sort((a, b) =>
    a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1,
  );
  return { nodes, fingerprints, limited, scanned: Math.min(scanned, limits.maxEntries) };
}
async function list(root, directory, epoch) {
  const result = await scan(directory);
  await validate(root, directory);
  if (epochFor(root, directory) !== epoch) throw fail('WORKSPACE_CLOSED', '此项目已关闭。');
  const watched = watch(root, directory, result);
  return {
    nodes: result.nodes,
    limited: result.limited || watched.limited,
    watching: watched.watching,
    scanned: result.scanned,
  };
}
async function dispatch({ operation, root, directory }) {
  if (operation === 'stats')
    return {
      directories: directories.size,
      files: 0,
      roots: new Set([...directories.values()].flatMap((entry) => [...entry.roots])).size,
    };
  if (operation === 'close-root') {
    if (typeof root !== 'string' || !path.isAbsolute(root))
      throw fail('WORKSPACE_PATH', '项目路径无效。');
    root = path.resolve(root);
    rootEpochs.set(root, (rootEpochs.get(root) || 0) + 1);
    let closed = 0;
    for (const [directory, entry] of directories) {
      entry.roots.delete(root);
      if (entry.roots.size) continue;
      clearTimeout(entry.timer);
      clearTimeout(entry.reconcileTimer);
      entry.watcher.close();
      directories.delete(directory);
      closed++;
    }
    if (directories.size < limits.maxDirectories) limitNotice = false;
    return { closed };
  }
  if (operation === 'unwatch') {
    ({ root, directory } = canonicalInput(root, directory));
    const key = root + '\0' + directory;
    directoryEpochs.set(key, (directoryEpochs.get(key) || 0) + 1);
    const entry = directories.get(directory);
    entry?.roots.delete(root);
    if (entry && !entry.roots.size) {
      clearTimeout(entry.timer);
      clearTimeout(entry.reconcileTimer);
      entry.watcher.close();
      directories.delete(directory);
      limitNotice = false;
      return { closed: 1 };
    }
    return { closed: 0 };
  }
  const input = canonicalInput(root, directory);
  const epoch = epochFor(input.root, input.directory);
  ({ root, directory } = await validate(input.root, input.directory));
  if (epochFor(root, directory) !== epoch) throw fail('WORKSPACE_CLOSED', '此项目已关闭。');
  if (operation === 'list') return list(root, directory, epoch);
  if (operation === 'watch') {
    if (directories.has(directory)) return watch(root, directory);
    const baseline = await scan(directory);
    await validate(root, directory);
    if (epochFor(root, directory) !== epoch) throw fail('WORKSPACE_CLOSED', '此项目已关闭。');
    return watch(root, directory, baseline);
  }
  throw fail('WORKSPACE_OPERATION', '无效的文件夹操作。');
}
parentPort.on('message', async (message) => {
  try {
    parentPort.postMessage({ id: message.id, result: await dispatch(message) });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: {
        code: error.code || 'WORKSPACE_IO',
        message: error.message,
      },
    });
  }
});
