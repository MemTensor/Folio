import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = await realpath(
  process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist'),
);
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'folio-heading-check-')));
const electron = createRequire(import.meta.url)('electron');
const env = {
  ...process.env,
  FOLIO_DATA_DIR: path.join(temporary, 'user-data'),
  TMPDIR: temporary,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
try {
  const result = await new Promise((resolve, reject) => {
    execFile(
      electron,
      [path.join(root, 'scripts/desktop-heading-smoke.cjs'), temporary, dist],
      { cwd: root, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Error(`Heading verification failed.\n${stdout}\n${stderr}`));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(Error('Heading verification returned invalid output.\n' + stdout));
          }
        }
      },
    );
  });
  if (!result.ok) throw Error(JSON.stringify(result));
  console.log(
    'Hidden Electron heading verified: initial/reopened headings, new document, typing, undo, source, and saved Markdown.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
