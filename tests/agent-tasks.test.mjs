import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { FileStore } = require('../core/file-store.cjs'),
  { KnowledgeStore } = require('../core/knowledge.cjs'),
  { MemosCloud } = require('../core/memos-cloud.cjs'),
  { AgentTasks } = require('../core/agent-tasks.cjs');
async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-tasks-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const state = path.join(tmp, 'state'),
    roots = [path.join(tmp, 'a'), path.join(tmp, 'b')];
  await Promise.all(roots.map((p) => fs.mkdir(p)));
  const calls = [];
  let n = 0;
  const cloud = new MemosCloud(state, {
    apiKey: 'unit-test-key',
    fetchImpl: async (url, args) => {
      calls.push({ url, body: JSON.parse(args.body) });
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/add/knowledgebase-file')
            ? { code: 0, data: [{ id: 'upload-' + ++n }] }
            : url.endsWith('/get/knowledgebase-file')
              ? {
                  code: 0,
                  data: { file_detail_list: [{ id: 'upload-' + n, status: 'AVAILABLE' }] },
                }
              : { code: 0, data: { memory_detail_list: [], success: true } },
      };
    },
  });
  const stores = await Promise.all(
    roots.map(async (root) => {
      const s = new FileStore(state);
      await s.setRoot(root);
      return s;
    }),
  );
  return { cloud, stores, roots, calls };
}
test('a configured API does not silently enable memory in an unbound project', async (t) => {
  const { cloud, stores, calls } = await setup(t);
  const result = await new AgentTasks(new KnowledgeStore(stores[0]), cloud).begin(
    'write a document',
  );
  assert.equal(result.memory.enabled, false);
  assert.equal(calls.length, 0);
  assert(result.task.startedAt);
});
test('task memory uses the current project binding and does not inherit another project', async (t) => {
  const { cloud, stores, calls } = await setup(t);
  await cloud.attachCollection('kb-a', 'A');
  await cloud.attachCollection('kb-b', 'B');
  await cloud.bindProject(stores[0].root, 'kb-a');
  await cloud.bindProject(stores[1].root, 'kb-b');
  const a = await new AgentTasks(new KnowledgeStore(stores[0]), cloud).begin('A task');
  const b = await new AgentTasks(new KnowledgeStore(stores[1]), cloud).begin('B task');
  assert.equal(a.task.knowledgebaseId, 'kb-a');
  assert.equal(b.task.knowledgebaseId, 'kb-b');
  assert.deepEqual(
    calls.filter((c) => c.url.endsWith('/search/memory')).map((c) => c.body.knowledgebase_ids),
    [['kb-a'], ['kb-b']],
  );
});
test('task finish indexes only declared relevant files and replay does not upload again', async (t) => {
  const { cloud, stores, calls } = await setup(t);
  const store = stores[0],
    file = path.join(store.root, 'note.md');
  await fs.writeFile(file, '# Topic\n\nDescription\n\n## Details\nVALUE_ONLY_IN_SOURCE');
  await cloud.attachCollection('kb', 'Project');
  await cloud.bindProject(store.root, 'kb');
  const knowledge = new KnowledgeStore(store),
    tasks = new AgentTasks(knowledge, cloud),
    task = await tasks.begin('Document task'),
    revision = (await store.read(file)).hash;
  const done = await tasks.finish(task.task.id, {
    documents: [
      {
        path: file,
        expectedRevision: revision,
        summary: 'Topic overview',
        whenToRead: 'When working on this topic',
      },
    ],
  });
  assert.equal(done.state, 'finished');
  assert.equal(done.results.length, 1);
  assert.equal((await tasks.finish(task.task.id)).replayed, true);
  const uploads = calls.filter((c) => c.url.endsWith('/add/knowledgebase-file'));
  assert.equal(uploads.length, 1);
  const body = Buffer.from(uploads[0].body.file[0].content.split(',')[1], 'base64').toString();
  assert(!body.includes('VALUE_ONLY_IN_SOURCE'));
});
test('changing the project binding during a task does not redirect its indexing', async (t) => {
  const { cloud, stores, calls } = await setup(t);
  await cloud.attachCollection('kb-a', 'A');
  await cloud.attachCollection('kb-b', 'B');
  await cloud.bindProject(stores[0].root, 'kb-a');
  const tasks = new AgentTasks(new KnowledgeStore(stores[0]), cloud),
    started = await tasks.begin('Task');
  await cloud.bindProject(stores[0].root, 'kb-b');
  const done = await tasks.finish(started.task.id);
  assert.equal(done.memoryStatus, 'binding-changed');
  assert.equal(calls.filter((c) => c.url.endsWith('/add/knowledgebase-file')).length, 0);
});
