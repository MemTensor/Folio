const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const normalize = (s) => s.replace(/\s+/g, '');
// Folio reads both dollar math and the LaTeX single-backslash delimiters.
// Pandoc must recognize the same source before its editable Word math and SVG
// fallback can work.
const markdownFormat = 'markdown+tex_math_dollars+tex_math_single_backslash';
function imageSVG(svg) {
  return svg
    .replace(/(<svg\b[^>]*\bwidth=")100%("[^>]*>)/, (_m, a, b) => a + '640' + b)
    .replace(/\b(width|height)="([\d.]+)ex"/g, (_m, key, n) => `${key}="${Number(n) * 8}"`);
}
async function exportDocx({
  binary,
  content,
  resourceDir,
  target,
  tempDir,
  maths = [],
  diagrams = [],
}) {
  let diagramIndex = 0;
  content = content.replace(/^```mermaid[^\n]*\n[\s\S]*?^```\s*$/gm, () => {
    const i = diagramIndex++;
    if (typeof diagrams[i] !== 'string' || diagrams[i].length > 8 * 1024 * 1024)
      throw Error('图表导出数据不完整。');
    return `![图表 ${i + 1}](${path.join(tempDir, 'diagram-' + i + '.svg')})`;
  });
  for (let i = 0; i < diagramIndex; i++)
    await fs.writeFile(path.join(tempDir, 'diagram-' + i + '.svg'), imageSVG(diagrams[i]), 'utf8');
  const input = path.join(tempDir, 'document.md'),
    first = path.join(tempDir, 'first.docx');
  await fs.writeFile(input, content, 'utf8');
  const options = { timeout: 60000, maxBuffer: 64 * 1024 * 1024 };
  const { stderr } = await run(
    binary,
    [
      input,
      '--from',
      markdownFormat,
      '--to',
      'docx',
      '--resource-path',
      resourceDir,
      '--output',
      first,
    ],
    options,
  );
  const unsupported = new Set(
    [...stderr.matchAll(/Could not convert TeX math ([\s\S]*?), rendering as TeX:/g)].map((m) =>
      normalize(m[1]),
    ),
  );
  if (!unsupported.size) {
    await fs.copyFile(first, target);
    return { fallbackCount: 0, warnings: stderr.trim() };
  }
  const { stdout } = await run(binary, [input, '--from', markdownFormat, '--to', 'json'], options);
  const ast = JSON.parse(stdout);
  let fallbackCount = 0;
  const replacements = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.t === 'Math' && unsupported.has(normalize(node.c[1]))) {
      const rendered = maths.find((m) => normalize(m.source) === normalize(node.c[1]));
      if (!rendered || typeof rendered.svg !== 'string' || rendered.svg.length > 8 * 1024 * 1024)
        throw Error('Word 无法转换这条公式，且矢量预览缺失。请使用 PDF 导出。');
      const filename = path.join(tempDir, `formula-${fallbackCount++}.svg`);
      replacements.push([filename, imageSVG(rendered.svg)]);
      return {
        t: 'Image',
        c: [['', ['folio-formula'], []], [{ t: 'Str', c: node.c[1] }], [filename, '数学公式']],
      };
    }
    if (Array.isArray(node)) return node.map(visit);
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
  };
  const converted = visit(ast);
  for (const [filename, svg] of replacements) await fs.writeFile(filename, svg, 'utf8');
  const json = path.join(tempDir, 'document.json');
  await fs.writeFile(json, JSON.stringify(converted), 'utf8');
  const second = await run(
    binary,
    [json, '--from', 'json', '--to', 'docx', '--resource-path', resourceDir, '--output', target],
    options,
  );
  return { fallbackCount, warnings: second.stderr.trim() };
}
module.exports = { exportDocx, imageSVG };
