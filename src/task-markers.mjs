/**
 * Annotate only the task tokens emitted by markdown-it-task-lists. Their maps
 * identify real Markdown list items, excluding task-looking text in code.
 * @param {{src:string,tokens:any[]}} state
 */
export function annotateTaskMarkers(state) {
  const lines = state.src.split('\n'),
    offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  for (let i = 2; i < state.tokens.length; i++) {
    const inline = state.tokens[i],
      item = state.tokens[i - 2];
    if (
      inline.type !== 'inline' ||
      item.type !== 'list_item_open' ||
      !item.attrGet('class')?.split(' ').includes('task-list-item')
    )
      continue;
    const checkbox = inline.children?.find(
      (child) =>
        child.type === 'html_inline' &&
        /^<input class="task-list-item-checkbox"/.test(child.content),
    );
    const lineNumber = inline.map?.[0];
    if (!checkbox || lineNumber === undefined) continue;
    const match = /\[([ xX])\](?= )/.exec(lines[lineNumber]);
    if (!match) continue;
    checkbox.type = 'folio_task_checkbox';
    checkbox.content = '';
    checkbox.meta = { offset: offsets[lineNumber] + match.index + 1, checked: match[1] !== ' ' };
  }
}

/** @param {string} content @param {number} offset @param {number} from @param {number} to */
export function taskToggleChange(content, offset, from = 0, to = content.length) {
  if (
    !Number.isInteger(offset) ||
    offset <= from ||
    offset + 1 >= to ||
    content[offset - 1] !== '[' ||
    content[offset + 1] !== ']' ||
    !/[ xX]/.test(content[offset])
  )
    return null;
  return { from: offset, to: offset + 1, insert: content[offset] === ' ' ? 'x' : ' ' };
}
