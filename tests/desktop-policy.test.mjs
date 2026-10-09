import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { desktopCloudOptions, printHTML, withDeadline } = require('../core/desktop-policy.cjs');
test('desktop cloud IPC rejects file paths and service overrides, including hidden inherited properties', () => {
  for (const input of [
    { keyFile: '/generated/private-token' },
    { baseURL: 'https://attacker.invalid' },
    { userId: 'other' },
    [],
    null,
  ])
    assert.throws(() => desktopCloudOptions(input));
  const inherited = Object.create({
    keyFile: '/generated/private-token',
    baseURL: 'https://attacker.invalid',
  });
  inherited.apiKey = 'generated-api-key';
  assert.deepEqual(desktopCloudOptions(inherited), {
    apiKey: 'generated-api-key',
    clearKey: false,
  });
  assert.deepEqual(desktopCloudOptions({ clearKey: true }), { apiKey: undefined, clearKey: true });
});
test('print policy precedes supplied HTML and caps final UTF-8 bytes', () => {
  const body =
      '<html><body><img src="data:image/png;base64,AA=="><svg><path d="M0 0"></path></svg><script>malicious()</script></body></html>',
    out = printHTML(body);
  assert(out.indexOf('script-src') < out.indexOf('<script>'));
  assert(out.includes("connect-src 'none'"));
  assert(out.includes('<svg>'));
  assert(out.includes('data:image/png'));
  assert.throws(() => printHTML('中'.repeat(4), 10), /过大/);
});
test('export deadlines return successful results and reject stalled resources', async () => {
  assert.equal(await withDeadline(async () => 42, 100, '测试超时。'), 42);
  await assert.rejects(
    withDeadline(() => new Promise(() => {}), 5, '生成 PDF 超时，请检查图片或缩小文档后重试。'),
    // The deadline reports the caller's whole sentence, which the dictionary can key on.
    { message: '生成 PDF 超时，请检查图片或缩小文档后重试。' },
  );
  const error = Error('original failure');
  await assert.rejects(
    withDeadline(() => Promise.reject(error), 100, '测试超时。'),
    (e) => e === error,
  );
});
