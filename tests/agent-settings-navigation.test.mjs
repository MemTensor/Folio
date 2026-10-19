import test from 'node:test';
import assert from 'node:assert/strict';
import { problemSettingsTarget, settingsReturnReady } from '../src/agent-settings-navigation.mjs';

test('known API failures point to the relevant field, while document errors do not open configuration', () => {
  assert.deepEqual(problemSettingsTarget('API 授权失败，请在设置中检查 API Key。'), {
    provider: 'api',
    field: 'key',
  });
  assert.deepEqual(problemSettingsTarget('API 地址需要使用 HTTPS；本机服务可以使用 HTTP。'), {
    provider: 'api',
    field: 'baseURL',
  });
  assert.deepEqual(problemSettingsTarget('模型列表格式不兼容，请手动填写模型名称。'), {
    provider: 'api',
    field: 'model',
  });
  for (const text of [
    undefined,
    '文档已经变化。',
    'Your API quotation in this document',
    '回复格式不完整',
  ])
    assert.equal(problemSettingsTarget(text), null);
});

test('configuration returns only for the intended provider after completion and saved inputs', () => {
  const ready = { phase: 'ready', provider: 'api' };
  assert.equal(settingsReturnReady('api', 'api', ready, true, false), true);
  for (const [intent, selected, connection, saved, busy] of [
    [null, 'api', ready, true, false],
    ['api', 'chatgpt', ready, true, false],
    ['api', 'api', { phase: 'ready', provider: 'chatgpt' }, true, false],
    ['api', 'api', ready, false, false],
    ['api', 'api', ready, true, true],
    ...['idle', 'connecting', 'login', 'error', 'missing'].map((phase) => [
      'api',
      'api',
      { phase, provider: 'api' },
      true,
      false,
    ]),
  ])
    assert.equal(settingsReturnReady(intent, selected, connection, saved, busy), false);
  assert.equal(settingsReturnReady('chatgpt', 'chatgpt', { phase: 'ready' }, false, false), true);
});
