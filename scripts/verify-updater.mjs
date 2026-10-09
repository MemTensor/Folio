import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);
const root = fileURLToPath(new URL('..', import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const resources = path.resolve(electron, '../../Resources');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'folio-updater-check-')));
const run = promisify(execFile);
try {
  for (const [folder, version] of [
    ['old', '0.0.1'],
    ['new', '0.0.2'],
  ]) {
    const bundle = path.join(temporary, folder, 'Folio.app');
    await mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true });
    await mkdir(path.join(bundle, 'Contents/Resources/cli'), { recursive: true });
    await copyFile(electron, path.join(bundle, 'Contents/MacOS/Folio'));
    await copyFile(
      path.join(resources, 'default_app.asar'),
      path.join(bundle, 'Contents/Resources/app.asar'),
    );
    await writeFile(
      path.join(bundle, 'Contents/Resources/cli/folio.cjs'),
      '// generated fixture\n',
    );
    await writeFile(
      path.join(bundle, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.folio.markdown</string><key>CFBundleExecutable</key><string>Folio</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`,
    );
  }
  const zip = path.join(temporary, 'release.zip');
  await run('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    path.join(temporary, 'new/Folio.app'),
    zip,
  ]);
  const bytes = await readFile(zip);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  const { stdout } = await run(
    electron,
    [
      path.join(root, 'scripts/updater-smoke.cjs'),
      temporary,
      createHash('sha256').update(bytes).digest('hex'),
      String(bytes.length),
    ],
    { env, timeout: 30000 },
  );
  if (!JSON.parse(stdout).ok) throw Error('Electron installer verification failed.');
  console.log(
    'Electron updater verified: physical ASAR file, bundle inspection, extraction, manifest and safe abort.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
