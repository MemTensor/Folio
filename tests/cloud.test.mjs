import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { MemosCloud, publish, refreshPublication } = require('../core/memos-cloud.cjs'),
  { FileStore } = require('../core/file-store.cjs'),
  { KnowledgeStore } = require('../core/knowledge.cjs');
const reply = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});
async function setup(t, fetchImpl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-cloud-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'docs'),
    state = path.join(dir, 'state');
  await fs.mkdir(root);
  const store = new FileStore(state);
  await store.setRoot(root);
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, '# A\n\nA generated test document.\n');
  return {
    root,
    state,
    store,
    knowledge: new KnowledgeStore(store),
    cloud: new MemosCloud(state, { apiKey: 'mpg-unit-test-placeholder', fetchImpl }),
    file,
  };
}
test('cloud request uses the verified endpoint and redacts credential echoes', async (t) => {
  let seen;
  const { cloud } = await setup(t, async (url, args) => {
    seen = { url, args };
    return reply({ code: 0, data: { echo: 'mpg-unit-test-placeholder' } });
  });
  const result = await cloud.search('query', 'kb-1');
  assert(seen.url.endsWith('/search/memory'));
  assert.equal(JSON.parse(seen.args.body).knowledgebase_ids[0], 'kb-1');
  assert.equal(seen.args.redirect, 'error');
  assert.equal(result.data.echo, '[REDACTED]');
});
test('failed mutations are not automatically retried', async (t) => {
  let n = 0;
  const { cloud } = await setup(t, async () => {
    n++;
    throw Error('timeout');
  });
  await assert.rejects(cloud.addCollection('Test'), { code: 'REMOTE_UNCERTAIN' });
  assert.equal(n, 1);
});
test('non-HTTPS cloud endpoints are rejected before receiving a key', async (t) => {
  const { state } = await setup(t);
  const cloud = new MemosCloud(state, { apiKey: 'fake', baseURL: 'http://untrusted.example' });
  await assert.rejects(cloud.search('q', 'kb'), { code: 'CONFIG' });
});
test('same source package is uploaded once and readiness is checked explicitly', async (t) => {
  let uploads = 0;
  const { knowledge, cloud, file, store } = await setup(t, async (url, args) => {
    if (url.endsWith('/add/knowledgebase-file')) {
      uploads++;
      const body = JSON.parse(args.body);
      assert(body.file[0].name.endsWith('.md'));
      assert(body.file[0].content.startsWith('data:text/markdown;base64,'));
      return reply({ code: 0, data: [{ id: 'file-1', status: 'PROCESSING' }] });
    }
    return reply({ code: 0, data: { file_detail_list: [{ id: 'file-1', status: 'AVAILABLE' }] } });
  });
  const hash = (await store.read(file)).hash;
  const first = await publish(knowledge, cloud, file, 'kb', { expectedRevision: hash });
  assert.equal(first.state, 'submitted');
  assert.equal(
    (await publish(knowledge, cloud, file, 'kb', { expectedRevision: hash })).duplicatePrevented,
    true,
  );
  assert.equal(uploads, 1);
  assert.equal((await refreshPublication(knowledge, cloud, first.id)).state, 'ready');
});
test('uncertain uploads leave a journal entry and block blind replay', async (t) => {
  let calls = 0;
  const { knowledge, cloud, file, store } = await setup(t, async () => {
    calls++;
    throw Error('network');
  });
  const hash = (await store.read(file)).hash;
  await assert.rejects(publish(knowledge, cloud, file, 'kb', { expectedRevision: hash }), {
    code: 'REMOTE_UNCERTAIN',
  });
  const retry = await publish(knowledge, cloud, file, 'kb', { expectedRevision: hash });
  assert.equal(retry.state, 'uncertain');
  assert.equal(retry.duplicatePrevented, true);
  assert.equal(calls, 1);
});
test('unknown external changes never acquire a guessed model author', async (t) => {
  const { knowledge, file, store } = await setup(t);
  await knowledge.inspect(file);
  await fs.writeFile(file, 'External new content');
  const p = await knowledge.provenance(file);
  assert.equal(p.events.at(-1).actor, 'external-unknown');
  assert.equal(p.events.at(-1).origin, 'unknown');
});
test('document identity survives a managed rename', async (t) => {
  const { knowledge, file, root } = await setup(t);
  const before = await knowledge.provenance(file),
    next = path.join(root, 'renamed.md');
  await fs.rename(file, next);
  await knowledge.rename(file, next);
  assert.equal((await knowledge.provenance(next)).id, before.id);
});
test('asset revisions participate in publication deduplication', async (t) => {
  const { knowledge, file, root } = await setup(t);
  const image = path.join(root, 'image.png');
  await fs.writeFile(image, Buffer.from([1, 2, 3]));
  await fs.writeFile(file, '# Image\n\n![test](image.png)');
  const first = await knowledge.publishPlan(file, 'kb', { includeAssets: true, mode: 'full' });
  await fs.writeFile(image, Buffer.from([4, 5, 6]));
  const second = await knowledge.publishPlan(file, 'kb', { includeAssets: true, mode: 'full' });
  assert.equal(first.revision, second.revision);
  assert.notEqual(first.packageRevision, second.packageRevision);
});
test('scoped knowledge operations keep their original workspace', async (t) => {
  const { knowledge, store, file, root } = await setup(t);
  const scoped = knowledge.scoped();
  await store.setRoot(path.dirname(root));
  const result = await scoped.inspect(file);
  assert.equal(scoped.store.root, await fs.realpath(root));
  assert(result.document.id);
});
test('navigation is the default and detailed source text stays local', async (t) => {
  const { knowledge, file } = await setup(t);
  await fs.writeFile(
    file,
    '# Training\n\nOverview for routing.\n\n## Exact details\nDETAIL_ONLY_IN_ORIGINAL_927\n\n$$\nx=927\n$$',
  );
  const card = await knowledge.publishPlan(file, 'kb');
  assert.equal(card.mode, 'navigation');
  assert(card.content.includes('Exact details'));
  assert(!card.content.includes('DETAIL_ONLY_IN_ORIGINAL_927'));
  assert(!card.content.includes('x=927'));
  const full = await knowledge.publishPlan(file, 'kb', { mode: 'full' });
  assert(full.content.includes('DETAIL_ONLY_IN_ORIGINAL_927'));
});
test('navigation anchors lead to current source and expose stale index versions', async (t) => {
  const { searchKnowledge } = require('../core/memos-cloud.cjs');
  let anchor;
  const { knowledge, cloud, file, store } = await setup(t, async (url) =>
    url.endsWith('/add/knowledgebase-file')
      ? reply({ code: 0, data: [{ id: 'remote-card' }] })
      : reply({
          code: 0,
          data: {
            memory_detail_list: [{ id: 'memory-1', memory_value: 'Original text: ' + anchor }],
          },
        }),
  );
  const before = await store.read(file);
  const publication = await publish(knowledge, cloud, file, 'kb', {
    expectedRevision: before.hash,
  });
  anchor = publication.reference;
  await fs.writeFile(file, 'Updated source');
  const result = await searchKnowledge(knowledge, cloud, 'query', 'kb');
  assert.equal(result.items[0].source.documentId, publication.documentId);
  assert.equal(result.items[0].source.association, 'navigation-anchor');
  assert.equal(result.items[0].source.stale, true);
  assert.notEqual(result.items[0].source.currentRevision, before.hash);
});

test('an unknown upload without file IDs requires explicit recovery before retrying', async (t) => {
  const { resolvePublication } = require('../core/memos-cloud.cjs');
  let uploads = 0;
  const { knowledge, cloud, file, store } = await setup(t, async () => {
    uploads++;
    throw Error('lost receipt');
  });
  const hash = (await store.read(file)).hash;
  await assert.rejects(publish(knowledge, cloud, file, 'kb', { expectedRevision: hash }), {
    code: 'REMOTE_UNCERTAIN',
  });
  const entry = (await knowledge.publications())[0];
  await assert.rejects(refreshPublication(knowledge, cloud, entry.id), {
    code: 'REMOTE_UNCERTAIN',
  });
  await assert.rejects(resolvePublication(knowledge, cloud, entry.id, { outcome: 'not-created' }), {
    code: 'CONFIRMATION_REQUIRED',
  });
  assert.equal(uploads, 1);
  const resolved = await resolvePublication(knowledge, cloud, entry.id, {
    outcome: 'not-created',
    confirmed: true,
    note: 'Checked the generated fixture list.',
  });
  assert.equal(resolved.state, 'retryable');
  assert.equal(uploads, 1);
  await assert.rejects(publish(knowledge, cloud, file, 'kb', { expectedRevision: hash }), {
    code: 'REMOTE_UNCERTAIN',
  });
  assert.equal(uploads, 2);
  assert.equal((await knowledge.publications())[0].resolutions.length, 1);
});
test('unknown uploads can associate only a complete verified set of remote file IDs', async (t) => {
  const { resolvePublication } = require('../core/memos-cloud.cjs');
  let lookupMode = 'missing',
    uploads = 0;
  const { knowledge, cloud, file, store } = await setup(t, async (url) => {
    if (url.endsWith('/add/knowledgebase-file')) {
      uploads++;
      return reply({ code: 0, data: [] });
    }
    return reply({
      code: 0,
      data: {
        file_detail_list:
          lookupMode === 'missing'
            ? []
            : [
                {
                  file_id: 'remote-1',
                  knowledgebase_id: lookupMode === 'wrong-kb' ? 'other' : 'kb',
                  status: 'AVAILABLE',
                },
              ],
      },
    });
  });
  const hash = (await store.read(file)).hash,
    entry = await publish(knowledge, cloud, file, 'kb', { expectedRevision: hash });
  assert.equal(entry.state, 'uncertain');
  await assert.rejects(
    resolvePublication(knowledge, cloud, entry.id, {
      outcome: 'attach',
      fileIds: ['remote-1'],
      confirmed: true,
    }),
    { code: 'BAD_RESPONSE' },
  );
  lookupMode = 'wrong-kb';
  await assert.rejects(
    resolvePublication(knowledge, cloud, entry.id, {
      outcome: 'attach',
      fileIds: ['remote-1'],
      confirmed: true,
    }),
    { code: 'CONFLICT' },
  );
  lookupMode = 'valid';
  const resolved = await resolvePublication(knowledge, cloud, entry.id, {
    outcome: 'attach',
    fileIds: ['remote-1'],
    confirmed: true,
  });
  assert.equal(resolved.state, 'ready');
  assert.deepEqual(resolved.fileIds, ['remote-1']);
  assert.equal(
    (await publish(knowledge, cloud, file, 'kb', { expectedRevision: hash })).duplicatePrevented,
    true,
  );
  assert.equal(uploads, 1);
});
test('failed indexing with known remote IDs never creates a duplicate upload', async (t) => {
  let uploads = 0;
  const { knowledge, cloud, file, store } = await setup(t, async (url) => {
    if (url.endsWith('/add/knowledgebase-file')) {
      uploads++;
      return reply({ code: 0, data: [{ id: 'remote-file' }] });
    }
    return reply({
      code: 0,
      data: { file_detail_list: [{ file_id: 'remote-file', status: 'FAILED' }] },
    });
  });
  const hash = (await store.read(file)).hash,
    first = await publish(knowledge, cloud, file, 'kb', { expectedRevision: hash });
  assert.equal((await refreshPublication(knowledge, cloud, first.id)).state, 'failed');
  const replay = await publish(knowledge, cloud, file, 'kb', { expectedRevision: hash });
  assert.equal(replay.state, 'failed');
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(uploads, 1);
});
