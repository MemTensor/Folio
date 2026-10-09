import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { formulaSVG } from '../core/math.mjs';

// Exercise the actual browser parser without a DOM; parser.render emits the
// same data-math-source nodes consumed by preview and HTML/PDF export.
const bundled = (
  await build({
    entryPoints: ['src/markdown.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['./mathjax'],
  })
).outputFiles[0].text;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundled)(
  createRequire(import.meta.url),
  loaded,
  loaded.exports,
);
const { parser } = loaded.exports;

test('CJK bold tolerates punctuation adjacency and a trailing space without changing source', () => {
  for (const source of [
    '**问题一：训练数据扩展性不足。 **随着训练推进。',
    '**问题一：训练数据扩展性不足。**随着训练推进。',
    '中文**“强调”**接正文',
    '**中文重点 **接正文',
    '**85% 降至 3%**，结论保持不变。',
  ]) {
    const tokens = parser.parse(source, {});
    assert.equal(tokens.find((token) => token.type === 'inline').content, source);
    assert.match(parser.render(source), /<strong>/);
    assert.doesNotMatch(parser.render(source), /\*\*/);
  }
});

test('CJK compatibility keeps nested formatting, code, escapes, formulas and unmatched markers', () => {
  assert.match(parser.render('**中文 *重点*。**接正文'), /<strong>中文 <em>重点<\/em>。<\/strong>/);
  assert.match(parser.render('`**中文。 **`'), /<code>\*\*中文。 \*\*<\/code>/);
  assert.match(parser.render('```text\n**中文。 **\n```'), /\*\*中文。 \*\*/);
  assert.doesNotMatch(parser.render(String.raw`\*\*中文。 \*\*`), /<strong>/);
  assert.doesNotMatch(parser.render('**中文未结束'), /<strong>/);
  assert.doesNotMatch(parser.render('**English ** prose'), /<strong>/);
  assert.match(
    parser.render('__standard bold__ and *italic*'),
    /<strong>standard bold<\/strong> and <em>italic<\/em>/,
  );
  assert.match(parser.render(String.raw`$x^{**2}$`), /data-math-source="x\^\{\*\*2\}"/);
});
const math = (source) =>
  parser.parse(source, {}).flatMap((token) =>
    token.type === 'math_block'
      ? [{ type: token.type, content: token.content, display: true }]
      : (token.children || [])
          .filter((child) => child.type === 'math_inline')
          .map((child) => ({
            type: child.type,
            content: child.content,
            display: child.meta?.display === true,
          })),
  );

test('LaTeX inline delimiters produce the same math source used for SVG export', async () => {
  const source = String.raw`A formula: \(E=mc^2\), then \(\frac{1}{2}\), with error \(\eta\).`;
  assert.deepEqual(math(source), [
    { type: 'math_inline', content: 'E=mc^2', display: false },
    { type: 'math_inline', content: String.raw`\frac{1}{2}`, display: false },
    { type: 'math_inline', content: String.raw`\eta`, display: false },
  ]);
  const html = parser.render(source);
  assert.match(html, /data-math-source="E=mc\^2" data-math-display="false"/);
  assert.match(html, /data-math-source="\\frac\{1\}\{2\}" data-math-display="false"/);
  const svg = await formulaSVG(math(source)[1].content, false);
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /<merror|data-mjx-error/);
  assert.match(await formulaSVG(math(source)[2].content, false), /^<svg/);
});

test('display delimiters work on one line, across lines, and in inline context', async () => {
  const source =
    String.raw`\[x^2+y^2=z^2\]` +
    '\n\n' +
    String.raw`\[` +
    '\n' +
    String.raw`\begin{aligned}a&=b+c\\&=d\end{aligned}` +
    '\n' +
    String.raw`\]` +
    '\n\n' +
    String.raw`In prose \[a+b\] follows.`;
  const found = math(source);
  assert.deepEqual(
    found.map(({ type, display }) => [type, display]),
    [
      ['math_block', true],
      ['math_block', true],
      ['math_inline', true],
    ],
  );
  assert.equal(found[0].content, 'x^2+y^2=z^2');
  assert.equal(found[1].content.trim(), String.raw`\begin{aligned}a&=b+c\\&=d\end{aligned}`);
  assert.equal(found[2].content, 'a+b');
  const html = parser.render(source);
  assert.equal((html.match(/data-math-display="true"/g) || []).length, 3);
  assert.match(html, /<div class="math-preview" data-math-source="x\^2\+y\^2=z\^2"/);
  assert.match(html, /<span class="formula-inline math-preview" data-math-source="a\+b"/);
  for (const token of found) assert.match(await formulaSVG(token.content, token.display), /^<svg/);
});

test('display closing delimiter can follow the final TeX line', () => {
  const source = String.raw`\[x^2+` + '\n' + String.raw`y^2=z^2\]`;
  assert.deepEqual(math(source), [{ type: 'math_block', content: 'x^2+\ny^2=z^2', display: true }]);
  const tokens = parser.parse(source, {});
  assert.deepEqual(tokens.find((token) => token.type === 'math_block').map, [0, 2]);
});

test('the optimizer inequality shown with bracket delimiters typesets as SVG', async () => {
  const source = String.raw`\[
|F_P(A)-F_Q(A)|
\le
\sum_i w_i\,TV(P_i,Q_i)
\]`;
  const found = math(source);
  assert.equal(found.length, 1);
  assert.equal(found[0].type, 'math_block');
  assert.match(found[0].content, /\\le\s+\\sum_i/);
  const svg = await formulaSVG(found[0].content, true);
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /<merror|data-mjx-error/);
  assert.doesNotMatch(parser.render(source), /\\\[|\\\]/);
});

test('display delimiters remain formulas in list items and blockquotes', () => {
  const source =
    '- ' +
    String.raw`\[a=b\]` +
    '\n\n> ' +
    String.raw`\[` +
    '\n> ' +
    String.raw`c=d` +
    '\n> ' +
    String.raw`\]`;
  assert.deepEqual(
    math(source).map((item) => item.content.trim()),
    ['a=b', 'c=d'],
  );
});

test('escaped, unmatched, code, and currency delimiters stay prose', () => {
  const source =
    String.raw`Escaped \\(x\\) and \\[y\\]; costs $5 and $10.` +
    '\n\n' +
    String.raw`Unmatched \(x and \[y.` +
    '\n\n' +
    String.raw`Code: ` +
    '`\\(z\\)`' +
    '\n\n```tex\n' +
    String.raw`\(a\) \[b\]` +
    '\n```\n';
  assert.deepEqual(math(source), []);
  assert.doesNotMatch(parser.render(source), /data-math-source/);
  const escapedCloser = String.raw`\(x\\) + y\)`;
  assert.deepEqual(math(escapedCloser), [
    { type: 'math_inline', content: String.raw`x\\) + y`, display: false },
  ]);
  assert.deepEqual(math(String.raw`\(a ` + '`code \\)`' + String.raw` b\)`), []);
  assert.deepEqual(
    math(String.raw`$x$ and $$y$$`).map((item) => item.content),
    ['x', 'y'],
  );
});
