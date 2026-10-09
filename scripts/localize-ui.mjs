// Apply only messages explicitly present in the UI dictionary. This never translates
// arbitrary document text, Markdown templates, identifiers, or regular expressions.
import fs from 'node:fs/promises';
import ts from 'typescript';

const dictionary = JSON.parse(
  await fs.readFile(new URL('../src/translations.en.json', import.meta.url), 'utf8'),
);
const files = process.argv.slice(2);
if (!files.length) throw Error('Pass explicit TSX UI file paths to localize.');
const quote = (text) => JSON.stringify(text);
const has = (text) => Object.prototype.hasOwnProperty.call(dictionary, text);
// React removes indentation around multiline JSX text, but retains spaces on one line.
function jsxText(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let last = 0;
  lines.forEach((line, i) => {
    if (/\S/.test(line)) last = i;
  });
  return lines
    .map((line, i) => {
      let value = line.replace(/\t/g, ' ');
      if (i !== 0) value = value.replace(/^ +/, '');
      if (i !== lines.length - 1) value = value.replace(/ +$/, '');
      return value && i !== last ? value + ' ' : value;
    })
    .join('');
}
for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 't') return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (has(node.text)) {
        let value = `t(${quote(node.text)})`;
        if (ts.isJsxAttribute(node.parent)) value = `{${value}}`;
        edits.push({ start: node.getStart(source), end: node.end, value });
        return;
      }
    } else if (ts.isTemplateExpression(node)) {
      let key = node.head.text;
      node.templateSpans.forEach((span, i) => {
        key += `{${i}}` + span.literal.text;
      });
      if (has(key)) {
        // Nested UI expressions are transformed on a later pass, preserving syntax.
        const vars = node.templateSpans
          .map((span, i) => `${quote(String(i))}: ${span.expression.getText(source)}`)
          .join(', ');
        edits.push({
          start: node.getStart(source),
          end: node.end,
          value: `t(${quote(key)}, {${vars}})`,
        });
        return;
      }
    } else if (ts.isJsxText(node)) {
      const value = jsxText(node.text),
        key = value.trim();
      if (has(key)) {
        const lead = value.startsWith(' ') ? "{' '}" : '';
        const tail = value.endsWith(' ') ? "{' '}" : '';
        edits.push({ start: node.pos, end: node.end, value: `${lead}{t(${quote(key)})}${tail}` });
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!edits.length) continue;
  let output = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"]\.\/i18n['"]/.test(output))
    output = "import { t } from './i18n';\n" + output;
  await fs.writeFile(file, output);
  console.log(`${file}: localized ${edits.length} UI messages`);
}
