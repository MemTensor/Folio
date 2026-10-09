import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { AgentService, authURL } = createRequire(import.meta.url)('../core/agent-service.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw Error('Agent test timed out.');
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp('/private/tmp/folio-agent-service-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  Object.assign(client, {
    started: false,
    starts: 0,
    cwd: directory + '/sandbox',
    calls: [],
    account: { type: 'chatgpt', planType: 'pro', email: 'fixture@example.invalid' },
  });
  client.start = async () => {
    client.starts++;
    client.started = true;
  };
  client.stop = () => {
    client.started = false;
    client.emit('disconnected', Error('Codex 连接已断开，请重新连接。'));
  };
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'account/read') return { account: client.account };
    if (method === 'model/list')
      return {
        data: [
          {
            model: 'fixture-model',
            displayName: 'Fixture model',
            isDefault: true,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
              reasoningEffort,
            })),
          },
        ],
      };
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } };
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } };
    if (method === 'account/login/start')
      return { loginId: 'login-fixture', authUrl: 'https://auth.openai.com/authorize?fixture=yes' };
    return {};
  };
  const events = [],
    urls = [];
  const service = new AgentService({
    dataDir: directory,
    client,
    onEvent: (event) => events.push(event),
    openExternal: async (url) => urls.push(url),
    idleDelay: 8,
    recoveryDelay: 5,
    ...options,
  });
  t.after(() => service.close());
  const input = {
    root: '/generated/project',
    path: '/generated/project/Doc.md',
    content: 'private first\nselected text\nprivate last',
    selection: { from: 14, to: 27 },
    instruction: 'Refine this',
    references: [],
    language: 'English',
    mode: 'edit',
  };
  const emitResult = (value, status = 'completed', error) => {
    client.emit('notification', 'item/completed', {
      threadId: 'fixture-thread',
      item: {
        type: 'agentMessage',
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    });
    client.emit('notification', 'turn/completed', {
      threadId: 'fixture-thread',
      turn: { status, error },
    });
  };
  const complete = async (value, status = 'completed', error) => {
    await until(() => service.active?.turnId);
    for (let round = 0; round < 3 && service.active; round++) {
      const count = client.calls.filter((c) => c.method === 'turn/start').length;
      emitResult(value, status, error);
      await until(
        () =>
          !service.active || client.calls.filter((c) => c.method === 'turn/start').length > count,
      );
      if (service.active) await tick();
    }
    await until(() => !service.active);
    await Promise.all([...service.writes.values()]);
  };
  return { service, client, input, events, urls, complete, emitResult };
}

test('an authenticated background connection stays warm without panel owners, polling or new handshakes', async (t) => {
  const { service, client } = await fixture(t);
  service.idleDelay = null;
  await service.connect();
  const reads = client.calls.length;
  await service.acquire('panel-a');
  service.release('panel-a');
  service.releasePanels();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.started, true);
  assert.equal(service.status().phase, 'ready');
  await service.acquire('panel-b');
  assert.equal(client.starts, 1);
  assert.equal(client.calls.length, reads);
  assert.equal(service.idleTimer, undefined);
  await service.close();
  assert.equal(client.started, false);
});

test('opening a panel is local-only; subscription login uses the official browser flow', async (t) => {
  const { service, client, input, urls } = await fixture(t);
  await service.session(input.root);
  assert.equal(client.started, false);
  client.account = null;
  assert.equal((await service.connect()).phase, 'login');
  await service.login();
  assert.equal(urls[0], 'https://auth.openai.com/authorize?fixture=yes');
  assert.equal(service.status().waiting, true);
  client.account = { type: 'chatgpt', email: null, planType: 'plus' };
  client.emit('notification', 'account/login/completed', {
    loginId: 'login-fixture',
    success: true,
  });
  await until(() => service.status().phase === 'ready');
  assert(!JSON.stringify(service.status()).includes('authUrl'));
  assert.throws(() => authURL('https://auth.openai.com.evil.invalid/authorize'));
  assert.throws(() => authURL('http://auth.openai.com/authorize'));
  assert.throws(() => authURL('https://token@auth.openai.com/authorize'));
});

test('a blocked browser keeps one valid sign-in link and repeated connects never discard the pending flow', async (t) => {
  const { service, client } = await fixture(t);
  client.account = null;
  service.openExternal = async () => {
    throw Error('PRIVATE_BROWSER_DETAIL');
  };
  await service.connect();
  await service.login();
  assert.equal(service.status().waiting, true);
  assert.equal(service.status().loginURL, 'https://auth.openai.com/authorize?fixture=yes');
  assert.doesNotMatch(service.status().message, /PRIVATE_BROWSER/);
  await service.connect();
  await service.login();
  assert.equal(client.calls.filter((call) => call.method === 'account/login/start').length, 1);
  await service.cancelLogin();
  assert.equal(service.status().loginURL, undefined);
  await service.disconnect();
  assert.equal(service.loginURL, null);
});

test('selection sends only chosen Markdown and proposals stay local until accepted', async (t) => {
  const { service, client, input, complete } = await fixture(t);
  await service.connect();
  await service.send(input);
  await until(() => client.calls.some((c) => c.method === 'turn/start'));
  const call = client.calls.find((c) => c.method === 'turn/start');
  const prompt = JSON.parse(call.params.input[0].text);
  assert.equal(prompt.editableDocument.content, 'selected text');
  assert(!call.params.input[0].text.includes('private first'));
  assert.equal(call.params.permissions, 'folio-documents');
  assert.equal(call.params.sandboxPolicy, undefined);
  assert.equal(call.params.approvalPolicy, 'never');
  await complete({
    answer: 'A clearer phrase.',
    edits: [{ title: 'Clarity', before: 'selected text', after: 'clear text' }],
  });
  const session = await service.session(input.root),
    message = session.messages.at(-1);
  assert.equal(message.base, input.content);
  assert.equal(message.edits[0].from, 14);
  assert.equal(message.outcome, undefined);
  assert.equal(
    JSON.parse(await readFile(service.file(input.root), 'utf8')).messages.at(-1).status,
    'completed',
  );
  assert.equal((await service.session('/generated/other')).messages.length, 0);
});

test('ambiguous edits and edits offered during a question are not exposed as proposals', async (t) => {
  const { service, input, complete } = await fixture(t);
  await service.connect();
  await service.send({ ...input, content: 'same same', selection: null });
  await complete({ answer: 'Edit', edits: [{ title: 'Bad', before: 'same', after: 'new' }] });
  assert.equal((await service.session(input.root)).messages.at(-1).status, 'error');
  await service.send({ ...input, mode: 'ask' });
  await complete({
    answer: 'Edit',
    edits: [{ title: 'Bad', before: 'selected text', after: 'new' }],
  });
  const message = (await service.session(input.root)).messages.at(-1);
  assert.equal(message.status, 'error');
  assert.deepEqual(message.edits, []);
});

test('stop, remote failures and late unrelated events cannot produce an accepted edit', async (t) => {
  const { service, client, input, complete } = await fixture(t);
  await service.connect();
  await service.send(input);
  await until(() => service.active?.turnId);
  client.emit('notification', 'turn/completed', {
    threadId: 'another-thread',
    turn: { status: 'completed' },
  });
  assert(service.active);
  await service.cancel(input.root);
  assert.equal((await service.session(input.root)).messages.at(-1).status, 'interrupted');
  assert(client.calls.some((c) => c.method === 'turn/interrupt'));
  await service.send(input);
  await complete({ answer: '', edits: [] }, 'failed', {
    codexErrorInfo: 'usageLimitExceeded',
    message: 'SECRET',
  });
  const failed = (await service.session(input.root)).messages.at(-1);
  assert.match(failed.error, /额度/);
  assert(!failed.error.includes('SECRET'));
});

test('partial acceptance is durable, reversible and cannot be applied twice', async (t) => {
  const { service, input, complete } = await fixture(t);
  await service.connect();
  await service.send({ ...input, content: 'one two', selection: null });
  await complete({
    answer: 'Changes',
    edits: [
      { title: 'One', before: 'one', after: '1' },
      { title: 'Two', before: 'two', after: '2' },
    ],
  });
  const message = (await service.session(input.root)).messages.at(-1);
  let value = await service.resolve(input.root, message.id, 'accepted', ['1']);
  assert.equal(value.messages.at(-1).edits.length, 1);
  assert.equal(value.messages.at(-1).edits[0].before, 'two');
  await assert.rejects(service.resolve(input.root, message.id, 'accepted'));
  value = await service.resolve(input.root, message.id, 'undone');
  assert.equal(value.messages.at(-1).outcome, 'undone');
  await service.clear(input.root);
  assert.equal((await service.session(input.root)).messages.length, 0);
});

test('concurrent sends are serialized and a hidden panel releases its runtime after the response', async (t) => {
  const { service, client, input } = await fixture(t);
  await service.acquire('panel');
  await service.connect();
  const first = service.send(input);
  await assert.rejects(service.send(input), /正在回复/);
  await first;
  await until(() => service.active?.turnId);
  service.release('panel');
  assert.equal(client.started, true);
  await service.cancel(input.root);
  await until(() => !client.started);
  assert.equal(client.started, false);
  assert.equal(service.status().phase, 'idle');
});

test('closing and reopening restores sign-in while an old panel cannot close the new connection', async (t) => {
  const { service, client } = await fixture(t);
  await service.acquire('first-panel');
  await service.connect();
  service.release('first-panel');
  await service.acquire('second-panel');
  service.release('first-panel');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.status().phase, 'ready');
  assert.equal(client.starts, 1);
  service.release('second-panel');
  await until(() => !client.started && service.status().phase === 'idle');
  assert.equal(service.status().account.plan, 'pro');
  assert.equal((await service.acquire('third-panel')).phase, 'ready');
  assert.equal(client.starts, 2);
  assert.equal(client.calls.filter((call) => call.method === 'account/login/start').length, 0);
});

test('a reopen during process shutdown waits for exit and preserves monotonic connection snapshots', async (t) => {
  const { service, client, events } = await fixture(t);
  await service.acquire('old-panel');
  await service.connect();
  let finishClose;
  client.close = async () => {
    client.stop();
    await new Promise((resolve) => {
      finishClose = resolve;
    });
  };
  service.release('old-panel');
  await until(() => !!finishClose);
  const reopening = service.acquire('new-panel');
  assert.equal(client.starts, 1);
  finishClose();
  assert.equal((await reopening).phase, 'ready');
  assert.equal(client.starts, 2);
  const states = events
    .filter((event) => event.type === 'connection')
    .map((event) => event.connection);
  assert(states.every((state, i) => !i || state.revision > states[i - 1].revision));
  assert(!states.some((state) => state.phase === 'error'));
  client.close = async () => client.stop();
});

test('unexpected process loss reconnects once without replaying the document request', async (t) => {
  const { service, client, input } = await fixture(t);
  await service.acquire('panel');
  await service.connect();
  await service.send(input);
  await until(() => service.active?.turnId);
  client.stop();
  await until(() => client.starts === 2 && service.status().phase === 'ready');
  assert.equal((await service.session(input.root)).messages.at(-1).status, 'error');
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 1);
  client.start = async () => {
    client.starts++;
    throw Error('offline');
  };
  client.stop();
  await until(() => client.starts === 3 && service.status().phase === 'error');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.starts, 3);
});

test('saved opt-in survives restart, explicit disconnect stays off, and beta.8 sign-in migrates by file metadata', async (t) => {
  const { service, client } = await fixture(t);
  client.home = service.dataDir + '/codex-home';
  await mkdir(client.home);
  await writeFile(client.home + '/auth.json', 'not parsed by Folio');
  assert.equal((await service.acquire('migrated-panel')).phase, 'ready');
  assert.equal(client.starts, 1);
  await service.disconnect();
  service.intent = null;
  await service.acquire('new-panel');
  assert.equal(client.starts, 1);
  assert.equal(service.status().phase, 'idle');
  await service.connect();
  service.release('migrated-panel');
  service.release('new-panel');
  await until(() => !client.started);
  service.intent = null;
  assert.equal((await service.acquire('after-restart')).phase, 'ready');
  assert.equal(client.starts, 3);
});

test('restoring conversation validates source offsets and keeps selection-local duplicate replacements', async (t) => {
  const { service, input, complete } = await fixture(t);
  await service.connect();
  await service.send({ ...input, content: 'same same', selection: { from: 5, to: 9 } });
  await complete({
    answer: 'Change the selected occurrence.',
    edits: [{ title: 'Selected', before: 'same', after: 'new' }],
  });
  service.sessions.clear();
  let stored = await service.session(input.root);
  assert.equal(stored.messages.at(-1).edits[0].from, 5);
  const file = service.file(input.root);
  const damaged = JSON.parse(await readFile(file, 'utf8'));
  damaged.messages.at(-1).edits[0].from = 0;
  await writeFile(file, JSON.stringify(damaged));
  service.sessions.clear();
  stored = await service.session(input.root);
  assert.deepEqual(stored.messages.at(-1).edits, []);
});

test('document tools are tied to the active turn, bounded, cancelled safely and unavailable for selection-only requests', async (t) => {
  let reads = 0,
    release;
  const documentTools = {
    execute: async (_root, _tool, args) => {
      reads++;
      if (args.path === 'slow.md')
        await new Promise((resolve) => {
          release = resolve;
        });
      return {
        result: { excerpt: 'generated reference' },
        source: { path: '/generated/project/Ref.md', name: 'Ref.md', line: 1, endLine: 2 },
      };
    },
  };
  const { service, client, input, complete } = await fixture(t, { documentTools });
  await service.connect();
  await service.send({ ...input, selection: null });
  await until(() => service.active?.turnId);
  const params = {
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
    tool: 'folio_read_document',
    arguments: { path: 'Ref.md', offset: 0 },
  };
  assert.equal(
    (await service.handleToolCall({ ...params, threadId: 'other-thread' })).success,
    false,
  );
  assert.equal((await service.handleToolCall({ ...params, tool: 'shell' })).success, false);
  assert.equal(reads, 0);
  for (let i = 0; i < 6; i++) assert.equal((await service.handleToolCall(params)).success, true);
  assert.equal((await service.handleToolCall(params)).success, false);
  assert.equal(reads, 6);
  assert.equal(service.active.message.sources.length, 1);
  await complete({ answer: 'Reference used.', edits: [] });
  await service.send(input);
  await until(() => service.active?.turnId);
  assert.equal(
    client.calls.filter((c) => c.method === 'thread/start').at(-1).params.dynamicTools,
    undefined,
  );
  assert.equal((await service.handleToolCall(params)).success, false);
  await complete({ answer: 'Selection only.', edits: [] });
  await service.send({ ...input, selection: null });
  await until(() => service.active?.turnId);
  const pending = service.handleToolCall({ ...params, arguments: { path: 'slow.md' } });
  await until(() => !!release);
  await service.cancel(input.root);
  release();
  assert.equal((await pending).success, false);
});

test('ChatGPT document reads use bounded structured requests and toolOutput without exposing an execution runtime', async (t) => {
  const documentTools = {
    execute: async () => ({
      result: { excerpt: '173 documented steps' },
      source: { path: '/generated/project/Ref.md', name: 'Ref.md', line: 1, endLine: 1 },
    }),
  };
  const { service, client, input, complete } = await fixture(t, { documentTools });
  await service.connect();
  await service.send({ ...input, selection: null, mode: 'ask' });
  await until(() => service.active?.turnId);
  const thread = client.calls.find((c) => c.method === 'thread/start');
  assert.equal(thread.params.dynamicTools, undefined);
  client.emit('notification', 'item/completed', {
    threadId: 'fixture-thread',
    item: {
      type: 'agentMessage',
      text: JSON.stringify({
        answer: '',
        edits: [],
        documentTool: { name: 'folio_read_document', path: 'Ref.md', query: '', offset: 0 },
      }),
    },
  });
  client.emit('notification', 'turn/completed', {
    threadId: 'fixture-thread',
    turn: { id: 'fixture-turn', status: 'completed' },
  });
  await until(() => client.calls.filter((c) => c.method === 'turn/start').length === 2);
  const continuation = client.calls.filter((c) => c.method === 'turn/start').at(-1).params;
  assert.deepEqual(continuation.input, []);
  assert.equal(continuation.toolOutput.name, 'folio_read_document');
  assert(JSON.stringify(continuation.toolOutput.output).includes('173 documented steps'));
  assert.equal(service.active.message.edits.length, 0);
  await complete({ answer: 'Ref.md documents 173 steps.', edits: [], documentTool: null });
  assert.equal((await service.session(input.root)).messages.at(-1).sources[0].name, 'Ref.md');
});

test('unified requests answer questions or propose edits without a mode switch, using supported effort', async (t) => {
  const { service, input, client, complete } = await fixture(t);
  await service.connect();
  await service.send({
    ...input,
    mode: 'auto',
    effort: 'high',
    instruction: 'Explain and refine the selected wording.',
  });
  await complete({
    answer: 'This makes the wording clearer.',
    edits: [{ title: 'Clarity', before: 'selected text', after: 'clear text' }],
  });
  assert.equal((await service.session(input.root)).messages.at(-1).status, 'completed');
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').at(-1).params.effort, 'high');
  await service.send({
    ...input,
    mode: undefined,
    instruction: 'What does the selected sentence mean?',
  });
  await complete({ answer: 'It describes the selected text.', edits: [] });
  assert.equal((await service.session(input.root)).messages.at(-1).edits.length, 0);
  await assert.rejects(service.send({ ...input, effort: 'ultra' }), /思考强度/);
});

test('incomplete, missing, ambiguous and overlapping edits are fed back to the model before user review', async (t) => {
  const { service, input, client, complete, emitResult } = await fixture(t);
  await service.connect();
  const cases = [
    ['not JSON', 'AGENT_RESPONSE_FORMAT'],
    [
      { answer: 'Fix', edits: [{ title: 'Fix', before: 'absent', after: 'new' }] },
      'AGENT_EDIT_MISSING',
    ],
    [
      {
        answer: 'Fix',
        edits: [
          { title: 'A', before: 'selected', after: 'new' },
          { title: 'B', before: 'selected text', after: 'new' },
        ],
      },
      'AGENT_EDIT_OVERLAP',
    ],
  ];
  for (const [invalid, code] of cases) {
    await service.send({ ...input, mode: 'auto', effort: 'high' });
    await until(() => service.active?.turnId);
    const count = client.calls.filter((c) => c.method === 'turn/start').length;
    emitResult(invalid);
    await until(() => client.calls.filter((c) => c.method === 'turn/start').length === count + 1);
    const repair = client.calls.filter((c) => c.method === 'turn/start').at(-1).params;
    const feedback = JSON.parse(repair.input[0].text);
    assert.equal(feedback.validationIssue.code, code);
    assert.equal(feedback.editableContent, 'selected text');
    assert.equal(repair.effort, 'high');
    assert.equal(service.active.message.repairing, true);
    await complete({
      answer: 'Corrected.',
      edits: [{ title: 'Clarity', before: 'selected text', after: 'clear text' }],
    });
    assert.equal((await service.session(input.root)).messages.at(-1).status, 'completed');
  }
  await service.send({ ...input, content: 'same same', selection: null, mode: 'auto' });
  await complete({ answer: 'Bad', edits: [{ title: 'Ambiguous', before: 'same', after: 'new' }] });
  const message = (await service.session(input.root)).messages.at(-1);
  assert.equal(message.status, 'error');
  assert.deepEqual(message.edits, []);
  assert.equal(
    client.calls.filter(
      (c) =>
        c.method === 'turn/start' &&
        JSON.parse(c.params.input[0]?.text || '{}').validationIssue?.code ===
          'AGENT_EDIT_AMBIGUOUS',
    ).length,
    2,
  );
});

test('a changed draft is supplied to the model for repair, and cancellation while collecting context cannot resurrect edits', async (t) => {
  const { service, client, input, events, emitResult, complete } = await fixture(t, {
    contextEnabled: true,
  });
  await service.connect();
  await service.send({ ...input, mode: 'auto', selection: null });
  await until(() => service.active?.turnId);
  emitResult({
    answer: 'Old edit',
    edits: [{ title: 'Change', before: 'selected text', after: 'clear text' }],
  });
  await until(() => events.some((e) => e.type === 'context-request'));
  const request = events.filter((e) => e.type === 'context-request').at(-1);
  const content = 'private first\nhuman revision\nprivate last';
  service.resolveContext({ ...request, content, revision: 2 });
  await until(() => client.calls.filter((c) => c.method === 'turn/start').length === 2);
  const feedback = JSON.parse(client.calls.at(-1).params.input[0].text);
  assert.equal(feedback.validationIssue.code, 'AGENT_EDIT_CHANGED');
  assert.equal(feedback.editableContent, content);
  service.contextEnabled = false;
  await complete({
    answer: 'Rebased.',
    edits: [{ title: 'Change', before: 'human revision', after: 'clear revision' }],
  });
  assert.equal((await service.session(input.root)).messages.at(-1).base, content);
  service.contextEnabled = true;
  await service.send({ ...input, mode: 'auto', selection: null });
  await until(() => service.active?.turnId);
  const requests = events.filter((e) => e.type === 'context-request').length;
  emitResult({
    answer: 'New edit',
    edits: [{ title: 'Change', before: 'selected text', after: 'clear text' }],
  });
  await until(() => events.filter((e) => e.type === 'context-request').length > requests);
  await service.cancel(input.root);
  await tick();
  const stopped = (await service.session(input.root)).messages.at(-1);
  assert.equal(stopped.status, 'interrupted');
  assert.deepEqual(stopped.edits, []);
});

test('duplicate and late completed-turn events cannot corrupt a document-tool continuation', async (t) => {
  let release,
    reads = 0;
  const { service, client, input } = await fixture(t, {
    documentTools: {
      execute: async () => {
        reads++;
        await new Promise((resolve) => {
          release = resolve;
        });
        return { result: { excerpt: 'generated context' } };
      },
    },
  });
  await service.connect();
  await service.send({ ...input, mode: 'auto', selection: null });
  await until(() => service.active?.turnId);
  service.active.turnId = 'turn-1';
  const request = client.request;
  client.request = async (method, params) => {
    const result = await request(method, params);
    return method === 'turn/start' ? { turn: { id: 'turn-2' } } : result;
  };
  const response = {
    answer: '',
    edits: [],
    documentTool: { name: 'folio_read_document', query: '', path: 'Ref.md', offset: 0 },
  };
  client.emit('notification', 'item/completed', {
    threadId: 'fixture-thread',
    turnId: 'turn-1',
    item: { type: 'agentMessage', text: JSON.stringify(response) },
  });
  client.emit('notification', 'turn/completed', {
    threadId: 'fixture-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await until(() => !!release);
  client.emit('notification', 'turn/completed', {
    threadId: 'fixture-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  assert.equal(reads, 1);
  release();
  await until(() => service.active?.turnId === 'turn-2');
  client.emit('notification', 'item/completed', {
    threadId: 'fixture-thread',
    turnId: 'turn-1',
    item: { type: 'agentMessage', text: 'stale invalid data' },
  });
  client.emit('notification', 'turn/completed', {
    threadId: 'fixture-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  client.emit('notification', 'item/completed', {
    threadId: 'fixture-thread',
    turnId: 'turn-2',
    item: {
      type: 'agentMessage',
      text: JSON.stringify({ answer: 'Read the reference.', edits: [], documentTool: null }),
    },
  });
  client.emit('notification', 'turn/completed', {
    threadId: 'fixture-thread',
    turn: { id: 'turn-2', status: 'completed' },
  });
  await until(() => !service.active);
  await Promise.all([...service.writes.values()]);
  assert.equal((await service.session(input.root)).messages.at(-1).status, 'completed');
});

test('a repair turn that starts before its RPC reply is not interrupted', async (t) => {
  const { service, client, input, emitResult, complete } = await fixture(t);
  await service.connect();
  await service.send({ ...input, mode: 'auto' });
  await until(() => service.active?.turnId);
  const original = client.request;
  client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') {
      client.emit('notification', 'turn/started', {
        threadId: 'fixture-thread',
        turn: { id: 'repair-early' },
      });
      return { turn: { id: 'repair-early' } };
    }
    return result;
  };
  emitResult({ answer: 'Fix', edits: [{ title: 'Fix', before: 'missing', after: 'new' }] });
  await until(() => service.active?.turnId === 'repair-early');
  await tick();
  assert(!client.calls.some((c) => c.method === 'turn/interrupt'));
  await complete({
    answer: 'Corrected.',
    edits: [{ title: 'Fix', before: 'selected text', after: 'clear text' }],
  });
  assert.equal((await service.session(input.root)).messages.at(-1).status, 'completed');
});

test('healthy reasoning extends the inactivity timer and timeout is reported as an error, not a user stop', async (t) => {
  const { service, input, client } = await fixture(t, { turnTimeout: 80 });
  service.idleDelay = null;
  await service.connect();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await service.send({ ...input, mode: 'auto' });
  await tick();
  assert(service.active?.turnId);
  t.mock.timers.tick(70);
  client.emit('notification', 'item/reasoning/summaryTextDelta', {
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
  });
  t.mock.timers.tick(60);
  await tick();
  assert(service.active);
  t.mock.timers.tick(25);
  await tick();
  await until(() => !service.active);
  await Promise.all([...service.writes.values()]);
  const message = (await service.session(input.root)).messages.at(-1);
  assert.equal(message.status, 'error');
  assert.equal(message.stopReason, 'timeout');
  assert(message.error.includes('超时'));
  assert.deepEqual(message.edits, []);
  t.mock.timers.reset();
});

test('each document-tool turn receives a fresh response budget, while user stops retain their own reason', async (t) => {
  const { service, input, client, emitResult, complete } = await fixture(t, {
    turnTimeout: 100,
    documentTools: { execute: async () => ({ result: { excerpt: 'Generated reference' } }) },
  });
  service.idleDelay = null;
  await service.connect();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await service.send({ ...input, selection: null, mode: 'auto' });
  await tick();
  t.mock.timers.tick(80);
  emitResult({
    answer: '',
    edits: [],
    documentTool: { name: 'folio_read_document', query: '', path: 'Ref.md', offset: 0 },
  });
  await tick();
  await tick();
  assert.equal(client.calls.filter((c) => c.method === 'turn/start').length, 2);
  t.mock.timers.tick(40);
  await tick();
  assert(service.active);
  t.mock.timers.reset();
  await complete({ answer: 'Reference read.', edits: [], documentTool: null });
  await service.send({ ...input, mode: 'auto' });
  await tick();
  await service.cancel(input.root);
  assert.equal((await service.session(input.root)).messages.at(-1).stopReason, 'user');
  t.mock.timers.reset();
});

test('higher thinking effort has a larger wait budget and shutdown is recorded distinctly', async (t) => {
  const { activityTimeout } = createRequire(import.meta.url)('../core/agent-timeouts.cjs');
  assert(activityTimeout('high') > activityTimeout('low'));
  assert(activityTimeout('max') >= activityTimeout('high'));
  const { service, input } = await fixture(t);
  await service.connect();
  await service.send({ ...input, mode: 'auto', effort: 'high' });
  await tick();
  assert.equal(service.active.timeoutBudget, activityTimeout('high'));
  await service.close();
  assert.equal((await service.session(input.root)).messages.at(-1).stopReason, 'shutdown');
});
