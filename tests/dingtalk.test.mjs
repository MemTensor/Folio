import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { FileStore } = require('../core/file-store.cjs'),
  { KnowledgeStore } = require('../core/knowledge.cjs'),
  { DingTalkSync } = require('../core/dingtalk-sync.cjs'),
  { DingTalkClient, DingTalkError } = require('../core/dingtalk-cli.cjs'),
  { documentProjection, matchesProjection } = require('../core/dingtalk-document.cjs');
const clone = (o) => JSON.parse(JSON.stringify(o));
async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-dingtalk-test-')),
    root = path.join(tmp, 'project'),
    data = path.join(tmp, 'state');
  await fs.mkdir(root);
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const file = path.join(root, 'notes.md');
  await fs.writeFile(
    file,
    '# Notes\n\nOriginal text.\n\n$$\nx^2+y^2=z^2\n$$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
  );
  const store = new FileStore(data);
  await store.setRoot(root);
  const knowledge = new KnowledgeStore(store),
    state = { creates: 0, writes: 0, revision: 0, jsonml: null, race: false, uncertain: false };
  const client = {
    profiles: async () => ({
      profiles: [
        { profile: 'test-corp:test-user', corpName: 'Test', userName: 'Test', isOrgCurrent: true },
      ],
      currentProfile: 'test-corp:test-user',
    }),
    create: async (name, profile, content) => {
      state.creates++;
      state.jsonml = JSON.parse(content);
      state.revision++;
      if (state.uncertain)
        throw new DingTalkError('verification failed', 'DWS_ERROR', {
          reason: 'doc_write_verification_failed',
          nodeId: 'test-node',
        });
      return { nodeId: 'test-node' };
    },
    fetch: async () => ({
      nodeId: 'test-node',
      name: 'Notes',
      revision: state.revision,
      jsonml: clone(state.jsonml),
      url: 'https://alidocs.dingtalk.com/i/nodes/test-node',
    }),
    overwrite: async (node, profile, content, expected) => {
      if (state.race) state.revision++;
      if (expected !== state.revision) throw new DingTalkError('revision conflict', 'DWS_CONFLICT');
      state.writes++;
      state.jsonml = JSON.parse(content);
      state.revision++;
      return { nodeId: node };
    },
  };
  return {
    tmp,
    root,
    data,
    file,
    store,
    knowledge,
    state,
    client,
    sync: new DingTalkSync(data, { client }),
  };
}
test('online projection renders readable formulas and preserves table cells and local images', async (t) => {
  const { file, store } = await setup(t);
  await fs.writeFile(
    path.join(path.dirname(file), 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  await fs.appendFile(file, '\n![example](image.png)\n');
  const p = await documentProjection(await store.read(file), store);
  assert.equal(p.stats.formulas, 1);
  assert.equal(p.stats.tables, 1);
  assert.equal(p.stats.images, 1);
  assert.equal(p.assets.length, 1);
  const images = [];
  const collect = (n) => {
    if (Array.isArray(n)) {
      if (n[0] === 'img') images.push(n[1]);
      n.slice(2).forEach(collect);
    }
  };
  collect(p.jsonml);
  assert.equal(images.length, 2);
  assert(images.every((i) => i.width > 0 && i.height > 0));
  assert(!p.content.includes('"tagType":"formula"'));
  assert(!p.content.includes('data:image/svg+xml;base64,'));
  assert(p.content.includes('data:image/png;base64,'));
  assert(!p.content.includes('file://'));
  const server = clone(p.jsonml);
  server[1].sectPr = { page: 1 };
  assert(matchesProjection(p.jsonml, server));
  server.push([
    'p',
    {},
    ['span', { 'data-type': 'text' }, ['span', { 'data-type': 'leaf' }, 'unexpected']],
  ]);
  assert(!matchesProjection(p.jsonml, server));
});
test('publish requires confirmation, then replay and unchanged source do not create duplicates', async (t) => {
  const { sync, knowledge, file, state } = await setup(t);
  const plan = await sync.plan(knowledge, file);
  await assert.rejects(sync.execute(knowledge, plan.id), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(state.creates, 0);
  const result = await sync.execute(knowledge, plan.id, { confirmed: true });
  assert.equal(result.state, 'synced');
  assert.equal((await sync.execute(knowledge, plan.id, { confirmed: true })).replayed, true);
  const next = await sync.plan(knowledge, file);
  assert.equal(next.action, 'current');
  await sync.execute(knowledge, next.id, { confirmed: true });
  assert.equal(state.creates, 1);
  assert.equal(state.writes, 0);
});
test('both local edits after preview and cloud edits since last sync stop publishing', async (t) => {
  const { sync, knowledge, file, state } = await setup(t);
  const stale = await sync.plan(knowledge, file);
  await fs.appendFile(file, '\nHuman update\n');
  await assert.rejects(sync.execute(knowledge, stale.id, { confirmed: true }), {
    code: 'CONFLICT',
  });
  assert.equal(state.creates, 0);
  const plan = await sync.plan(knowledge, file);
  await sync.execute(knowledge, plan.id, { confirmed: true });
  state.revision++;
  await assert.rejects(sync.plan(knowledge, file), { code: 'DWS_CONFLICT' });
  assert.equal(state.writes, 0);
});
test('a change between the read and write is rejected by the server revision condition', async (t) => {
  const { sync, knowledge, file, state } = await setup(t);
  await sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true });
  await fs.appendFile(file, '\nLocal change\n');
  const plan = await sync.plan(knowledge, file);
  state.race = true;
  await assert.rejects(sync.execute(knowledge, plan.id, { confirmed: true }), {
    code: 'DWS_CONFLICT',
  });
  assert.equal(state.writes, 0);
});
test('known partial creation is read back and checked instead of recreated', async (t) => {
  const { sync, knowledge, file, state } = await setup(t);
  state.uncertain = true;
  const result = await sync.execute(knowledge, (await sync.plan(knowledge, file)).id, {
    confirmed: true,
  });
  assert.equal(result.state, 'synced');
  assert.equal(state.creates, 1);
  assert.equal(result.runtimeVerification, 'readback-required');
});
test('a plan cannot be used for another document or project', async (t) => {
  const { sync, knowledge, file, store, data, tmp, state } = await setup(t);
  const plan = await sync.plan(knowledge, file),
    other = path.join(store.root, 'other.md');
  await fs.writeFile(other, 'Other');
  await assert.rejects(sync.execute(knowledge, plan.id, { confirmed: true, expectedPath: other }), {
    code: 'CONFLICT',
  });
  const otherRoot = path.join(tmp, 'other');
  await fs.mkdir(otherRoot);
  const next = new FileStore(data);
  await next.setRoot(otherRoot);
  await assert.rejects(sync.execute(new KnowledgeStore(next), plan.id, { confirmed: true }), {
    code: 'DWS_STALE_PLAN',
  });
  assert.equal(state.creates, 0);
});
test('the client uses JSONML, stdin, a pinned profile and the exact revision', async () => {
  const calls = [],
    client = new DingTalkClient({
      binary: '/test/dws',
      runner: async (bin, args, options) => {
        calls.push({ args, options });
        return { status: 'success', complete: true, data: { nodeId: 'node', verified: true } };
      },
    });
  await client.overwrite('node', 'corp:user', '["root",{}]', 12);
  assert(calls[0].args.includes('--expected-revision'));
  assert(calls[0].args.includes('12'));
  assert(calls[0].args.includes('jsonml'));
  assert(calls[0].args.includes('corp:user'));
  assert.equal(calls[0].options.input, '["root",{}]');
  assert(!calls[0].args.includes('["root",{}]'));
});
test('missing current account and partial fetches are never guessed into a valid target', async () => {
  const profiles = new DingTalkClient({
    binary: '/test/dws',
    runner: async () => ({ profiles: [{ profile: 'a:b', isOrgCurrent: true }] }),
  });
  assert.equal((await profiles.profiles()).currentProfile, null);
  const client = new DingTalkClient({
    binary: '/test/dws',
    runner: async () => ({
      status: 'success',
      complete: false,
      content: { nodeId: 'n', revision: 1, jsonml: '["root",{}]' },
    }),
  });
  await assert.rejects(client.fetch('n', 'a:b'), { code: 'DWS_UNKNOWN' });
});
test('link sharing requires a recipient and confirmation and does not resend the same version', async (t) => {
  const { sync, knowledge, file, client } = await setup(t);
  let sent = 0;
  client.share = async () => {
    sent++;
    return { sent: 1, recipients: ['Test'] };
  };
  await sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true });
  await assert.rejects(sync.share(knowledge, file, { to: 'Test' }), {
    code: 'CONFIRMATION_REQUIRED',
  });
  await sync.share(knowledge, file, { to: 'Test', confirmed: true });
  assert.equal((await sync.share(knowledge, file, { to: 'Test', confirmed: true })).replayed, true);
  assert.equal(sent, 1);
});
test('a partial send receipt is not presented as a successful share', async () => {
  const client = new DingTalkClient({
    binary: '/test/dws',
    runner: async () => ({
      ok: false,
      status: 'partial_success',
      data: {
        requestedCount: 2,
        succeededCount: 1,
        failedCount: 1,
        recipients: [
          { name: 'A', message: 'success' },
          { name: 'B', message: 'failed' },
        ],
      },
    }),
  });
  await assert.rejects(
    client.share('https://alidocs.dingtalk.com/i/nodes/test', 'corp:user', 'A,B'),
    { code: 'DWS_UNKNOWN' },
  );
});
test('online tables have usable widths and preserve every cell and alignment', async (t) => {
  const { file, store } = await setup(t);
  await fs.writeFile(
    file,
    '| 指标 | 结果 | 备注 |\n| :--- | :---: | ---: |\n| A | $x^2$ | B |\n| C | D | E |',
  );
  const { jsonml } = await documentProjection(await store.read(file), store);
  const table = jsonml.find((n) => Array.isArray(n) && n[0] === 'table');
  assert.deepEqual(table[1].colsWidth, [200, 200, 200]);
  assert.equal(table.length - 2, 3);
  for (const row of table.slice(2)) {
    assert.equal(row.length - 2, 3);
    for (const cell of row.slice(2)) {
      assert.equal(cell[1].colSpan, 1);
      assert.equal(cell[1].rowSpan, 1);
      assert.equal(cell[2][0], 'p');
    }
  }
  assert.equal(table[3][3][2][1].jc, 'center');
  assert.equal(table[3][4][2][1].jc, 'right');
});
test('inline formulas containing break opportunities render as one complete image', async () => {
  const { renderedFormula } = require('../core/dingtalk-document.cjs'),
    { imageSize } = require('image-size');
  const formula = await renderedFormula('L=-\\sum_i\\log p(x_i)', false),
    bytes = Buffer.from(formula.src.split(',')[1], 'base64'),
    size = imageSize(bytes);
  assert.equal(size.type, 'png');
  assert(formula.width > 100);
  assert(size.width >= formula.width * 1.9);
  assert(size.height > 20);
  assert((await renderedFormula('L', false)).width < formula.width / 3);
});

test('prices and other loose dollar signs are published as text, not as formulas', async (t) => {
  const { file, store } = await setup(t);
  await fs.writeFile(
    file,
    '# Costs\n\nIt costs $5 and $10 total.\n\n价格从 $5 到 $10。\n\nThe value $x$ stays a formula.\n',
  );
  const projection = await documentProjection(await store.read(file), store);
  assert.equal(projection.stats.formulas, 1, 'only $x$ is a formula');
  const text = JSON.stringify(projection.jsonml);
  assert(text.includes('It costs $5 and $10 total.'), 'prices survive as literal text');
  assert(text.includes('价格从 $5 到 $10。'));
});

test('LaTeX backslash delimiters publish actual equations and leave escaped prose untouched', async (t) => {
  const { file, store } = await setup(t);
  const source =
    String.raw`Inline \(E=mc^2\) and display \[a+b\].` +
    '\n\n' +
    String.raw`\[x^2+y^2=z^2\]` +
    '\n\n' +
    String.raw`\[` +
    '\n' +
    String.raw`\frac{1}{2}` +
    '\n' +
    String.raw`\]` +
    '\n\n' +
    String.raw`Escaped \\(x\\) and \\[y\\]; costs $5 and $10.` +
    '\n\n' +
    String.raw`Unmatched \(z stays prose.` +
    '\n\n```tex\n' +
    String.raw`\(q\) \[r\]` +
    '\n```\n';
  await fs.writeFile(file, source);
  const projection = await documentProjection(await store.read(file), store);
  assert.equal(projection.stats.formulas, 4);
  assert.equal(projection.stats.images, 0);
  const images = [];
  const collect = (node) => {
    if (!Array.isArray(node)) return;
    if (node[0] === 'img') images.push(node[1]);
    node.slice(2).forEach(collect);
  };
  collect(projection.jsonml);
  assert.equal(images.length, 4);
  assert(images.every((item) => item.src.startsWith('data:image/png;base64,')));
  assert(projection.content.includes('costs $5 and $10'));
  assert(projection.content.includes('Unmatched (z stays prose.'));
  assert.equal(await fs.readFile(file, 'utf8'), source);
});

const diagramPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==';
test('Mermaid images match source blocks including fence attributes and reject stale versions', async (t) => {
  const { file, store, sync, knowledge, state } = await setup(t);
  const sourceA = 'graph TD\nA-->AA\n',
    sourceB = 'graph TD\nB-->BB\n';
  await fs.writeFile(
    file,
    '```mermaid title="A"\n' + sourceA + '```\n\n```mermaid\n' + sourceB + '```\n',
  );
  const snapshot = await store.read(file),
    diagrams = [
      { source: sourceA, png: diagramPng },
      { source: sourceB, png: diagramPng },
    ];
  const projection = await documentProjection(snapshot, store, { diagrams });
  assert.equal(projection.stats.diagrams, 2);
  assert.deepEqual(projection.warnings, []);
  await assert.rejects(documentProjection(snapshot, store, { diagrams: diagrams.toReversed() }), {
    code: 'CONFLICT',
  });
  await assert.rejects(
    documentProjection(snapshot, store, { diagrams: [...diagrams, diagrams[0]] }),
    { code: 'CONFLICT' },
  );
  await assert.rejects(sync.plan(knowledge, file, { diagrams }), { code: 'DWS_STALE_PLAN' });
  const plan = await sync.plan(knowledge, file, { diagrams, expectedRevision: snapshot.hash });
  await sync.execute(knowledge, plan.id, { confirmed: true });
  assert.equal(state.creates, 1);
  await fs.appendFile(file, '\nChanged after image rendering.');
  await assert.rejects(sync.plan(knowledge, file, { diagrams, expectedRevision: snapshot.hash }), {
    code: 'CONFLICT',
  });
});
test('post-write readback failures retain a known node even when the read did not start', async (t) => {
  for (const failure of [
    new DingTalkError('auth', 'DWS_AUTH', { executionStarted: false }),
    new DingTalkError('missing dws', 'DWS_UNAVAILABLE'),
    new DingTalkError('network', 'DWS_UNKNOWN'),
  ]) {
    const { sync, knowledge, file, client, state } = await setup(t);
    const fetch = client.fetch;
    client.fetch = async () => {
      throw failure;
    };
    await assert.rejects(
      sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true }),
      { code: failure.code },
    );
    const info = await sync.info(knowledge, file);
    assert.equal(info.binding.state, 'uncertain');
    assert.equal(info.binding.nodeId, 'test-node');
    assert.equal(info.binding.stage, 'readback');
    assert.equal(state.creates, 1);
    await assert.rejects(sync.plan(knowledge, file), { code: 'DWS_UNKNOWN' });
    client.fetch = fetch;
    await sync.reconcile(knowledge, file);
    assert.equal((await sync.plan(knowledge, file)).action, 'current');
    assert.equal(state.creates, 1);
  }
});
test('write preflight failure can be retried while a known partial creation stays recoverable', async (t) => {
  const { sync, knowledge, file, client } = await setup(t);
  client.create = async () => {
    throw new DingTalkError('validation', 'DWS_VALIDATION', { executionStarted: false });
  };
  await assert.rejects(
    sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true }),
    { code: 'DWS_VALIDATION' },
  );
  assert.equal((await sync.info(knowledge, file)).binding, null);
  client.create = async () => {
    throw new DingTalkError('partial', 'DWS_UNKNOWN', {
      nodeId: 'created-node',
      executionStarted: false,
    });
  };
  await assert.rejects(
    sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true }),
    { code: 'DWS_UNKNOWN' },
  );
  assert.equal((await sync.info(knowledge, file)).binding.nodeId, 'created-node');
});
test('unknown creation can attach only the verified matching document and revision', async (t) => {
  const { sync, knowledge, file, client, state } = await setup(t);
  const create = client.create;
  client.create = async (...args) => {
    await create(...args);
    throw new DingTalkError('lost receipt', 'DWS_UNKNOWN');
  };
  await assert.rejects(
    sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true }),
    { code: 'DWS_UNKNOWN' },
  );
  const binding = (await sync.info(knowledge, file)).binding;
  const inspect = await sync.recoveryInfo(knowledge, file, { nodeId: 'test-node' });
  assert.equal(inspect.matchesSubmitted, true);
  await assert.rejects(
    sync.recover(knowledge, file, {
      action: 'attach',
      expectedPlanId: binding.planId,
      nodeId: 'test-node',
      expectedRevision: inspect.remote.revision,
    }),
    { code: 'CONFIRMATION_REQUIRED' },
  );
  await assert.rejects(
    sync.recover(knowledge, file, {
      action: 'attach',
      expectedPlanId: binding.planId,
      nodeId: 'test-node',
      expectedRevision: 99,
      confirmed: true,
    }),
    { code: 'DWS_CONFLICT' },
  );
  state.jsonml.push(['p', {}, ['span', {}, 'Another document']]);
  await assert.rejects(
    sync.recover(knowledge, file, {
      action: 'attach',
      expectedPlanId: binding.planId,
      nodeId: 'test-node',
      expectedRevision: inspect.remote.revision,
      confirmed: true,
    }),
    { code: 'DWS_CONFLICT' },
  );
  state.jsonml.pop();
  const result = await sync.recover(knowledge, file, {
    action: 'attach',
    expectedPlanId: binding.planId,
    nodeId: 'test-node',
    expectedRevision: inspect.remote.revision,
    confirmed: true,
  });
  assert.equal(result.state, 'synced');
  assert.equal(state.creates, 1);
  await assert.rejects(
    sync.recover(knowledge, file, {
      action: 'detach',
      expectedPlanId: binding.planId,
      confirmed: true,
    }),
    { code: 'CONFLICT' },
  );
});
test('confirming no creation records recovery and never automatically resends', async (t) => {
  const { sync, knowledge, file, client, state, data } = await setup(t);
  client.create = async () => {
    throw new DingTalkError('lost connection', 'DWS_UNKNOWN');
  };
  await assert.rejects(
    sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true }),
    { code: 'DWS_UNKNOWN' },
  );
  const binding = (await sync.info(knowledge, file)).binding;
  await assert.rejects(
    sync.recover(knowledge, file, {
      action: 'detach',
      expectedPlanId: binding.planId,
      confirmed: true,
    }),
    { code: 'DWS_UNKNOWN' },
  );
  const result = await sync.recover(knowledge, file, {
    action: 'confirm-not-created',
    expectedPlanId: binding.planId,
    confirmed: true,
  });
  assert.equal(result.state, 'detached');
  assert.equal((await sync.info(knowledge, file)).binding, null);
  assert.equal((await sync.plan(knowledge, file)).action, 'create');
  assert.equal(state.creates, 0);
  const archive = JSON.parse(
    await fs.readFile(path.join(data, 'dingtalk', 'recoveries', result.recoveryId + '.json')),
  );
  assert.equal(archive.binding.planId, binding.planId);
});
test('remote adoption preserves cloud content, invalidates old plans and requires a new reviewed update', async (t) => {
  const { sync, knowledge, file, state } = await setup(t);
  await sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true });
  await fs.appendFile(file, '\nLocal change\n');
  const oldPlan = await sync.plan(knowledge, file);
  state.jsonml.push(['p', {}, ['span', {}, 'Human cloud edit']]);
  state.revision++;
  const inspect = await sync.recoveryInfo(knowledge, file);
  assert.equal(inspect.matchesSubmitted, false);
  assert(inspect.remote.preview.includes('Human cloud edit'));
  const result = await sync.recover(knowledge, file, {
    action: 'adopt-remote',
    expectedPlanId: inspect.binding.planId,
    expectedRevision: inspect.remote.revision,
    confirmed: true,
  });
  assert.equal(result.requiresReview, true);
  assert.equal(state.writes, 0);
  await assert.rejects(sync.execute(knowledge, oldPlan.id, { confirmed: true }), {
    code: 'CONFLICT',
  });
  const next = await sync.plan(knowledge, file);
  assert.equal(next.action, 'update');
  assert.equal(next.requiresReview, true);
  assert(next.remotePreview.includes('Human cloud edit'));
  assert(next.localPreview.includes('Local change'));
  await sync.execute(knowledge, next.id, { confirmed: true });
  assert.equal(state.writes, 1);
});
test('detaching leaves remote content intact and forbids no-creation confirmation for known nodes', async (t) => {
  const { sync, knowledge, file, state } = await setup(t);
  await sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true });
  const binding = (await sync.info(knowledge, file)).binding,
    original = clone(state.jsonml);
  await assert.rejects(
    sync.recover(knowledge, file, {
      action: 'confirm-not-created',
      expectedPlanId: binding.planId,
      confirmed: true,
    }),
    { code: 'USAGE' },
  );
  const result = await sync.recover(knowledge, file, {
    action: 'detach',
    expectedPlanId: binding.planId,
    confirmed: true,
  });
  assert.equal(result.remotePreserved, true);
  assert.deepEqual(state.jsonml, original);
  assert.equal(state.writes, 0);
});
test('uncertain link delivery can be explicitly resolved without automatically sending again', async (t) => {
  const { sync, knowledge, file, client } = await setup(t);
  let sends = 0;
  client.share = async () => {
    sends++;
    throw new DingTalkError('partial delivery', 'DWS_UNKNOWN');
  };
  await sync.execute(knowledge, (await sync.plan(knowledge, file)).id, { confirmed: true });
  await assert.rejects(sync.share(knowledge, file, { to: 'A,B', confirmed: true }), {
    code: 'DWS_UNKNOWN',
  });
  const status = await sync.shareStatus(knowledge, file, 'A,B');
  await assert.rejects(
    sync.resolveShare(knowledge, file, {
      to: 'A,B',
      expectedPackageHash: status.packageHash,
      outcome: 'not-sent',
    }),
    { code: 'CONFIRMATION_REQUIRED' },
  );
  await sync.resolveShare(knowledge, file, {
    to: 'A,B',
    expectedPackageHash: status.packageHash,
    outcome: 'not-sent',
    confirmed: true,
  });
  assert.equal(sends, 1);
  await assert.rejects(sync.share(knowledge, file, { to: 'A,B', confirmed: true }), {
    code: 'DWS_UNKNOWN',
  });
  assert.equal(sends, 2);
  await sync.resolveShare(knowledge, file, {
    to: 'A,B',
    expectedPackageHash: status.packageHash,
    outcome: 'sent',
    confirmed: true,
  });
  assert.equal((await sync.share(knowledge, file, { to: 'A,B', confirmed: true })).replayed, true);
  assert.equal(sends, 2);
});
