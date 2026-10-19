export function parseTable(raw, headers = ['项目', '说明']) {
  const rows = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        // `<br>` is how serializeTable writes a line break, so reading one back as
        // a newline is what makes the round trip lossless.
        .map((c) =>
          c
            .trim()
            .replace(/\\\|/g, '|')
            .replace(/<br\s*\/?>/gi, '\n'),
        ),
    );
  if (rows.length < 2)
    return {
      cells: [headers.slice(), ['', ''], ['', '']],
      align: ['default', 'default'],
    };
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => r[i] || '');
  return {
    cells: [pad(rows[0]), ...rows.slice(2).map(pad)],
    // A bare `---` is "no explicit alignment", which renders the same as left but
    // is a different piece of text. Keeping them apart stops every visit to the
    // table editor from rewriting `---` into `:---` and producing an empty diff.
    align: pad(rows[1]).map((c) =>
      c.startsWith(':')
        ? c.endsWith(':')
          ? 'center'
          : 'left'
        : c.endsWith(':')
          ? 'right'
          : 'default',
    ),
  };
}
const marker = (a) =>
  a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
export function serializeTable(cells, align) {
  const row = (r) =>
    '| ' + r.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |';
  return [row(cells[0]), row(align.map(marker)), ...cells.slice(1).map(row)].join('\n');
}
export function pasteCells(cells, row, column, text) {
  const paste = text
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((r) => r.split('\t'));
  const width = Math.max(cells[0].length, column + Math.max(...paste.map((r) => r.length))),
    height = Math.max(cells.length, row + paste.length);
  const next = Array.from({ length: height }, (_, i) =>
    Array.from({ length: width }, (_, j) => cells[i]?.[j] || ''),
  );
  paste.forEach((r, i) => r.forEach((value, j) => (next[row + i][column + j] = value)));
  return next;
}
