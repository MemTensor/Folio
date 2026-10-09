import test from 'node:test';
import assert from 'node:assert/strict';
import { merge3, resolveMerge, edits, revertChange, reviewChanges } from '../core/merge.mjs';
test('independent edits are preserved from both sides', () => {
  const m = merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
  assert.equal(m.conflicts, 0);
  assert.equal(resolveMerge(m), 'A\nb\nC\n');
});
test('same-line edits require explicit resolution', () => {
  const m = merge3('a\nb\n', 'a\nhuman\n', 'a\nagent\n');
  assert.equal(m.conflicts, 1);
  assert.throws(() => resolveMerge(m));
  assert.equal(resolveMerge(m, { 0: 'local' }), 'a\nhuman\n');
  assert.equal(resolveMerge(m, { 0: 'remote' }), 'a\nagent\n');
});
test('same concurrent edit is not a conflict', () => {
  const m = merge3('a', 'b', 'b');
  assert.equal(m.conflicts, 0);
  assert.equal(resolveMerge(m), 'b');
});
test('empty documents and final newline are preserved', () => {
  assert.equal(resolveMerge(merge3('', '', 'new')), 'new');
  assert.equal(resolveMerge(merge3('a\n', 'a', 'a\n')), 'a');
  assert.deepEqual(edits('', ''), []);
});
test('delete versus edit is a conflict', () => {
  assert.equal(merge3('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n').conflicts, 1);
});
test('two insertions at the same position require a choice', () => {
  assert.equal(merge3('a\n', 'x\na\n', 'y\na\n').conflicts, 1);
});
test('adjacent but distinct line edits merge cleanly', () => {
  const m = merge3('a\nb\n', 'A\nb\n', 'a\nB\n');
  assert.equal(m.conflicts, 0);
  assert.equal(resolveMerge(m), 'A\nB\n');
});
test('identities hold over varied contents', () => {
  for (const a of ['', 'a', 'a\n', '一\n二\n', '---\nx: 1\n---\n'])
    for (const b of ['', 'b', 'a\nb\n', '新内容\n']) {
      assert.equal(resolveMerge(merge3(a, a, b)), b);
      assert.equal(resolveMerge(merge3(a, b, a)), b);
      assert.equal(resolveMerge(merge3(a, b, b)), b);
    }
});
test('reverting one external hunk retains the other external hunks', () => {
  assert.equal(revertChange('a\nb\nc\n', 'A\nb\nC\n', 0), 'a\nb\nC\n');
  assert.equal(revertChange('a\nb\nc\n', 'A\nb\nC\n', 1), 'A\nb\nc\n');
});
test('over-budget merge preserves all three complete versions and demands an explicit choice', () => {
  for (const n of [4000, 8000]) {
    const make = (prefix) => Array.from({ length: n }, (_, i) => prefix + i + '\n').join('');
    const base = make('base'),
      local = make('human'),
      remote = make('agent'),
      start = performance.now();
    const result = merge3(base, local, remote);
    assert(performance.now() - start < 1000);
    assert.equal(result.conflicts, 1);
    assert.equal(result.budgetExceeded, true);
    assert.equal(result.segments[0].base, base);
    assert.throws(() => resolveMerge(result));
    assert.equal(resolveMerge(result, { 0: 'local' }), local);
    assert.equal(resolveMerge(result, { 0: 'remote' }), remote);
    assert.equal(resolveMerge(merge3(base, base, remote)), remote);
    assert.equal(resolveMerge(merge3(base, local, local)), local);
  }
});
test('coarse diff review shows complete content and whole-document revert is explicit', () => {
  const before = 'a\nb\nc\n',
    after = 'x\ny\nz\n';
  const diff = reviewChanges(before, after, { maxEditLength: 1 });
  assert.equal(diff.length, 2);
  assert(diff.every((item) => item.wholeDocument && item.hunk === 0));
  assert.equal(diff[0].text, before);
  assert.equal(diff[1].text, after);
  assert.equal(revertChange(before, after, 0, { wholeDocument: true }), before);
});
