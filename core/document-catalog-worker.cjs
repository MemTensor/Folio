const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parentPort, workerData } = require('node:worker_threads');
const {
  PREFERRED,
  category,
  markdown,
  within,
  documentAllowed,
} = require('./document-catalog-policy.cjs');
const fail = (code, message) => Object.assign(Error(message), { code });
async function validate(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root))
    throw fail('DOCUMENT_CATALOG_PATH', '请选择具体项目文件夹。');
  root = path.resolve(root);
  if (root === path.parse(root).root || within(root, os.homedir()))
    throw fail('DOCUMENT_CATALOG_PATH', '请选择具体项目文件夹。');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(root)) !== root)
    throw fail('DOCUMENT_CATALOG_PATH', '项目文件夹不能是符号链接。');
  return root;
}
async function scan(root, includeArchives) {
  root = await validate(root);
  if (category(path.basename(root)) === 'skip')
    return { documents: [], limited: false, scanned: 0, excluded: true };
  const limits = workerData.limits;
  const deadline = performance.now() + limits.maxMs;
  const queues = [[], [], [], []],
    positions = [0, 0, 0, 0],
    queued = new Set();
  const documents = [];
  let scanned = 0,
    limited = false,
    excluded = false;
  function enqueue(directory, depth, priority) {
    if (queued.has(directory)) return;
    if (!within(root, directory) || depth > limits.maxDepth) {
      limited = true;
      return;
    }
    queued.add(directory);
    queues[priority].push({ directory, depth });
  }
  enqueue(root, 0, 0);
  // A broad root containing thousands of code/assets cannot consume the whole
  // budget before the conventional documentation directories are considered.
  for (const name of PREFERRED) enqueue(path.join(root, name), 1, 1);
  while (true) {
    const priority = queues.findIndex((items, index) => positions[index] < items.length);
    if (priority < 0) break;
    if (
      scanned >= limits.maxEntries ||
      documents.length >= limits.maxDocuments ||
      performance.now() >= deadline
    ) {
      limited = true;
      break;
    }
    const { directory, depth } = queues[priority][positions[priority]++];
    const initialDocumentCount = documents.length;
    try {
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(directory)) !== directory
      )
        continue;
      const handle = await fs.opendir(directory);
      let inDirectory = 0;
      try {
        for await (const entry of handle) {
          if (
            scanned >= limits.maxEntries ||
            documents.length >= limits.maxDocuments ||
            performance.now() >= deadline ||
            inDirectory >= limits.maxDirectoryEntries
          ) {
            limited = true;
            break;
          }
          scanned++;
          inDirectory++;
          if (entry.isSymbolicLink()) continue;
          const group = entry.isDirectory()
            ? category(entry.name)
            : entry.name.startsWith('.')
              ? 'skip'
              : 'ordinary';
          if (group === 'skip') {
            excluded = true;
            continue;
          }
          if (group === 'archive' && !includeArchives) {
            excluded = true;
            continue;
          }
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            enqueue(
              target,
              depth + 1,
              group === 'archive' || priority === 3
                ? 3
                : group === 'preferred' || priority === 1
                  ? 1
                  : 2,
            );
          } else if (entry.isFile() && markdown(entry.name)) {
            const metadata = await fs.lstat(target).catch(() => null);
            if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
            documents.push({
              path: target,
              name: entry.name,
              relativePath: path.relative(root, target).split(path.sep).join('/'),
              modifiedAt: metadata.mtimeMs,
              size: metadata.size,
            });
          }
        }
      } finally {
        await handle.close().catch((error) => {
          if (error.code !== 'ERR_DIR_CLOSED') throw error;
        });
      }
      const finalStat = await fs.lstat(directory);
      if (
        finalStat.dev !== stat.dev ||
        finalStat.ino !== stat.ino ||
        (await fs.realpath(directory)) !== directory
      ) {
        documents.splice(initialDocumentCount);
        limited = true;
      }
    } catch (error) {
      documents.splice(initialDocumentCount);
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') limited = true;
    }
  }
  await validate(root);
  return { documents, limited, scanned, excluded };
}
async function metadata(root, paths, includeArchives) {
  root = await validate(root);
  if (category(path.basename(root)) === 'skip')
    return { documents: [], removed: paths, rescan: false };
  const documents = [],
    removed = [];
  let rescan = false;
  const deadline = performance.now() + workerData.limits.maxMs;
  for (const target of paths.slice(0, 256)) {
    if (performance.now() >= deadline) {
      rescan = true;
      break;
    }
    if (
      typeof target !== 'string' ||
      !path.isAbsolute(target) ||
      !within(root, target) ||
      root === target
    )
      throw fail('DOCUMENT_CATALOG_PATH', '文档路径不属于此项目。');
    const relativePath = path.relative(root, target).split(path.sep).join('/');
    if (!documentAllowed(relativePath, includeArchives)) {
      removed.push(target);
      continue;
    }
    try {
      const parent = path.dirname(target);
      if ((await fs.realpath(parent)) !== parent) {
        removed.push(target);
        continue;
      }
      const stat = await fs.lstat(target);
      if ((await fs.realpath(parent)) !== parent) {
        removed.push(target);
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        removed.push(target);
        rescan ||= stat.isDirectory();
        continue;
      }
      documents.push({
        path: target,
        name: path.basename(target),
        relativePath,
        modifiedAt: stat.mtimeMs,
        size: stat.size,
      });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') removed.push(target);
      else rescan = true;
    }
  }
  await validate(root);
  return { documents, removed, rescan };
}
parentPort.on('message', async ({ id, operation, root, includeArchives, paths }) => {
  try {
    const result =
      operation === 'validate'
        ? await validate(root)
        : operation === 'metadata'
          ? await metadata(root, paths, includeArchives)
          : await scan(root, includeArchives);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { code: error.code || 'DOCUMENT_CATALOG_IO', message: error.message },
    });
  }
});
