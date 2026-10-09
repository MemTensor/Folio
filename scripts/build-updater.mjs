import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = path.join(root, 'dist-updater');
  await mkdir(output, { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  let commit = null,
    dirty = true;
  try {
    commit = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    dirty = Boolean(
      (
        await promisify(execFile)('git', ['status', '--porcelain', '--untracked-files=normal'], {
          cwd: root,
        })
      ).stdout.trim(),
    );
  } catch {}
  await writeFile(
    path.join(output, 'build-info.json'),
    JSON.stringify(
      { version: pkg.version, commit, dirty, platform: process.platform, arch: process.arch },
      null,
      2,
    ) + '\n',
  );
  await promisify(execFile)(
    '/usr/bin/clang',
    [
      '-fobjc-arc',
      '-O2',
      '-mmacosx-version-min=13.0',
      '-framework',
      'Foundation',
      '-framework',
      'AppKit',
      '-framework',
      'Security',
      path.join(root, 'electron/update-helper.m'),
      '-o',
      path.join(output, 'folio-update-helper'),
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
}
