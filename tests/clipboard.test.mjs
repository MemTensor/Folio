import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardWriter, MAX_CLIPBOARD_BYTES } from '../electron/clipboard.cjs';

test('native clipboard writes preserve text and reject oversized or non-text input', () => {
  const writes = [];
  const copy = createClipboardWriter({ writeText: (text) => writes.push(text) });
  const text = '诊断反馈\nhttps://auth.openai.com/example?state=generated';
  copy(text);
  assert.deepEqual(writes, [text]);
  for (const input of [null, { text }, '字'.repeat(Math.floor(MAX_CLIPBOARD_BYTES / 3) + 1)])
    assert.throws(() => copy(input), { code: 'CLIPBOARD_INPUT' });
  assert.deepEqual(writes, [text]);
});
