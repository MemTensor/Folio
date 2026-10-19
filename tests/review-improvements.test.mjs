import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { scheduleBounded, cancelBounded } from '../src/bounded-debounce.mjs';
const require = createRequire(import.meta.url);
const { FileStore } = require('../core/file-store.cjs');
const { saveAsDocument } = require('../core/save-as.cjs');
const { DocumentSearch } = require('../core/document-search.cjs');
const { MemosCloud, searchKnowledge } = require('../core/memos-cloud.cjs');
const { AgentTasks } = require('../core/agent-tasks.cjs');
const { invokeDws } = require('../core/dingtalk-cli.cjs');
const { DingTalkSync } = require('../core/dingtalk-sync.cjs');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-review-fixes-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('continuous typing retains drafts every two seconds and saves within ten seconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const drafts = new Map(),
    saves = new Map();
  let retained = 0,
    saved = 0;
  for (let i = 0; i < 600; i++) {
    scheduleBounded(drafts, 'a', () => retained++, 350, 2000);
    scheduleBounded(saves, 'a', () => saved++, 1500, 10000);
    t.mock.timers.tick(100);
  }
  assert.equal(retained, 30);
  assert.equal(saved, 6);
  scheduleBounded(drafts, 'a', () => retained++, 350, 2000);
  cancelBounded(drafts, 'a');
  t.mock.timers.tick(3000);
  assert.equal(retained, 30);
});
test('save-as reports a completed disk write even when workspace admission fails', async (t) => {
  const root = await fixture(t),
    store = new FileStore(path.join(root, 'state'));
  await store.setRoot(root);
  const p = path.join(root, 'saved.md');
  const saved = await saveAsDocument(
    store,
    { path: p, content: '# Kept\n', eol: 'LF', bom: false },
    async () => {
      throw Error('workspace cap');
    },
  );
  assert.equal(saved.openWarning, true);
  assert.equal(await fs.readFile(p, 'utf8'), '# Kept\n');
  assert.equal(saved.hash, (await store.read(p)).hash);
});
test('invalid UTF-8 produces a stable encoding diagnostic and leaves source bytes intact', async (t) => {
  const root = await fixture(t),
    store = new FileStore(path.join(root, 'state'));
  await store.setRoot(root);
  const p = path.join(root, 'invalid.md'),
    bytes = Buffer.from([0xff, 0xfe, 0x80]);
  await fs.writeFile(p, bytes);
  await assert.rejects(store.read(p), { code: 'ENCODING' });
  assert.deepEqual(await fs.readFile(p), bytes);
});
test('search runs in a worker and a replacement query cancels the earlier result', async (t) => {
  const root = await fixture(t),
    search = new DocumentSearch();
  t.after(() => search.close());
  await fs.writeFile(path.join(root, 'one.md'), '# One\nneedle\n');
  const old = search.search(root, root, 'old');
  const current = search.search(root, root, 'needle');
  assert.deepEqual(await old, []);
  const results = await current;
  assert.equal(results.length, 1);
  assert.equal(results[0].line, 2);
  assert.equal(results[0].text, 'needle');
});
test('cloud responses are byte-bounded and write failures remain uncertain', async (t) => {
  const root = await fixture(t);
  const cloud = new MemosCloud(root, {
    apiKey: 'generated-key',
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 0, data: 'x'.repeat(4 * 1024 * 1024) })),
  });
  await assert.rejects(cloud.search('q', 'kb'), { code: 'BAD_RESPONSE' });
  await assert.rejects(cloud.upload('kb', []), { code: 'REMOTE_UNCERTAIN' });
});
test('connection snapshot keeps destructive requests on their original endpoint and credentials', async (t) => {
  const root = await fixture(t),
    requests = [];
  const cloud = new MemosCloud(root, {
    fetchImpl: async (url, input) => {
      requests.push({ url, key: input.headers.Authorization });
      return new Response('{"code":0}');
    },
  });
  await cloud.configure({ baseURL: 'https://a.invalid/v1', apiKey: 'generated-key-a' });
  const scoped = await cloud.scopedConnection();
  await cloud.configure({ baseURL: 'https://b.invalid/v1', apiKey: 'generated-key-b' });
  await scoped.removeDocuments(['a-file']);
  assert.equal(requests[0].url, 'https://a.invalid/v1/delete/knowledgebase-file');
  assert.equal(requests[0].key, 'Token generated-key-a');
});
test('cloud identity is installation-scoped and missing optional credentials remain diagnostic', async (t) => {
  const root = await fixture(t),
    a = new MemosCloud(path.join(root, 'a')),
    b = new MemosCloud(path.join(root, 'b'));
  assert.notEqual((await a.config()).userId, (await b.config()).userId);
  assert.equal(
    (await a.config()).userId,
    (await new MemosCloud(path.join(root, 'a')).config()).userId,
  );
  const previous = process.env.MEMOS_API_KEY_FILE;
  process.env.MEMOS_API_KEY_FILE = path.join(root, 'missing');
  try {
    const status = await a.status();
    assert.equal(status.configured, false);
    assert.equal(status.error.code, 'CONFIG');
  } finally {
    if (previous === undefined) delete process.env.MEMOS_API_KEY_FILE;
    else process.env.MEMOS_API_KEY_FILE = previous;
  }
});
test('DingTalk rejects path-like document identifiers before reading bindings', () => {
  const sync = new DingTalkSync('/unused-generated-state');
  assert.throws(() => sync.bindingFile('../../cloud/credential'), { code: 'CONFIG' });
  assert.throws(() => sync.planFile('-'.repeat(36)), { code: 'USAGE' });
  assert.deepEqual(sync.visible({ state: 'synced', apiKey: 'secret', jsonml: [] }), {
    state: 'synced',
  });
});
test('DingTalk child receives its auth configuration but no unrelated model credentials', async (t) => {
  const root = await fixture(t),
    binary = path.join(root, 'generated-dws');
  await fs.writeFile(
    binary,
    '#!' +
      process.execPath +
      '\nconsole.log(JSON.stringify({ memos:process.env.MEMOS_API_KEY || null, dws:process.env.DWS_TEST_VALUE }));\n',
    { mode: 0o700 },
  );
  const env = {
    MEMOS_API_KEY: process.env.MEMOS_API_KEY,
    DWS_TEST_VALUE: process.env.DWS_TEST_VALUE,
  };
  process.env.MEMOS_API_KEY = 'generated-secret';
  process.env.DWS_TEST_VALUE = 'kept';
  try {
    assert.deepEqual(await invokeDws(binary, []), { memos: null, dws: 'kept' });
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
test('a replacement on another cloud never retires the only local-connection projection', async (t) => {
  const { KnowledgeStore } = require('../core/knowledge.cjs');
  const root = await fixture(t),
    store = new FileStore(path.join(root, 'state'));
  await store.setRoot(root);
  const file = path.join(root, 'source.md');
  await fs.writeFile(file, '# Generated source');
  const knowledge = new KnowledgeStore(store),
    { document } = await knowledge.inspect(file);
  const calls = [],
    cloud = new MemosCloud(store.dataDir, {
      baseURL: 'https://a.invalid/v1',
      apiKey: 'generated-key',
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response('{"code":0}');
      },
    });
  const old = {
    id: 'old-a',
    baseURL: 'https://a.invalid/v1',
    knowledgebaseId: 'kb',
    documentId: document.id,
    revision: document.revision,
    mode: 'navigation',
    state: 'ready',
    createdAt: 1,
    fileIds: ['only-a'],
  };
  await knowledge.mutate((db) => {
    db.publications[old.id] = old;
    db.publications['new-b'] = {
      ...old,
      id: 'new-b',
      baseURL: 'https://b.invalid/v1',
      createdAt: 2,
      fileIds: ['new-b'],
    };
  });
  assert.equal((await new AgentTasks(knowledge, cloud).maintain('kb')).retired, 0);
  assert.deepEqual(calls, []);
});
test('search source association is connection-bound, shape-checked and resolves duplicates once', async (t) => {
  const root = await fixture(t);
  let rows = Array.from({ length: 200 }, () => ({
      id: 'memory',
      file_id: 'same-remote-id',
      memory_value: 'generated hint',
    })),
    resolves = 0;
  const cloud = new MemosCloud(root, {
    baseURL: 'https://b.invalid/v1',
    apiKey: 'generated-key',
    fetchImpl: async () => new Response(JSON.stringify({ data: { memory_detail_list: rows } })),
  });
  const knowledge = {
    publications: async () => [
      {
        baseURL: 'https://a.invalid/v1',
        knowledgebaseId: 'kb',
        documentId: 'a',
        fileIds: ['same-remote-id'],
        state: 'ready',
      },
    ],
    resolve: async () => {
      resolves++;
      return { path: 'a.md' };
    },
  };
  assert.equal((await searchKnowledge(knowledge, cloud, 'q', 'kb')).items[0].source, null);
  assert.equal(resolves, 0);
  knowledge.publications = async () => [
    {
      baseURL: 'https://b.invalid/v1',
      knowledgebaseId: 'kb',
      documentId: 'b',
      fileIds: ['same-remote-id'],
      state: 'ready',
    },
  ];
  assert.equal((await searchKnowledge(knowledge, cloud, 'q', 'kb')).items.length, 1);
  assert.equal(resolves, 1);
  rows = {};
  await assert.rejects(searchKnowledge(knowledge, cloud, 'q', 'kb'), { code: 'BAD_RESPONSE' });
});

test('API vision is opt-in and the adapter advertises the saved capability', async (t) => {
  const { AgentSettings } = require('../core/agent-settings.cjs');
  const { CompatibleClient } = require('../core/compatible-client.cjs');
  const root = await fixture(t),
    settings = new AgentSettings(root);
  const input = { provider: 'api', baseURL: 'http://127.0.0.1/v1', model: 'generated-text-model' };
  await settings.configure(input);
  const client = new CompatibleClient(settings);
  await client.start();
  assert.deepEqual((await client.request('model/list')).data[0].inputModalities, ['text']);
  await settings.configure({ ...input, imageInput: true });
  await client.start();
  assert.deepEqual((await client.request('model/list')).data[0].inputModalities, ['text', 'image']);
  await assert.rejects(settings.configure({ ...input, imageInput: 'yes' }), {
    code: 'AGENT_CONFIG',
  });
});

test('expired DingTalk plans are bounded cleanup; current plans and non-plan files survive', async (t) => {
  const { randomUUID } = require('node:crypto');
  const root = await fixture(t),
    sync = new DingTalkSync(root),
    id = randomUUID(),
    current = randomUUID();
  await fs.mkdir(path.dirname(sync.planFile(id)), { recursive: true });
  await fs.writeFile(sync.planFile(id), '{}');
  await fs.writeFile(sync.planFile(current), '{}');
  const unrelated = path.join(path.dirname(sync.planFile(id)), 'notes.json');
  await fs.writeFile(unrelated, '{}');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(sync.planFile(id), old, old);
  await fs.utimes(unrelated, old, old);
  assert.equal(await sync.pruneExpiredPlans(), 1);
  assert.equal(await fs.readFile(sync.planFile(current), 'utf8'), '{}');
  assert.equal(await fs.readFile(unrelated, 'utf8'), '{}');
});

test('publication retention preserves uncertain submissions and caps completed journals and payloads', () => {
  const { retainPublications } = require('../core/publication-retention.cjs');
  const entries = Object.fromEntries(
    Array.from({ length: 250 }, (_, i) => [
      String(i),
      { id: String(i), state: 'retired', createdAt: i },
    ]),
  );
  entries.pending = {
    id: 'pending',
    state: 'uncertain',
    response: { data: { huge: 'private body' } },
    fileIds: ['retained-remote-id'],
  };
  retainPublications(entries);
  assert.equal(Object.keys(entries).length, 201);
  assert.deepEqual(entries.pending.fileIds, ['retained-remote-id']);
  assert(!JSON.stringify(entries).includes('private body'));
});

test('missing optional cloud key does not block a task in a memory-disabled project', async (t) => {
  const { KnowledgeStore } = require('../core/knowledge.cjs');
  const root = await fixture(t),
    store = new FileStore(path.join(root, 'state'));
  await store.setRoot(root);
  await fs.mkdir(path.join(store.dataDir, 'cloud'), { recursive: true });
  await fs.writeFile(
    path.join(store.dataDir, 'cloud/config.json'),
    JSON.stringify({ keyFile: path.join(root, 'missing-key') }),
  );
  const tasks = new AgentTasks(new KnowledgeStore(store), new MemosCloud(store.dataDir));
  assert.equal((await tasks.begin('generated local-only task')).memory.enabled, false);
});

test('DingTalk errors redact authorization headers and app keys in all public fields', async (t) => {
  const root = await fixture(t),
    binary = path.join(root, 'generated-dws-error');
  await fs.writeFile(
    binary,
    '#!' +
      process.execPath +
      '\nconsole.error(JSON.stringify({error:{message:"Authorization: Bearer generated-secret appKey=generated-app-key",reason:"Authorization: Bearer generated-secret",category:"auth"}}));process.exitCode=1;\n',
    { mode: 0o700 },
  );
  await assert.rejects(invokeDws(binary, []), (error) => {
    const visible = JSON.stringify({ message: error.message, details: error.details });
    assert(!visible.includes('generated-secret'));
    assert(!visible.includes('generated-app-key'));
    return error.code === 'DWS_AUTH';
  });
});

test('the CLI finds a version-expanded development bundle without the Applications fallback', async () => {
  const vm = require('node:vm');
  const source = await fs.readFile(new URL('../cli/main.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function appBundle()'),
    end = source.indexOf('async function run(', start);
  const expected = '/generated/release/v1.2.3/mac-arm64/Folio.app';
  const found = await vm.runInNewContext(source.slice(start, end) + '\nappBundle()', {
    __dirname: '/generated/cli',
    path,
    require: () => require('../core/build-output.cjs'),
    packageInfo: { version: '1.2.3', build: { directories: { output: 'release/v${version}' } } },
    process: { env: {}, arch: 'arm64' },
    fs: {
      stat: async (p) => {
        if (p !== expected + '/Contents/MacOS/Folio') throw Error('not found');
        return { isFile: () => true };
      },
    },
    CloudError: Error,
  });
  assert.equal(found, expected);
});

test('search timeouts also count retiring workers and cannot accumulate stalled threads', async (t) => {
  const { EventEmitter } = require('node:events');
  const workers = [];
  const search = new DocumentSearch({
    timeout: 5,
    workerFactory: () => {
      const worker = new EventEmitter();
      worker.postMessage = () => {};
      worker.unref = () => {};
      worker.terminate = () =>
        new Promise((resolve) => {
          worker.release = resolve;
        });
      workers.push(worker);
      return worker;
    },
  });
  t.after(() => {
    search.close();
    for (const worker of workers) worker.release?.();
  });
  await assert.rejects(search.search('/generated', '/generated-state', 'first'), {
    code: 'SEARCH_TIMEOUT',
  });
  await assert.rejects(search.search('/generated', '/generated-state', 'second'), {
    code: 'SEARCH_TIMEOUT',
  });
  await assert.rejects(search.search('/generated', '/generated-state', 'third'), {
    code: 'SEARCH_BUSY',
  });
  assert.equal(workers.length, 2);
});

test('deep cloud responses fail within the response budget and preserve write uncertainty', async (t) => {
  const root = await fixture(t);
  const text = '{"data":' + '['.repeat(100) + '0' + ']'.repeat(100) + '}';
  const cloud = new MemosCloud(root, {
    apiKey: 'generated-key',
    fetchImpl: async () => new Response(text),
  });
  await assert.rejects(cloud.search('q', 'kb'), { code: 'BAD_RESPONSE' });
  await assert.rejects(cloud.upload('kb', []), { code: 'REMOTE_UNCERTAIN' });
});

test('staging cleanup removes only owned dead preparations and preserves active, launched and replaced directories', async (t) => {
  const { cleanupPreparations } = require('../core/update-staging.cjs');
  const { randomUUID } = require('node:crypto');
  const root = await fixture(t),
    directory = path.join(root, 'updates'),
    target = path.join(root, 'Folio.app');
  await fs.mkdir(directory);
  const identity = async (p) => {
    const stat = await fs.lstat(p, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  };
  const make = async (label, { live = false, launched = false, replaced = false } = {}) => {
    const id = randomUUID(),
      transaction = path.join(directory, 'install-' + label),
      stage = path.join(root, '.folio-update-' + id + '.app');
    await fs.mkdir(transaction);
    await fs.mkdir(stage);
    await fs.writeFile(path.join(stage, 'generated.txt'), label);
    const receipt = {
      id,
      pid: live ? 10 : 20,
      targetPath: target,
      transactionDir: transaction,
      stagePath: stage,
      transactionIdentity: await identity(transaction),
      stageIdentity: await identity(stage),
    };
    if (replaced) receipt.stageIdentity.ino = '-1';
    const file = path.join(transaction, 'preparation.json');
    await fs.writeFile(file, JSON.stringify(receipt));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(file, old, old);
    if (launched) await fs.writeFile(path.join(transaction, 'plan.json'), '{}');
    return { transaction, stage };
  };
  const abandoned = await make('abandoned'),
    active = await make('active', { live: true }),
    launched = await make('launched', { launched: true }),
    replaced = await make('replaced', { replaced: true });
  assert.equal(await cleanupPreparations(directory, target, { isAlive: (pid) => pid === 10 }), 1);
  await assert.rejects(fs.stat(abandoned.stage), { code: 'ENOENT' });
  for (const item of [active, launched, replaced])
    assert((await fs.stat(item.stage)).isDirectory());
});
