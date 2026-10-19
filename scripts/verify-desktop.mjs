import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const usage =
  'Usage: node scripts/verify-desktop.mjs [--dist DIRECTORY] [--scenario normal|lifecycle|home|first-run|table-edit|block-select|formula-preview|agent|all] [--language zh-CN|en] [--capture-dir DIRECTORY]';
const options = {
  dist: path.join(root, 'dist'),
  scenario: 'normal',
  language: 'zh-CN',
  captureDir: null,
};
for (let i = 0; i < args.length; i++) {
  const flag = args[i],
    value = args[++i];
  if (!value || value.startsWith('--')) throw Error(usage);
  if (flag === '--dist') options.dist = path.resolve(value);
  else if (
    flag === '--scenario' &&
    [
      'normal',
      'lifecycle',
      'home',
      'first-run',
      'table-edit',
      'block-select',
      'formula-preview',
      'agent',
      'all',
    ].includes(value)
  )
    options.scenario = value;
  else if (flag === '--language' && ['zh-CN', 'en'].includes(value)) options.language = value;
  else if (flag === '--capture-dir') options.captureDir = path.resolve(value);
  else throw Error(usage);
}
const dist = await realpath(options.dist);
await readFile(path.join(dist, 'index.html'));
if (options.captureDir) {
  await mkdir(options.captureDir, { recursive: true });
  options.captureDir = await realpath(options.captureDir);
}
const electron = createRequire(import.meta.url)('electron');
const scenarios =
  options.scenario === 'all'
    ? [
        'normal',
        'lifecycle',
        'home',
        'first-run',
        'table-edit',
        'block-select',
        'formula-preview',
        'agent',
      ]
    : [options.scenario];
for (const scenario of scenarios) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'folio-desktop-check-')));
  const env = {
    ...process.env,
    FOLIO_DATA_DIR: path.join(temporary, 'user-data'),
    TMPDIR: temporary,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const capturePath = options.captureDir
    ? path.join(
        options.captureDir,
        `folio-${scenario}-${options.language}-${randomUUID().slice(0, 8)}.png`,
      )
    : null;
  try {
    const result = await new Promise((resolve, reject) => {
      execFile(
        electron,
        [
          path.join(root, 'scripts/desktop-smoke.cjs'),
          temporary,
          dist,
          scenario,
          options.language,
          ...(capturePath ? [capturePath] : []),
        ],
        { cwd: root, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error)
            reject(
              Error(
                `Desktop ${scenario}/${options.language} verification failed (${error.code ?? error.signal ?? 'unknown exit'}).\n${stdout}\n${stderr}`,
              ),
            );
          else {
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(Error('Desktop verification returned invalid output.\n' + stdout));
            }
          }
        },
      );
    });
    if (!result.ok) throw Error('Desktop verification failed: ' + JSON.stringify(result));
    console.log(
      scenario === 'table-edit'
        ? `Hidden Electron table-edit/${options.language} verified: multiline cell input, Enter, Tab, spreadsheet paste and saved Markdown.`
        : scenario === 'block-select'
          ? `Hidden Electron block-select/${options.language} verified: rendered code drag, copy/cut/paste safety, stale-cursor commands and click-to-edit.`
          : scenario === 'formula-preview'
            ? `Hidden Electron formula-preview/${options.language} verified: inline and display MathJax SVG in the live editor with unchanged Markdown.`
            : `Hidden Electron ${scenario}/${options.language} verified: frozen contextBridge, localized UI, unchanged generated Markdown and boot acknowledgement.`,
    );
    if (result.capturePath) console.log('Generated fixture screenshot: ' + result.capturePath);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
