// One list of the directories that hold dependencies and build output rather than
// anyone's documents. The file tree, the search index and the document catalog all
// read it, because a folder that is invisible in one of them and indexed in
// another is how a project's virtualenv ended up with its READMEs in full-text
// search while the same folder was hidden from the sidebar.
const DEPENDENCY_DIRECTORIES = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  'site-packages',
  'coverage',
  'dist',
  'dist-cli',
  'dist-updater',
  'build',
  'target',
  'release',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.gradle',
  'pods',
  'deriveddata',
]);
/** Directory names compare case-insensitively: APFS and Windows checkouts differ. */
const isDependencyDirectory = (name) =>
  typeof name === 'string' && DEPENDENCY_DIRECTORIES.has(name.toLocaleLowerCase());
module.exports = { DEPENDENCY_DIRECTORIES, isDependencyDirectory };
