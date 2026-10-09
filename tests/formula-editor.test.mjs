import test from 'node:test';
import assert from 'node:assert/strict';
import { formulaEditorBody, formulaEditorMarkdown } from '../src/formula-editor.mjs';

test('editing a bracket-delimited display formula retains its delimiters and TeX', () => {
  const original = String.raw`\[
|F_P(A)-F_Q(A)|
\le
\sum_i w_i\,TV(P_i,Q_i)
\]`;
  const body = formulaEditorBody(original);
  assert.equal(
    body,
    String.raw`|F_P(A)-F_Q(A)|
\le
\sum_i w_i\,TV(P_i,Q_i)`,
  );
  const edited = formulaEditorMarkdown(original, body + '\\quad + \\eta');
  assert.equal(edited, '\\[\n' + body + '\\quad + \\eta\n\\]');
  assert.equal(formulaEditorBody(edited), body + '\\quad + \\eta');
  assert.equal((edited.match(/\\\[/g) || []).length, 1);
  assert.equal((edited.match(/\\\]/g) || []).length, 1);
});

test('existing dollar-delimited display formulas keep their source convention', () => {
  const original = '$$\nE = mc^2\n$$';
  assert.equal(formulaEditorBody(original), 'E = mc^2');
  assert.equal(formulaEditorMarkdown(original, 'E = mc^2 + x'), '$$\nE = mc^2 + x\n$$');
});
