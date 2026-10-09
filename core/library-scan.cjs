const fs = require('node:fs');
const path = require('node:path');
const { markdown } = require('./file-store.cjs');
const { isDependencyDirectory } = require('./ignored-directories.cjs');
const DEFAULT_SCAN_BUDGET = Object.freeze({
  maxEntries: 50000,
  maxDepth: 24,
  maxMs: 3000,
  maxBytes: 256 * 1024 * 1024,
});
function scanProject(
  root,
  budget,
  { now = () => performance.now(), excludedRoots = new Set() } = {},
) {
  const files = [],
    stack = [{ dir: root, depth: 0 }];
  let complete = true,
    unavailable = false;
  while (stack.length) {
    if (budget.entries >= budget.maxEntries || now() >= budget.deadline) {
      complete = false;
      break;
    }
    const { dir, depth } = stack.pop();
    let handle;
    try {
      if (fs.realpathSync(dir) !== dir) continue;
      handle = fs.opendirSync(dir);
      for (let entry; (entry = handle.readSync());) {
        if (++budget.entries > budget.maxEntries || now() >= budget.deadline) {
          complete = false;
          break;
        }
        if (entry.name.startsWith('.') || isDependencyDirectory(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excludedRoots.has(p)) continue;
          if (depth >= budget.maxDepth) complete = false;
          else stack.push({ dir: p, depth: depth + 1 });
        } else if (entry.isFile() && markdown(p)) files.push(p);
      }
    } catch {
      unavailable = true;
      complete = false;
    } finally {
      if (handle) handle.closeSync();
    }
  }
  return { files, complete, unavailable };
}
module.exports = { scanProject, DEFAULT_SCAN_BUDGET };
