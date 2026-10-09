const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

async function run() {
  const bundle = path.resolve(process.argv[2]);
  const asar = path.join(bundle, 'Contents/Resources/app.asar');
  const { AgentService } = require(path.join(asar, 'core/agent-service.cjs'));
  assert.equal(typeof require(path.join(asar, 'electron/agent.cjs')).registerAgent, 'function');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-agent-package-'));
  const client = new EventEmitter();
  client.cwd = temporary;
  client.stop = () => {};
  client.request = async (method) => {
    if (method === 'thread/start') return { thread: { id: 'generated-thread' } };
    if (method === 'turn/start') {
      setTimeout(() => {
        client.emit('notification', 'item/completed', {
          threadId: 'generated-thread',
          item: {
            type: 'agentMessage',
            text: JSON.stringify({
              answer: 'Generated package check.',
              edits: [
                { title: 'Precise edit', before: 'Original sentence.', after: 'Revised sentence.' },
              ],
            }),
          },
        });
        client.emit('notification', 'turn/completed', {
          threadId: 'generated-thread',
          turn: { status: 'completed' },
        });
      }, 10);
      return { turn: { id: 'generated-turn' } };
    }
    return {};
  };
  let service;
  try {
    let finish;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });
    service = new AgentService({
      dataDir: temporary,
      client,
      onEvent: (event) => {
        if (event.type === 'session' && event.session.messages.length && !event.session.running)
          finish(event.session);
      },
    });
    service.connection = {
      phase: 'ready',
      models: [{ id: 'generated-model', name: 'Generated', isDefault: true }],
    };
    await service.send({
      root: temporary,
      path: path.join(temporary, 'Fixture.md'),
      content: '# Fixture\n\nOriginal sentence.\n',
      instruction: 'Refine the sentence',
      references: [],
      mode: 'edit',
      selection: null,
    });
    const session = await completed;
    assert.equal(session.messages.at(-1).status, 'completed');
    assert.equal(session.messages.at(-1).edits[0].after, 'Revised sentence.');
    console.log(JSON.stringify({ ok: true, asarAgentService: true, sourceValidation: true }));
  } finally {
    await service?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
const deadline = setTimeout(() => {
  console.error('Packaged agent verification timed out.');
  process.exit(1);
}, 10000);
void run()
  .then(() => clearTimeout(deadline))
  .catch((error) => {
    clearTimeout(deadline);
    console.error(error);
    process.exitCode = 1;
  });
