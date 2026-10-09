import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = await mkdtemp(path.join(os.tmpdir(), 'folio-shutdown-'));
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  await promisify(execFile)(
    createRequire(import.meta.url)('electron'),
    [fileURLToPath(new URL('./shutdown-smoke.cjs', import.meta.url)), dir],
    { env, timeout: 10000 },
  );
  if ((await readFile(path.join(dir, 'drained'), 'utf8')) !== 'done')
    throw Error('Shutdown did not drain writes.');
  console.log('Actual Electron quit verified after asynchronous cleanup.');
} finally {
  await rm(dir, { recursive: true, force: true });
}
