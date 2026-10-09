import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wordExportMessage } = require('../electron/export-message.cjs');

test('Word export joins all English notices with one sentence boundary', () => {
  assert.equal(
    wordExportMessage({ fallbackCount: 1, warnings: 'rsvg-convert unavailable' }, 'en'),
    'Word document exported. 1 special equation uses a vector image; the rest stay editable. Use a Word version that supports SVG for vector illustrations.',
  );
  assert.equal(
    wordExportMessage({ fallbackCount: 2, warnings: 'Generated converter warning.' }, 'en'),
    'Word document exported. 2 special equations use a vector image; the rest stay editable. Conversion note: Generated converter warning.',
  );
  assert.equal(
    wordExportMessage({ fallbackCount: 0, warnings: 'Generated converter warning.' }, 'en'),
    'Word document exported. Conversion note: Generated converter warning.',
  );
  assert.equal(
    wordExportMessage({ fallbackCount: 2 }, 'en'),
    'Word document exported. 2 special equations use a vector image; the rest stay editable.',
  );
});

test('Word export keeps Chinese sentence joins and bounds raw conversion warnings', () => {
  assert.equal(
    wordExportMessage({ fallbackCount: 2, warnings: 'rsvg-convert unavailable' }, 'zh-CN'),
    'Word 已导出。2 条特殊公式使用矢量图，其余公式可编辑。矢量插图请使用支持 SVG 的 Word 版本。',
  );
  const warning = 'generated diagnostic '.repeat(20);
  assert.equal(
    wordExportMessage({ fallbackCount: 1, warnings: warning }, 'zh-CN'),
    'Word 已导出。1 条特殊公式使用矢量图，其余公式可编辑。转换提示：' +
      warning.slice(0, 180).trimEnd(),
  );
  assert.equal(wordExportMessage({ fallbackCount: 0 }, 'en'), 'Word document exported.');
  assert.equal(wordExportMessage({ fallbackCount: 0 }, 'zh-CN'), 'Word 已导出。');
});
