import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const cli = path.resolve('cli/main.cjs');
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'),
    state = path.join(dir, 'state');
  await fs.mkdir(root);
  const env = { ...process.env, FOLIO_DATA_DIR: state };
  delete env.MEMOS_API_KEY;
  delete env.MEMOS_API_KEY_FILE;
  delete env.MEMOS_BASE_URL;
  return {
    root,
    state,
    call: (args, input = '') =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [cli, ...args, '--json'], { env });
        let out = '',
          err = '';
        p.stdout.on('data', (b) => (out += b));
        p.stderr.on('data', (b) => (err += b));
        p.on('close', (code) => {
          let json;
          try {
            json = JSON.parse(out);
          } catch {}
          resolve({ code, json, out, err });
        });
        p.stdin.end(input);
      }),
  };
}
test('CLI works without a GUI and emits one parseable JSON envelope', async (t) => {
  const { call } = await setup(t);
  const r = await call(['doctor']);
  assert.equal(r.code, 0);
  assert.equal(r.json.data.desktopRequired, false);
  assert.equal(r.json.data.cloud.configured, false);
  assert.equal(r.err, '');
});
test('CLI patch records the declared contributor and retains formula/table text', async (t) => {
  const { root, call } = await setup(t);
  const body =
    '# Training\n\nStatus: draft\n\n$$\nx^2+y^2\n$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  await fs.writeFile(path.join(root, 'note.md'), body);
  const read = await call(['read', 'note.md', '--workspace', root]);
  const patch = path.join(root, 'patch.json');
  await fs.writeFile(
    patch,
    JSON.stringify([{ find: 'Status: draft', replace: 'Status: reviewed' }]),
  );
  const result = await call([
    'patch',
    'note.md',
    '--workspace',
    root,
    '--patch',
    patch,
    '--expect',
    read.json.data.file.hash,
    '--actor',
    'codex',
    '--origin',
    'model',
  ]);
  assert.equal(result.code, 0);
  assert.equal(
    await fs.readFile(path.join(root, 'note.md'), 'utf8'),
    body.replace('draft', 'reviewed'),
  );
  assert(
    result.json.data.document.events.some(
      (e) => e.actor === 'codex' && e.evidence === 'caller-declared',
    ),
  );
});
test('CLI rejects stale revisions and invalid origins without writing', async (t) => {
  const { root, call } = await setup(t);
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, 'initial');
  const read = await call(['read', file, '--workspace', root]);
  await fs.writeFile(file, 'external');
  const stale = await call(
    ['write', file, '--workspace', root, '--input', '-', '--expect', read.json.data.file.hash],
    'overwrite',
  );
  assert.equal(stale.code, 3);
  const invalid = await call(
    ['write', file, '--workspace', root, '--input', '-', '--expect', 'new', '--origin', 'guessed'],
    'overwrite',
  );
  assert.equal(invalid.code, 2);
  assert.equal(await fs.readFile(file, 'utf8'), 'external');
});
test('two CLI processes cooperate on the same revision', async (t) => {
  const { root, call } = await setup(t);
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, 'base');
  const read = await call(['read', file, '--workspace', root]);
  const args = [
    'write',
    file,
    '--workspace',
    root,
    '--input',
    '-',
    '--expect',
    read.json.data.file.hash,
  ];
  const results = await Promise.all([call(args, 'first'), call(args, 'second')]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 3]);
});
test('CLI stdin preserves BOM and CRLF without doubling carriage returns', async (t) => {
  const { root, call } = await setup(t);
  const r = await call(
    ['write', 'note.md', '--workspace', root, '--input', '-', '--expect', 'new'],
    '\uFEFF# 标题\r\n正文\r\n',
  );
  assert.equal(r.code, 0);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), '\uFEFF# 标题\r\n正文\r\n');
});
test('context includes whole sections and reports omissions at its budget', async (t) => {
  const { root, call } = await setup(t);
  await fs.writeFile(
    path.join(root, 'note.md'),
    '# Training\n\n' + 'Training long text '.repeat(20) + '\n\n|a|b|\n|-|-|\n|1|2|',
  );
  const short = await call(['context', 'Training', '--workspace', root, '--max-chars', '100']);
  assert.equal(short.json.data.items.length, 0);
  assert.equal(short.json.data.omitted[0].reason, 'budget');
  const full = await call(['context', 'Training', '--workspace', root, '--max-chars', '1000']);
  assert.equal(full.json.data.items.length, 1);
  assert(full.json.data.items[0].revision);
  assert(full.json.data.items[0].content.endsWith('|1|2|'));
});
test('cloud is optional and a missing key has a distinct exit code', async (t) => {
  const { call } = await setup(t);
  const r = await call(['memos', 'search', 'test', '--collection', 'test-id']);
  assert.equal(r.code, 4);
  assert.equal(r.json.error.code, 'NOT_CONFIGURED');
});
test('help aliases and unknown commands never implicitly open the desktop app', async (t) => {
  const { call } = await setup(t);
  for (const args of [['-h'], ['help'], ['--help']]) {
    const result = await call(args);
    assert.equal(result.code, 0);
    assert.match(result.json.data.help, /folio read/);
  }
  for (const args of [['typo'], ['-invalid']]) {
    const result = await call(args);
    assert.equal(result.code, 2);
    assert.equal(result.json.error.code, 'USAGE');
  }
});
test('one-off CLI reads do not register a project, while library add and remove are explicit', async (t) => {
  const { root, state, call } = await setup(t);
  await fs.writeFile(path.join(root, 'note.md'), 'local source');
  assert.equal((await call(['read', 'note.md', '--workspace', root])).code, 0);
  await assert.rejects(fs.access(path.join(state, 'document-library.json')), { code: 'ENOENT' });
  const added = await call(['library', 'add', root]);
  assert.equal(added.code, 0);
  assert(added.json.data.id);
  const removed = await call(['library', 'remove', added.json.data.id]);
  assert.equal(removed.code, 0);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'local source');
});
