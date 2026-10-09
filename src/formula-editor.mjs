/** Preserve the block delimiter a document already uses when editing its TeX. */
function delimiters(raw) {
  return raw.trimStart().startsWith('\\[') ? ['\\[', '\\]'] : ['$$', '$$'];
}

export function formulaEditorBody(raw) {
  const text = raw.trim();
  const [open, close] = delimiters(text);
  if (!text.startsWith(open) || !text.endsWith(close)) return text;
  return text.slice(open.length, -close.length).trim();
}

export function formulaEditorMarkdown(raw, source) {
  const [open, close] = delimiters(raw);
  return open + '\n' + source + '\n' + close;
}
