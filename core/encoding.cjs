const { diffArrays } = require('diff');
const split = (s) => s.match(/[^\n]*\n|[^\n]+$/g) || [];
const DIFF_BUDGET = { timeout: 40, maxEditLength: 1024 };
/** Keep unchanged line bytes. Never guess which mixed-EOL lines survived a large edit. */
function encodeText(text, { raw = '', eol = 'LF', bom = false, diffBudget = DIFF_BUDGET } = {}) {
  text = text.replace(/\r\n/g, '\n');
  const prefix = bom ? '\uFEFF' : '',
    original = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const normalized = original.replace(/\r\n/g, '\n');
  if (normalized === text) return prefix + original;
  if (!original.includes('\r\n') && eol === 'LF') return prefix + text;
  if (!normalized.includes('\n') || (!/(?<!\r)\n/.test(original) && eol === 'CRLF'))
    return prefix + (eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : text);
  const before = split(original);
  const parts = diffArrays(
    before.map((line) => line.replace(/\r\n$/, '\n')),
    split(text),
    diffBudget,
  );
  if (!parts)
    throw Object.assign(
      new Error(
        '修改范围较大，无法及时保留混合换行格式。内容尚未写入；请分段保存，或将文件统一为 LF / CRLF 后重试。',
      ),
      { code: 'ENCODING_BUDGET' },
    );
  let cursor = 0,
    result = prefix;
  for (const part of parts) {
    if (part.removed) {
      cursor += part.count;
      continue;
    }
    if (part.added) {
      result += part.value
        .map((line) => (eol === 'CRLF' ? line.replace(/\n$/, '\r\n') : line))
        .join('');
      continue;
    }
    result += before.slice(cursor, cursor + part.count).join('');
    cursor += part.count;
  }
  return result;
}
function preferredEOL(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf || (crlf === lf && raw.indexOf('\r\n') === raw.indexOf('\n') - 1)
    ? 'CRLF'
    : 'LF';
}
module.exports = { encodeText, preferredEOL, DIFF_BUDGET };
