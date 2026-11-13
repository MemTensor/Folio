import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const directory = process.argv.includes('--dir');
if (!['darwin', 'win32'].includes(process.platform))
  throw Error('Packaging supports macOS and Windows.');
const args =
  process.platform === 'win32'
    ? ['--win', directory ? 'dir' : 'nsis', '--x64']
    : ['--mac', directory ? 'dir' : 'zip'];
const child = spawn(
  process.execPath,
  [require.resolve('electron-builder/cli.js'), ...args, '--publish', 'never'],
  { stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
