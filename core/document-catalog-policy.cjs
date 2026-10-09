const path = require('node:path');
const { DEPENDENCY_DIRECTORIES } = require('./ignored-directories.cjs');
const PREFERRED = new Set([
  'docs',
  'doc',
  'notes',
  'note',
  'documents',
  'documentation',
  '文档',
  '资料',
  '报告',
  '笔记',
  '设计',
  '说明',
]);
// Dependency and build directories come from the shared list every traversal
// uses. The extra names here are ones that hold documents written for tools
// rather than for the reader, so they are hidden from the document list while
// staying browsable in the file tree.
const ALWAYS_SKIP = new Set([
  ...DEPENDENCY_DIRECTORIES,
  'git',
  'dependencies',
  '依赖',
  'skills',
  'skill',
]);
const markdown = (name) => /\.(md|markdown|mdown|mkd|txt|mdx|qmd|rmd)$/i.test(name);
const archive = (name) =>
  /^_backup|^(?:_?backups?|_?archives?|_?outputs?|_?tmp|_?temp)(?:$|[-_.\d\s])|^(?:备份|归档|冷存档|代码镜像|输出|临时)(?:$|[-_\s\d])|^(?:代码镜像|冷存档)/i.test(
    name,
  );
function category(name) {
  const lower = name.toLocaleLowerCase();
  if (name.startsWith('.') || ALWAYS_SKIP.has(lower)) return 'skip';
  if (archive(name)) return 'archive';
  return PREFERRED.has(lower) ? 'preferred' : 'ordinary';
}
function documentAllowed(relative, includeArchives) {
  const parts = relative.split('/');
  const name = parts.pop();
  return (
    name &&
    !name.startsWith('.') &&
    markdown(name) &&
    parts.every(
      (part) => category(part) !== 'skip' && (includeArchives || category(part) !== 'archive'),
    )
  );
}
function within(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
module.exports = { PREFERRED, category, markdown, within, documentAllowed };
