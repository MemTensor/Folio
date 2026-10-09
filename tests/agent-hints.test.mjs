import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
const { AgentHints } = createRequire(import.meta.url)('../core/agent-hints.cjs');
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause();
  }
  throw Error('Hint test timed out');
}
async function fixture(t) {
  const dataDir = await mkdtemp('/private/tmp/folio-hints-');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [],
    events = [];
  let sequence = 0;
  const client = {
    cwd: dataDir,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-' + ++sequence } };
      if (method === 'turn/start') return { turn: { id: 'turn-' + sequence } };
      return {};
    },
  };
  const connection = {
    phase: 'ready',
    provider: 'chatgpt',
    models: [{ id: 'gpt-6-luna' }, { id: 'expensive-model', isDefault: true }],
  };
  const configuration = { provider: 'chatgpt', hintModel: '' };
  let busy = false;
  const engine = new AgentHints({
    dataDir,
    getClient: () => client,
    getConnection: () => connection,
    getConfiguration: async () => configuration,
    isBusy: () => busy,
    onEvent: (e) => events.push(e),
  });
  t.after(() => engine.cancel());
  const input = {
    requestId: 'first',
    path: '/generated/project/Experiment.md',
    content: '# Warmup experiment\n\nThe experiment compares two warmup schedules over 150 steps.',
    scope: 'document',
    language: 'English',
  };
  const value = {
    summary: 'Two warmup schedules are compared.',
    hints: [
      {
        label: 'Clarify warmup comparison',
        prompt:
          'Clarify how this document describes the two warmup schedules; preserve supplied facts.',
        mode: 'edit',
      },
      {
        label: 'Clarify 150-step findings',
        prompt: 'Clarify the wording of the 150-step findings.',
        mode: 'edit',
      },
      {
        label: 'Check evaluation evidence',
        prompt:
          'Add a section documenting the evidence supporting the warmup comparison; mark missing details for confirmation.',
        mode: 'edit',
      },
    ],
  };
  async function complete(result = value) {
    await until(() => !!engine.active?.turnId);
    const id = engine.active.threadId;
    await engine.notification('item/completed', {
      threadId: id,
      item: { type: 'agentMessage', text: JSON.stringify(result) },
    });
    await engine.notification('turn/completed', { threadId: id, turn: { status: 'completed' } });
  }
  return {
    engine,
    calls,
    events,
    connection,
    configuration,
    input,
    complete,
    value,
    setBusy: (v) => {
      busy = v;
    },
  };
}

test('document hints use Luna independently of the main model and coalesce requests into one generation', async (t) => {
  const { engine, calls, events, input, complete } = await fixture(t);
  const first = await engine.request(input);
  const second = await engine.request({ ...input, requestId: 'second' });
  assert.equal(first.phase, 'generating');
  assert.equal(first.key, second.key);
  await complete();
  const thread = calls.find((c) => c.method === 'thread/start');
  assert.equal(thread.params.model, 'gpt-6-luna');
  assert.equal(thread.params.ephemeral, true);
  const turn = calls.find((c) => c.method === 'turn/start');
  assert.equal(turn.params.effort, 'none');
  assert.equal(JSON.parse(turn.params.input[0].text).excerpt, input.content);
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, 1);
  const delivered = events.filter((e) => e.result.phase === 'ready');
  assert.deepEqual(
    delivered.map((e) => e.result.requestId),
    ['first', 'second'],
  );
  assert(delivered.every((e) => e.result.hints[0].label === 'Clarify warmup comparison'));
  assert(calls.some((c) => c.method === 'thread/unsubscribe'));
  const cached = await engine.request({ ...input, requestId: 'reopen' });
  assert.equal(cached.phase, 'ready');
  assert.equal(cached.requestId, 'reopen');
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('different document versions and selections generate separately and never cross-deliver a stale response', async (t) => {
  const { engine, input, calls, events, complete } = await fixture(t);
  const old = await engine.request(input);
  await until(() => !!engine.active?.turnId);
  const next = await engine.request({
    ...input,
    content: 'Selected result: the shorter warmup wins.',
    scope: 'selection',
    requestId: 'selection',
  });
  assert.notEqual(old.key, next.key);
  await complete();
  assert(calls.some((c) => c.method === 'turn/interrupt'));
  assert(!events.some((e) => e.result.requestId === 'first' && e.result.phase === 'ready'));
  const turns = calls.filter((c) => c.method === 'turn/start');
  assert.equal(JSON.parse(turns.at(-1).params.input[0].text).scope, 'selection');
});

test('missing lightweight model, empty input and an active user request cause no inference or expensive fallback', async (t) => {
  const { engine, input, connection, calls, setBusy } = await fixture(t);
  connection.models = [{ id: 'expensive-model', isDefault: true }];
  assert.equal((await engine.request(input)).phase, 'unavailable');
  assert.equal((await engine.request({ ...input, content: '' })).phase, 'empty');
  connection.models = [{ id: 'gpt-6-luna' }];
  setBusy(true);
  assert.equal((await engine.request(input)).phase, 'idle');
  assert.equal(calls.length, 0);
});

test('API hints require an explicit lightweight model and reject malformed generation results', async (t) => {
  const { engine, connection, configuration, input, calls, complete, events } = await fixture(t);
  connection.provider = 'api';
  configuration.provider = 'api';
  configuration.model = 'expensive-model';
  assert.equal((await engine.request(input)).phase, 'unavailable');
  assert.equal(calls.length, 0);
  configuration.hintModel = 'custom-small-model';
  await engine.request(input);
  await complete({ summary: 'bad', hints: null });
  assert.equal(calls.find((c) => c.method === 'thread/start').params.model, 'custom-small-model');
  assert.equal(events.at(-1).result.phase, 'unavailable');
  const count = calls.filter((c) => c.method === 'turn/start').length;
  await engine.request({ ...input, requestId: 'automatic-reopen' });
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, count);
});

test('document suggestions permit fewer grounded revisions and reject general question actions', async (t) => {
  const { engine, input, complete, events, value } = await fixture(t);
  await engine.request(input);
  await complete({ ...value, hints: value.hints.slice(0, 1) });
  assert.equal(events.at(-1).result.hints.length, 1);
  await engine.request({ ...input, force: true });
  await complete({ ...value, hints: [] });
  assert.equal(events.at(-1).result.phase, 'ready');
  assert.equal(events.at(-1).result.hints.length, 0);
  await engine.request({ ...input, force: true });
  await complete({ ...value, hints: [{ ...value.hints[0], mode: 'ask' }] });
  assert.equal(events.at(-1).result.phase, 'unavailable');
});

test('old action-suggestion caches are not reused by the document-revision policy', async (t) => {
  const { engine, input, connection, complete, value } = await fixture(t);
  const { digest } = createRequire(import.meta.url)('../core/state.cjs');
  const oldKey = digest(
    JSON.stringify([
      input.path,
      digest(input.content),
      input.scope,
      input.language,
      connection.provider,
      'gpt-6-luna',
    ]),
  );
  await mkdir(engine.file.slice(0, engine.file.lastIndexOf('/')), { recursive: true });
  await writeFile(engine.file, JSON.stringify({ [oldKey]: { ...value, time: Date.now() } }));
  const result = await engine.request(input);
  assert.equal(result.phase, 'generating');
  assert.notEqual(result.key, oldKey);
  await complete();
});
