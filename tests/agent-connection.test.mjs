import test from 'node:test';
import assert from 'node:assert/strict';

test('a remounted panel immediately reads the shared account and model snapshot', async () => {
  const cache = await import('../src/agent-connection.mjs?warm-snapshot');
  const ready = {
    phase: 'ready',
    revision: 8,
    provider: 'chatgpt',
    account: { email: 'fixture@example.invalid', plan: 'pro' },
    models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', isDefault: true }],
  };
  let changes = 0;
  const off = cache.watchAgentConnection(() => changes++);
  cache.receiveAgentConnection(ready);
  assert.equal(cache.agentConnection(), ready);
  off();
  assert.equal(cache.agentConnection().phase, 'ready');
  assert.equal(cache.agentConnection().models[0].id, 'gpt-6-luna');
  cache.receiveAgentConnection({ phase: 'idle', models: [], revision: 7 });
  assert.equal(cache.agentConnection(), ready);
  assert.equal(changes, 1);
});

test('explicit settings changes update the shared snapshot even while the panel is closed', async () => {
  const cache = await import('../src/agent-connection.mjs?settings-update');
  cache.receiveAgentConnection({ phase: 'ready', models: [], provider: 'chatgpt', revision: 1 });
  cache.receiveAgentConnection({ phase: 'idle', models: [], provider: 'chatgpt', revision: 2 });
  assert.equal(cache.agentConnection().phase, 'idle');
  cache.receiveAgentConnection({
    phase: 'ready',
    models: [{ id: 'fixture-api', name: 'Fixture', isDefault: true }],
    provider: 'api',
    revision: 3,
  });
  assert.equal(cache.agentConnection().provider, 'api');
});
