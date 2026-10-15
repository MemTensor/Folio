const path = require('node:path');
function buildOutput(root, pkg) {
  const configured = pkg.build?.directories?.output || 'dist';
  const output = configured.replaceAll('${version}', pkg.version);
  if (output.includes('${')) throw Error('Unsupported output directory macro.');
  return path.resolve(root, output);
}
module.exports = { buildOutput };
