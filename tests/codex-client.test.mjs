import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { CodexClient } = createRequire(import.meta.url)('../core/codex-client.cjs');

async function fixture(t, options = {}) {
  const directory = await mkdtemp('/private/tmp/folio-codex-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
  });
  child.kill = () => {
    child.killed = true;
    child.signalCode = 'SIGTERM';
    child.emit('exit');
  };
  const sent = [];
  let launch;
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const frame = JSON.parse(line);
      sent.push(frame);
      if (frame.method === 'initialize')
        queueMicrotask(() =>
          child.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\n'),
        );
      if (frame.method === 'config/read')
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              id: frame.id,
              result: {
                config: {
                  permissions: {
                    'folio-documents': {
                      filesystem: { ':root': 'deny', [directory + '/cwd']: 'read' },
                      network: { enabled: false },
                    },
                  },
                },
              },
            }) + '\n',
          ),
        );
      if (frame.method === 'permissionProfile/list')
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              id: frame.id,
              result: { data: [{ id: 'folio-documents', allowed: true }] },
            }) + '\n',
          ),
        );
    }
  });
  const client = new CodexClient({
    home: directory + '/home',
    cwd: directory + '/cwd',
    version: 'test',
    executable: '/generated/codex',
    spawnProcess: (...args) => {
      launch = args;
      return child;
    },
    ...options,
  });
  t.after(() => client.stop());
  await client.start();
  return { client, child, sent, launch };
}

test('transport uses isolated credentials, disables tools and performs the official handshake', async (t) => {
  const { sent, launch } = await fixture(t);
  assert.equal(launch[0], '/generated/codex');
  assert.deepEqual(launch[1].slice(0, 3), ['app-server', '--listen', 'stdio://']);
  assert(launch[1].includes('features.shell_tool=false'));
  assert(launch[1].includes('features.plugins=false'));
  assert(launch[2].env.CODEX_HOME.endsWith('/home'));
  assert(!Object.keys(launch[2].env).some((name) => /^OPENAI_/.test(name)));
  assert.equal(launch[2].env.CODEX_PERMISSION_PROFILE, undefined);
  assert(launch[1].includes('default_permissions="folio-documents"'));
  assert(launch[1].includes('permissions.folio-documents.network={"enabled"=false}'));
  assert(
    launch[1].some((arg) =>
      arg.startsWith('permissions.folio-documents.filesystem={":root"="deny",":minimal"="read",'),
    ),
  );
  assert.equal(sent[0].params.clientInfo.name, 'folio');
  assert.equal(sent[1].method, 'initialized');
});

test('fragmented responses and notifications are routed without exposing server errors', async (t) => {
  const { client, child, sent } = await fixture(t);
  const result = client.request('account/read');
  const id = sent.at(-1).id;
  const data = JSON.stringify({ id, result: { account: { type: 'chatgpt' } } }) + '\n';
  child.stdout.write(data.slice(0, 8));
  child.stdout.write(data.slice(8));
  assert.equal((await result).account.type, 'chatgpt');
  const events = [];
  client.on('notification', (...args) => events.push(args));
  child.stdout.write('{"method":"turn/started","params":{"threadId":"test"}}\n');
  assert.equal(events[0][0], 'turn/started');
  const failing = client.request('turn/start');
  child.stdout.write(
    JSON.stringify({ id: sent.at(-1).id, error: { message: 'SECRET_TOKEN_MUST_NOT_LEAK' } }) + '\n',
  );
  await assert.rejects(
    failing,
    (e) => !e.message.includes('SECRET_TOKEN') && e.code === 'AGENT_CONNECTION',
  );
});

test('server tool requests are rejected and malformed streams disconnect safely', async (t) => {
  const { client, child, sent } = await fixture(t);
  child.stdout.write(
    '{"id":"tool-1","method":"item/commandExecution/requestApproval","params":{}}\n',
  );
  assert.equal(sent.at(-1).error.code, -32601);
  const pending = client.request('account/read');
  child.stdout.write('invalid JSON\n');
  await assert.rejects(pending, /通信格式/);
  assert.equal(child.killed, true);
});

test('disconnect rejects all pending calls and a bounded timeout clears its request', async (t) => {
  const { client } = await fixture(t, { timeout: 10 });
  const keepAlive = setTimeout(() => {}, 100);
  await assert.rejects(client.request('no-response'), /超时/);
  clearTimeout(keepAlive);
  assert.equal(client.pending.size, 0);
  const first = client.request('first'),
    second = client.request('second');
  client.stop();
  await assert.rejects(first, /断开/);
  await assert.rejects(second, /断开/);
});

test('only dynamic document calls reach the owner; approvals and requests after disconnection stay rejected', async (t) => {
  const { client, child, sent } = await fixture(t);
  client.toolHandler = async (params) => ({
    success: params.tool === 'folio_read_document',
    contentItems: [{ type: 'inputText', text: 'Generated document excerpt' }],
  });
  child.stdout.write(
    JSON.stringify({
      id: 'read-1',
      method: 'item/tool/call',
      params: { tool: 'folio_read_document' },
    }) + '\n',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.at(-1).result.success, true);
  child.stdout.write(
    JSON.stringify({ id: 'permission-1', method: 'item/permissions/requestApproval', params: {} }) +
      '\n',
  );
  assert.equal(sent.at(-1).error.code, -32601);
  let release;
  client.toolHandler = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  child.stdout.write(
    JSON.stringify({ id: 'read-late', method: 'item/tool/call', params: {} }) + '\n',
  );
  await new Promise((resolve) => setImmediate(resolve));
  client.stop();
  release({ success: true, contentItems: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert(!sent.some((frame) => frame.id === 'read-late'));
});

test('closing before runtime resolution prevents a late child spawn', async (t) => {
  const directory = await mkdtemp('/private/tmp/folio-codex-close-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let spawns = 0;
  const client = new CodexClient({
    home: directory + '/home',
    cwd: directory + '/cwd',
    version: 'test',
    executable: '/generated/codex',
    spawnProcess: () => {
      spawns++;
      throw Error('late spawn');
    },
  });
  const started = client.start();
  const rejected = assert.rejects(started, { code: 'AGENT_CONNECTION' });
  await client.close();
  await rejected;
  assert.equal(spawns, 0);
  assert.equal(client.child, null);
});
