import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const directory = await realpath(await mkdtemp('/private/tmp/folio-editor-regression-'));
try {
  await build({
    entryPoints: [path.join(root, 'scripts/editor-regression-fixture.ts')],
    bundle: true,
    outfile: path.join(directory, 'fixture.js'),
    platform: 'browser',
    format: 'iife',
    plugins: [
      {
        name: 'defer-unneeded-typesetting',
        setup(builder) {
          // Full MathJax/Mermaid rendering is covered by verify-desktop. This suite
          // inspects StateField work and copy DOM without constructing a live view.
          builder.onLoad({ filter: /\/src\/mathjax\.ts$/ }, () => ({
            contents: 'export async function typesetMath() {}',
            loader: 'js',
          }));
        },
      },
    ],
  });
  await writeFile(
    path.join(directory, 'fixture.html'),
    '<!doctype html><meta charset="utf-8"><body></body>',
  );
  const env = {
    ...process.env,
    FOLIO_DATA_DIR: path.join(directory, 'user-data'),
    TMPDIR: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const { stdout } = await promisify(execFile)(
    createRequire(import.meta.url)('electron'),
    [path.join(root, 'scripts/editor-regressions.cjs'), directory],
    { env, timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout.trim());
  if (!result.ok) throw Error('Editor regression failed.');
  console.log('Editor rendering/copy regression verified: ' + JSON.stringify(result));
} finally {
  await rm(directory, { recursive: true, force: true });
}
