import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTable, serializeTable, pasteCells } from '../core/table.mjs';
test('table roundtrip retains inline math, escaped pipes, formatting and alignments', () => {
  const raw = '| 名称 | 公式 | 代码 |\n| :--- | :---: | ---: |\n| **均值** | $\\mu=1$ | `a\\|b` |';
  const parsed = parseTable(raw);
  assert.equal(parsed.cells[1][2], '`a|b`');
  assert.deepEqual(parsed.align, ['left', 'center', 'right']);
  assert.deepEqual(parseTable(serializeTable(parsed.cells, parsed.align)), parsed);
});
test('spreadsheet paste expands rows and columns without losing existing cells', () => {
  assert.deepEqual(
    pasteCells(
      [
        ['A', 'B'],
        ['x', 'y'],
      ],
      1,
      1,
      '1\t2\r\n3\t4\r\n',
    ),
    [
      ['A', 'B', ''],
      ['x', '1', '2'],
      ['', '3', '4'],
    ],
  );
});
test('multiline cells serialize as explicit breaks and short rows are padded', () => {
  const p = parseTable('| A | B |\n|---|---|\n|one|');
  assert.deepEqual(p.cells, [
    ['A', 'B'],
    ['one', ''],
  ]);
  assert.match(serializeTable([['A'], ['one\ntwo']], ['left']), /one<br>two/);
  // A break written as <br> must read back as a break, or every visit to the
  // table editor turns one line into the literal text "one<br>two".
  assert.deepEqual(parseTable(serializeTable([['A'], ['one\ntwo']], ['left'])).cells, [
    ['A'],
    ['one\ntwo'],
  ]);
});
test('editing a table leaves untouched alignment markers byte-identical', () => {
  for (const raw of [
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '| a | b |\n| :--- | ---: |\n| 1 | 2 |',
    '| a | b |\n| :---: | --- |\n| 1 | 2 |',
  ]) {
    const parsed = parseTable(raw);
    assert.equal(serializeTable(parsed.cells, parsed.align), raw, raw);
  }
  assert.deepEqual(parseTable('| a |\n| --- |\n| 1 |').align, ['default']);
});

test('new English tables use English headers without changing existing Markdown cells', () => {
  assert.deepEqual(parseTable('', ['Item', 'Description']).cells[0], ['Item', 'Description']);
  assert.deepEqual(
    parseTable('| 项目 | 说明 |\n| --- | --- |\n| a | b |', ['Item', 'Description']).cells[0],
    ['项目', '说明'],
  );
});
