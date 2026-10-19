import { build } from 'esbuild';
import { copyFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const fontDirectory = path.join(
  path.dirname(require.resolve('@mathjax/mathjax-newcm-font/package.json')),
  'mjs/svg/dynamic',
);
const fontFiles = (await readdir(fontDirectory)).filter((name) => name.endsWith('.js')).sort();
if (!fontFiles.length) throw Error('MathJax SVG dynamic fonts are missing.');
// Enumerate lazy imports at build time so esbuild includes the font registrations
// in the same module graph as core/math.mjs. A variable import would require an
// external node_modules directory when the CLI runs outside the app bundle.
const fontImports = fontFiles
  .map(
    (name) =>
      `${JSON.stringify(name)}: () => import(${JSON.stringify('@mathjax/mathjax-newcm-font/js/svg/dynamic/' + name)})`,
  )
  .join(',\n');
const entry = `
import { setMathLoader } from './core/math.mjs';
import { main } from './cli/main.cjs';
const fonts = {${fontImports}};
setMathLoader((name) => {
  const filename = name.split('/').pop();
  const load = Object.hasOwn(fonts, filename) ? fonts[filename] : null;
  if (!load) throw Error('Unsupported offline MathJax font: ' + filename);
  return load();
});
void main();
`;
await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'folio-cli-entry.mjs', loader: 'js' },
  outfile: 'dist-cli/folio.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', '@resvg/resvg-wasm/index_bg.wasm'],
  banner: { js: '// Folio standalone CLI. No running GUI or harness integration required.' },
});
await build({
  entryPoints: ['core/index-worker.cjs'],
  outfile: 'dist-cli/index-worker.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
});
await copyFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm'), 'dist-cli/resvg.wasm');

for (const file of ['LICENSE', 'NOTICE']) await copyFile(file, path.join('dist-cli', file));
