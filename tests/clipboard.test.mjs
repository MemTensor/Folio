import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClipboardWriter,
  createRichClipboardWriter,
  MAX_CLIPBOARD_BYTES,
} from '../electron/clipboard.cjs';

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
test('rich clipboard writes provide both HTML and plain text without accepting other fields', () => {
  const writes = [];
  const copy = createRichClipboardWriter({ write: (value) => writes.push(value) });
  const value = { text: 'Heading\nBold', html: '<h2>Heading</h2><p><strong>Bold</strong></p>' };
  copy(value);
  copy({ text: '**Bold**' });
  assert.deepEqual(writes, [value, { text: '**Bold**' }]);
  for (const invalid of [
    null,
    [],
    { text: 'x', html: 3 },
    { text: 'x', path: '/private/secret' },
    { text: 'x', html: 'x'.repeat(MAX_CLIPBOARD_BYTES) },
  ])
    assert.throws(() => copy(invalid), { code: 'CLIPBOARD_INPUT' });
  assert.equal(writes.length, 2);
});
