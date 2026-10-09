import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerAgent } = require('../electron/agent.cjs');
const { Workspaces } = require('../core/workspaces.cjs');

test('Agent IPC resolves its project from the document and rejects other projects, secrets and escaped symlinks', async (t) => {
  const dir = await mkdtemp('/private/tmp/folio-agent-ipc-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = dir + '/a',
    b = dir + '/b',
    data = dir + '/state';
  await mkdir(a);
  await mkdir(b);
  await writeFile(a + '/Doc.md', '# Current\n');
  await writeFile(a + '/Ref.md', '# Reference\n');
  await writeFile(a + '/secret.env', 'must not read');
  await writeFile(b + '/Other.md', '# Other project\n');
  await symlink(b + '/Other.md', a + '/Escape.md');
  const workspaces = new Workspaces(data);
  await workspaces.admit(a);
  await workspaces.admit(b);
  const handlers = new Map();
  let received;
  registerAgent({
    handle: (name, fn) => handlers.set(name, fn),
    workspaces,
    agentService: {
      send: async (input) => {
        received = input;
        return input;
      },
    },
  });
  const send = handlers.get('agent-send');
  const request = {
    root: b,
    path: a + '/Doc.md',
    content: '# Unsaved draft\n',
    instruction: 'Explain',
    mode: 'ask',
    references: [a + '/Ref.md'],
  };
  await send(request);
  assert.equal(received.root, a);
  assert.equal(received.content, '# Unsaved draft\n');
  assert.deepEqual(received.references, [{ name: 'Ref.md', content: '# Reference\n' }]);
  await assert.rejects(send({ ...request, references: [b + '/Other.md'] }), /当前项目/);
  await assert.rejects(send({ ...request, references: [a + '/secret.env'] }), /Markdown/);
  await assert.rejects(send({ ...request, references: [a + '/Escape.md'] }), /项目外部/);
  await assert.rejects(send({ ...request, path: dir + '/unadmitted.md' }), /已打开的项目/);
});
