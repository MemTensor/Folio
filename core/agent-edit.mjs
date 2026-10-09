/**
 * Exact Markdown replacements. No fuzzy matches, normalization, or disk writes.
 * @param {string} content
 * @param {Array<{title:string,before:string,after:string}>} edits
 * @param {{from:number,to:number}|null} selection
 */
export function prepareAgentEdits(content, edits, selection = null) {
  const invalid = (code, message, feedback) => Object.assign(Error(message), { code, feedback });
  if (typeof content !== 'string' || !Array.isArray(edits) || edits.length > 8)
    throw invalid('AGENT_EDIT_SHAPE', 'Agent 返回的修改内容不完整。', {
      issue:
        'Use at most 8 edits, each with string title/before/after. Omit no-op edits and overly large replacements.',
    });
  const range = selection || { from: 0, to: content.length };
  if (
    !Number.isInteger(range.from) ||
    !Number.isInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from ||
    range.to > content.length
  )
    throw invalid('AGENT_EDIT_SELECTION', '选区已变化，请重新选择文字。');
  const prepared = edits.map((edit, index) => {
    if (
      !edit ||
      typeof edit.before !== 'string' ||
      typeof edit.after !== 'string' ||
      typeof edit.title !== 'string' ||
      edit.before === edit.after ||
      edit.before.length + edit.after.length > 300000
    )
      throw invalid('AGENT_EDIT_SHAPE', 'Agent 返回的修改内容不完整。', {
        issue:
          'Use at most 8 edits, each with string title/before/after. Omit no-op edits and overly large replacements.',
      });
    let from;
    if (edit.before === '' && content === '') from = 0;
    else {
      if (!edit.before)
        throw invalid('AGENT_EDIT_MISSING', '建议要替换的原文在当前文档中不存在。', {
          index,
          issue:
            'before must exactly match the supplied editable source, including Markdown syntax and whitespace. Do not normalize or guess the original text.',
        });
      const scope = content.slice(range.from, range.to);
      const found = scope.indexOf(edit.before);
      if (found < 0)
        throw invalid('AGENT_EDIT_MISSING', '建议要替换的原文在当前文档中不存在。', {
          index,
          issue:
            'before must exactly match the supplied editable source, including Markdown syntax and whitespace. Do not normalize or guess the original text.',
        });
      if (scope.indexOf(edit.before, found + 1) >= 0)
        throw invalid('AGENT_EDIT_AMBIGUOUS', '建议要替换的原文出现多次，无法确定修改位置。', {
          index,
          issue: 'Include unchanged surrounding source to make before unique.',
        });
      from = range.from + found;
    }
    return { ...edit, id: String(index), from, to: from + edit.before.length };
  });
  const sorted = [...prepared].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].from < sorted[i - 1].to || sorted[i].from === sorted[i - 1].from)
      throw invalid('AGENT_EDIT_OVERLAP', '多处修改建议覆盖了同一段原文。', {
        indexes: [sorted[i - 1].id, sorted[i].id],
        issue:
          'Combine these overlapping replacements into one exact change or choose disjoint spans.',
      });
  return prepared;
}

/** @param {string} content @param {Array<{from:number,to:number,before:string,after:string}>} edits */
export function applyAgentEdits(content, edits) {
  let next = content;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    if (content.slice(edit.from, edit.to) !== edit.before)
      throw Error('文档已变化，请重新生成修改建议。');
    next = next.slice(0, edit.from) + edit.after + next.slice(edit.to);
  }
  return next;
}
