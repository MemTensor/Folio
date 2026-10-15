import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'folio-cli-check-')));
try {
  const cli = path.join(temporary, 'cli', 'folio.cjs');
  const workspace = path.join(temporary, 'workspace');
  const fakeDws = path.join(temporary, 'dws');
  const networkGuard = path.join(temporary, 'offline.cjs');
  await cp(path.join(root, 'dist-cli'), path.dirname(cli), { recursive: true });
  await mkdir(workspace);
  await writeFile(
    fakeDws,
    `#!/bin/sh
if [ "$*" != "profile list --format json" ]; then exit 99; fi
printf '%s\\n' '{"profiles":[{"profile":"fixture:user","isOrgCurrent":true}],"currentProfile":"fixture:user"}'
`,
    { mode: 0o700 },
  );
  await writeFile(
    networkGuard,
    `const deny = () => { throw Error('Network is disabled in the isolated CLI check.'); };
globalThis.fetch = deny;
globalThis.WebSocket = deny;
require('node:net').Socket.prototype.connect = deny;
require('node:dgram').createSocket = deny;
`,
  );
  const env = {
    PATH: '/usr/bin:/bin',
    NODE_PATH: '',
    FOLIO_DATA_DIR: path.join(temporary, 'state'),
    FOLIO_DWS_BIN: fakeDws,
    TMPDIR: temporary,
  };
  async function run(args, expectedExit = 0) {
    const { code, stdout, stderr } = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--require', networkGuard, cli, ...args, '--json'],
        { cwd: temporary, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(code, expectedExit, `${args.join(' ')}: ${stderr}\n${stdout}`);
    return JSON.parse(stdout); // Also rejects duplicate main() execution / JSON envelopes.
  }
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal((await run(['--version'])).data.version, version);
  assert.match((await run(['-h'])).data.help, /folio dingtalk plan/);
  assert.equal((await run(['unknown-command'], 2)).error.code, 'USAGE');

  const markdown = String.raw`# Offline mathematics

Inline $\mathbb{R}\oplus\mathfrak{g}\otimes\mathcal{F}$.

$$
A=\begin{pmatrix}1&\alpha\\\beta&2\end{pmatrix}
$$

$$
\ce{2H2 + O2 -> 2H2O}
$$
`;
  await writeFile(path.join(workspace, 'math.md'), markdown);
  assert.equal((await run(['library', 'add', workspace])).ok, true);
  const indexed = await run(['library', 'search', 'Offline mathematics']);
  assert.equal(indexed.data.total, 1);
  assert.equal(indexed.data.documents[0].match.line, 1);
  const revision = createHash('sha256').update(markdown).digest('hex');
  const result = await run([
    'dingtalk',
    'plan',
    'math.md',
    '--workspace',
    workspace,
    '--expect',
    revision,
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.data.stats.formulas, 3);
  const plan = JSON.parse(
    await readFile(
      path.join(env.FOLIO_DATA_DIR, 'dingtalk', 'plans', result.data.id + '.json'),
      'utf8',
    ),
  );
  const images = [];
  function visit(node) {
    if (!Array.isArray(node)) return;
    if (node[0] === 'img') images.push(node[1]);
    node.slice(2).forEach(visit);
  }
  visit(plan.jsonml);
  assert.equal(images.length, 3);
  for (const image of images) {
    assert.match(image.src, /^data:image\/png;base64,/);
    assert(image.width > 0 && image.height > 0);
    const bytes = Buffer.from(image.src.split(',')[1], 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  console.log(
    'Isolated CLI verified: one JSON response, usage errors, offline dynamic fonts and PNG formulas.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
