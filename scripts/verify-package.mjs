// Runs the packaged application's own code from inside app.asar. `npm run check`
// exercises the source tree; this is the only check that proves the bundle that
// ships actually loads its workers and resolves its resources.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const bundle =
  process.argv[2] || path.join(root, 'release', 'v' + version, 'mac-arm64', 'Folio.app');
const electron = path.join(bundle, 'Contents/MacOS/Folio');

function run(args, { cwd = root } = {}) {
  return new Promise((resolve) => {
    const child = spawn(electron, args, {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => resolve({ code: -1, out, err: String(error) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const workspace = await run([path.join(root, 'scripts/verify-workspace-package.cjs'), bundle]);
if (workspace.code !== 0 || !workspace.out.includes('"ok":true'))
  throw Error('Packaged workspace check failed: ' + (workspace.err || workspace.out));
const agent = await run([path.join(root, 'scripts/verify-agent-package.cjs'), bundle]);
if (agent.code !== 0 || !agent.out.includes('"ok":true'))
  throw Error('Packaged agent check failed: ' + (agent.err || agent.out));

// The bundled CLI runs through ELECTRON_RUN_AS_NODE, so this also confirms the
// runAsNode fuse is still on after the fuse flip.
const cli = await run([path.join(bundle, 'Contents/Resources/cli/folio.cjs'), '--version']);
if (cli.code !== 0 || !cli.out.includes(version))
  throw Error('Bundled CLI failed inside the package: ' + (cli.err || cli.out));

console.log(
  'Packaged bundle verified: asar workers, document catalog, Agent proposals and the bundled CLI.',
);
