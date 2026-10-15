const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { within } = require('./file-store.cjs');

// The rest of Library contains application state and caches, but cloud providers
// also keep real user documents here. Only admit a project below a provider,
// never the CloudStorage aggregate or a whole provider account.
function libraryDocuments(root, home) {
  const mobile = path.join(home, 'Library/Mobile Documents');
  if (within(mobile, root)) {
    const parts = path.relative(mobile, root).split(path.sep);
    return parts.length >= 2 && parts.every((part) => part && !part.startsWith('.'));
  }
  const cloudStorage = path.join(home, 'Library/CloudStorage');
  if (!within(cloudStorage, root)) return false;
  const parts = path.relative(cloudStorage, root).split(path.sep);
  return parts.length >= 2 && parts.every((part) => part && !part.startsWith('.'));
}
function welcomeRoot(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) return null;
  // Custom data directories may use a symlink (for example /tmp on macOS).
  // Admission compares real paths, so resolve the trusted application directory
  // without following a separately substituted Welcome symlink.
  try {
    dataDir = fs.realpathSync(dataDir);
  } catch {
    dataDir = path.resolve(dataDir);
  }
  return path.join(dataDir, 'Welcome');
}
/** @param {string} root @param {string} [home] @param {{dataDir?: string}} [options] */
function allowedLibraryRoot(root, home = os.homedir(), { dataDir } = {}) {
  root = path.resolve(root);
  home = path.resolve(home);
  if (root === path.parse(root).root || within(root, home)) return false;
  if (
    within(path.join(home, 'Library'), root) &&
    root !== welcomeRoot(dataDir) &&
    !libraryDocuments(root, home)
  )
    return false;
  return true;
}
module.exports = { allowedLibraryRoot };
