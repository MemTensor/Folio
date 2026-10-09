import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAgentEdits, applyAgentEdits } from '../core/agent-edit.mjs';

test('document proposals preserve surrounding math, fences, YAML and Unicode exactly', () => {
  const source =
    '---\ntitle: 原文\n---\n# 😀 文档\n\nA vague sentence.\n\n\\[\na^2+b^2=c^2\n\\]\n\n```text\nkeep this\n```\n\nSecond sentence.\n';
  const edits = prepareAgentEdits(source, [
    { title: 'Clarity', before: 'A vague sentence.', after: 'A precise sentence.' },
    { title: 'Remove', before: 'Second sentence.', after: '' },
  ]);
  assert.equal(
    applyAgentEdits(source, edits),
    source.replace('A vague sentence.', 'A precise sentence.').replace('Second sentence.', ''),
  );
  assert.equal(edits[0].from, source.indexOf('A vague'));
  assert.equal(source.slice(edits[0].from, edits[0].to), edits[0].before);
});

test('ambiguous, missing, overlapping and stale replacements fail closed', () => {
  const edit = (before, after = 'changed') => ({ title: 'Change', before, after });
  assert.throws(() => prepareAgentEdits('repeat repeat', [edit('repeat')]));
  assert.throws(() => prepareAgentEdits('original', [edit('not here')]));
  assert.throws(() => prepareAgentEdits('abcdef', [edit('abc'), edit('bcde')]));
  assert.throws(() => prepareAgentEdits('content', [edit('')]));
  const proposals = prepareAgentEdits('original', [edit('original')]);
  assert.throws(() => applyAgentEdits('human new content', proposals));
});

test('selection edits cannot change an identical sentence outside the selected range', () => {
  const source = 'same\nkeep\nsame';
  const selection = { from: 10, to: 14 };
  const edits = prepareAgentEdits(
    source,
    [{ title: 'Selection', before: 'same', after: 'new' }],
    selection,
  );
  assert.equal(applyAgentEdits(source, edits), 'same\nkeep\nnew');
  assert.throws(() =>
    prepareAgentEdits(source, [{ title: 'Escape', before: 'keep', after: 'erase' }], selection),
  );
  assert.throws(() => prepareAgentEdits(source, [], { from: -1, to: 10 }));
  assert.throws(() => prepareAgentEdits(source, [], { from: 0, to: 999 }));
});

test('an empty document can receive a first draft, while partial acceptance changes only chosen ranges', () => {
  const first = prepareAgentEdits('', [{ title: 'Draft', before: '', after: '# New\n' }]);
  assert.equal(applyAgentEdits('', first), '# New\n');
  const edits = prepareAgentEdits('one two three', [
    { title: 'One', before: 'one', after: '1' },
    { title: 'Three', before: 'three', after: '3' },
  ]);
  assert.equal(applyAgentEdits('one two three', [edits[1]]), 'one two 3');
});
