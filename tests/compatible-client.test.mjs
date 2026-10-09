import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AgentSettings, apiURL } = require('../core/agent-settings.cjs');
const { CompatibleClient } = require('../core/compatible-client.cjs');
const { AgentService } = require('../core/agent-service.cjs');
const cryptoFixture = {
  encrypt: async (value) => Buffer.from(value.split('').reverse().join('')).toString('base64'),
  decrypt: async (value) => Buffer.from(value, 'base64').toString().split('').reverse().join(''),
};
async function settingsFixture(t) {
  const dataDir = await mkdtemp('/private/tmp/folio-api-');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { settings: new AgentSettings(dataDir, cryptoFixture), dataDir };
}
async function endpoint(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}/v1`;
}
async function completion(client, content = 'generated request') {
  await client.start();
  const { thread } = await client.request('thread/start', {
    baseInstructions: 'Generated fixture.',
  });
  const result = new Promise((resolve) =>
    client.on('notification', (method, params) => {
      if (method === 'turn/completed') resolve(params);
    }),
  );
  await client.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: content }],
    outputSchema: { type: 'object' },
  });
  return result;
}

test('API settings keep encrypted credentials private and require a new key for a different endpoint', async (t) => {
  const { settings } = await settingsFixture(t);
  await settings.configure({
    provider: 'api',
    baseURL: 'https://example.invalid/v1/',
    model: 'fixture-model',
    apiKey: 'generated-secret-key',
  });
  const visible = await settings.status();
  assert.equal(visible.baseURL, 'https://example.invalid/v1');
  assert(visible.hasKey);
  assert(!JSON.stringify(visible).includes('generated-secret-key'));
  assert(!(await readFile(settings.file, 'utf8')).includes('generated-secret-key'));
  assert.equal((await settings.credentials()).apiKey, 'generated-secret-key');
  await assert.rejects(
    settings.configure({
      provider: 'api',
      baseURL: 'https://another.invalid/v1',
      model: 'fixture-model',
    }),
    /重新填写/,
  );
  assert.throws(() => apiURL('https://key@example.invalid/v1'));
  assert.throws(() => apiURL('https://example.invalid/v1?key=secret'));
  assert.throws(() => apiURL('http://remote.invalid/v1'));
  assert.equal(apiURL('http://localhost:8080/v1/'), 'http://localhost:8080/v1');
});

test('Chat Completions transport handles split UTF-8 and CRLF streams with the standard bearer header', async (t) => {
  const { settings } = await settingsFixture(t);
  let received;
  const baseURL = await endpoint(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer generated-key');
    let body = '';
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = JSON.stringify({ answer: '公式 😀 清晰', edits: [] });
    const frame = Buffer.from(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\r\n\r\n',
    );
    const emoji = frame.indexOf(Buffer.from('😀'));
    res.write(frame.subarray(0, emoji + 1));
    res.write(frame.subarray(emoji + 1, frame.length - 1));
    res.write(frame.subarray(frame.length - 1));
    res.end('data: [DONE]\r\n\r\n');
  });
  await settings.configure({
    provider: 'api',
    baseURL,
    model: 'fixture-chat',
    apiKey: 'generated-key',
  });
  const client = new CompatibleClient(settings),
    deltas = [];
  client.on('notification', (method, params) => {
    if (method === 'item/agentMessage/delta') deltas.push(params.delta);
  });
  const result = await completion(client);
  assert.equal(result.turn.status, 'completed');
  assert.equal(JSON.parse(deltas.join('')).answer, '公式 😀 清晰');
  assert.equal(received.stream, true);
  assert.equal(received.model, 'fixture-chat');
  assert.equal(received.messages[1].content, 'generated request');
  assert.equal(received.tools, undefined);
});

test('JSON-only providers, model discovery and redirects have bounded, secret-free outcomes', async (t) => {
  const { settings } = await settingsFixture(t);
  let pathUsed;
  const baseURL = await endpoint(t, (req, res) => {
    pathUsed = req.url;
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'Plain answer' }, finish_reason: 'stop' }],
        }),
      );
    }
  });
  await settings.configure({ provider: 'api', baseURL, model: 'fixture-model' });
  const client = new CompatibleClient(settings);
  assert.deepEqual((await client.test()).models, ['fixture-model']);
  assert.equal(pathUsed, '/v1/models');
  assert.equal((await completion(client)).turn.status, 'completed');
  const deniedURL = await endpoint(t, (_req, res) => {
    res.statusCode = 401;
    res.end('generated-secret-key');
  });
  await settings.configure({
    provider: 'api',
    baseURL: deniedURL,
    model: 'fixture-model',
    apiKey: 'generated-secret-key',
  });
  const denied = await completion(client);
  assert.equal(denied.turn.status, 'failed');
  assert(!JSON.stringify(denied).includes('generated-secret-key'));
  let forwarded = 0;
  const target = await endpoint(t, (_req, res) => {
    forwarded++;
    res.end('bad');
  });
  const redirect = await endpoint(t, (_req, res) => {
    res.writeHead(302, { Location: target });
    res.end();
  });
  await settings.configure({
    provider: 'api',
    baseURL: redirect,
    model: 'fixture-model',
    apiKey: 'generated-secret-key',
  });
  assert.equal((await completion(client)).turn.status, 'failed');
  assert.equal(forwarded, 0);
});

test('API edits use the same source validation and do not automatically apply or resend a request', async (t) => {
  const { settings, dataDir } = await settingsFixture(t);
  let requests = 0;
  const baseURL = await endpoint(t, async (req, res) => {
    requests++;
    let raw = '';
    for await (const data of req) raw += data;
    const prompt = JSON.parse(JSON.parse(raw).messages[1].content);
    assert.equal(prompt.editableDocument.content, 'selected sentence');
    const output =
      '```json\n' +
      JSON.stringify({
        answer: 'Clearer.',
        edits: [{ title: 'Selected', before: 'selected sentence', after: 'clear sentence' }],
      }) +
      '\n```';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
  });
  await settings.configure({ provider: 'api', baseURL, model: 'fixture-model' });
  const service = new AgentService({ dataDir, settings });
  t.after(() => service.close());
  await service.acquire('api-panel');
  await service.connect();
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  service.onEvent = (event) => {
    if (event.type === 'session' && event.session.messages.length && !event.session.running)
      resolve(event.session);
  };
  await service.send({
    root: '/generated/project',
    path: '/generated/project/Doc.md',
    content: 'before\nselected sentence\nafter',
    selection: { from: 7, to: 24 },
    references: [],
    instruction: 'Refine',
    mode: 'edit',
  });
  const message = (await done).messages.at(-1);
  assert.equal(message.status, 'completed');
  assert.equal(message.edits[0].from, 7);
  assert.equal(message.provider, 'api');
  assert.equal(message.outcome, undefined);
  assert.equal(requests, 1);
});

test('a stopped API request releases its stream and exposes no pending edits', async (t) => {
  const { settings } = await settingsFixture(t);
  let seen;
  const arrived = new Promise((resolve) => {
    seen = resolve;
  });
  const baseURL = await endpoint(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    seen();
  });
  await settings.configure({ provider: 'api', baseURL, model: 'fixture-model' });
  const client = new CompatibleClient(settings);
  await client.start();
  const { thread } = await client.request('thread/start', { baseInstructions: 'Fixture' });
  const result = new Promise((resolve) =>
    client.on('notification', (method, params) => {
      if (method === 'turn/completed') resolve(params);
    }),
  );
  await client.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Fixture' }],
  });
  await arrived;
  await client.request('turn/interrupt', { threadId: thread.id });
  assert.equal((await result).turn.status, 'interrupted');
});

test('shutdown finishes saving an API credential and does not start a replacement connection', async (t) => {
  const { settings, dataDir } = await settingsFixture(t);
  let finishEncryption;
  settings.encrypt = async (key) => {
    await new Promise((resolve) => {
      finishEncryption = resolve;
    });
    return cryptoFixture.encrypt(key);
  };
  const service = new AgentService({ dataDir, settings });
  const saving = service.configure({
    provider: 'api',
    baseURL: 'https://generated.invalid/v1',
    model: 'fixture-model',
    apiKey: 'generated-key',
  });
  for (let i = 0; !finishEncryption && i < 50; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert(finishEncryption);
  await assert.rejects(service.configure({ provider: 'chatgpt' }), /Agent 设置/);
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(closed, false);
  finishEncryption();
  await saving;
  await closing;
  assert.equal((await settings.credentials()).apiKey, 'generated-key');
  assert.equal(service.apiClient.started, false);
});

for (const streaming of [false, true])
  test(`API document tools complete a bounded ${streaming ? 'streamed' : 'JSON'} tool round trip with sources`, async (t) => {
    const { settings, dataDir } = await settingsFixture(t);
    const requests = [];
    const baseURL = await endpoint(t, async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      if (requests.length === 1) {
        const call = {
          id: 'generated-read',
          type: 'function',
          function: {
            name: 'folio_read_document',
            arguments: JSON.stringify({ path: 'Ref.md', offset: 0 }),
          },
        };
        if (streaming) {
          res.setHeader('Content-Type', 'text/event-stream');
          const argumentsText = call.function.arguments;
          for (const toolPart of [
            {
              index: 0,
              id: call.id,
              type: 'function',
              function: { name: call.function.name, arguments: argumentsText.slice(0, 10) },
            },
            { index: 0, function: { arguments: argumentsText.slice(10) } },
          ])
            res.write(
              'data: ' +
                JSON.stringify({ choices: [{ delta: { tool_calls: [toolPart] } }] }) +
                '\n\n',
            );
          res.end('data: [DONE]\n\n');
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }),
          );
        }
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: 'According to Ref.md, 150 steps were documented.',
                    edits: [],
                  }),
                },
              },
            ],
          }),
        );
      }
    });
    await settings.configure({ provider: 'api', baseURL, model: 'fixture-model' });
    const reads = [];
    const service = new AgentService({
      dataDir,
      settings,
      documentTools: {
        execute: async (root, name, args) => {
          reads.push({ root, name, args });
          return {
            result: { excerpt: '150 steps' },
            source: { path: '/generated/project/Ref.md', name: 'Ref.md', line: 1, endLine: 1 },
          };
        },
      },
    });
    t.after(() => service.close());
    let finished;
    const completion = new Promise((resolve) => {
      finished = resolve;
    });
    service.onEvent = (event) => {
      if (event.type === 'session' && event.session.messages.length && !event.session.running)
        finished(event.session);
    };
    await service.connect();
    await service.send({
      root: '/generated/project',
      path: '/generated/project/Current.md',
      content: '# Report',
      selection: null,
      instruction: 'Compare with Ref.md.',
      mode: 'ask',
      references: [],
      language: 'English',
    });
    const result = await completion;
    assert.equal(result.messages.at(-1).status, 'completed');
    assert.equal(result.messages.at(-1).sources[0].name, 'Ref.md');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools.length, 3);
    const output = JSON.parse(requests[1].messages.at(-1).content);
    assert.equal(output.success, true);
    assert.equal(JSON.parse(output.contentItems[0].text).excerpt, '150 steps');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].root, '/generated/project');
  });

test('API repair preserves conversation and effort, returns valid edits and never applies them', async (t) => {
  const { settings, dataDir } = await settingsFixture(t);
  const requests = [];
  const baseURL = await endpoint(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const text = requests.length === 1 ? 'missing source' : 'Original sentence.';
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: 'Correction.',
                edits: [{ title: 'Clarity', before: text, after: 'Clear sentence.' }],
              }),
            },
          },
        ],
      }),
    );
  });
  await settings.configure({ provider: 'api', baseURL, model: 'fixture-model' });
  let resolve;
  const finished = new Promise((r) => {
    resolve = r;
  });
  const service = new AgentService({
    dataDir,
    settings,
    onEvent: (event) => {
      if (event.type === 'session' && event.session.messages.length && !event.session.running)
        resolve(event.session);
    },
  });
  t.after(() => service.close());
  await service.connect();
  await service.send({
    root: '/generated/project',
    path: '/generated/project/Current.md',
    content: 'Original sentence.',
    mode: 'auto',
    effort: 'high',
    instruction: 'Fix the wording.',
    selection: null,
    references: [],
    language: 'English',
  });
  const session = await finished;
  assert.equal(session.messages.at(-1).status, 'completed');
  assert.equal(session.messages.at(-1).base, 'Original sentence.');
  assert.equal(requests.length, 2);
  assert(requests.every((request) => request.reasoning_effort === 'high'));
  assert(
    requests[1].messages.some(
      (message) => message.role === 'assistant' && message.content.includes('missing source'),
    ),
  );
  assert.equal(
    JSON.parse(requests[1].messages.at(-1).content).validationIssue.code,
    'AGENT_EDIT_MISSING',
  );
  assert.equal(session.messages.at(-1).outcome, undefined);
});

test('API visual tool output uses image input instead of stuffing base64 into tool text', async (t) => {
  const { settings, dataDir } = await settingsFixture(t);
  const requests = [];
  const image = 'data:image/png;base64,generated-preview';
  const baseURL = await endpoint(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message:
              requests.length === 1
                ? {
                    content: null,
                    tool_calls: [
                      {
                        id: 'preview',
                        type: 'function',
                        function: { name: 'folio_preview_document', arguments: '{}' },
                      },
                    ],
                  }
                : {
                    content: JSON.stringify({ answer: 'The visible table is aligned.', edits: [] }),
                  },
          },
        ],
      }),
    );
  });
  await settings.configure({ provider: 'api', baseURL, model: 'fixture-model' });
  const client = new CompatibleClient(settings);
  client.toolHandler = async () => ({
    success: true,
    contentItems: [
      { type: 'inputText', text: '{"viewportOnly":true}' },
      { type: 'inputImage', imageUrl: image },
    ],
  });
  await client.start();
  const { thread } = await client.request('thread/start', {
    baseInstructions: 'Generated fixture.',
    dynamicTools: require('../core/agent-documents.cjs').TOOLS,
  });
  const finished = new Promise((resolve) =>
    client.on('notification', (method, params) => {
      if (method === 'turn/completed') resolve(params);
    }),
  );
  await client.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Check the rendered table.' }],
    outputSchema: { type: 'object' },
  });
  assert.equal((await finished).turn.status, 'completed');
  assert(
    !requests[1].messages.find((message) => message.role === 'tool').content.includes('base64'),
  );
  assert.equal(requests[1].messages.at(-1).content[1].image_url.url, image);
  await client.close();
});
