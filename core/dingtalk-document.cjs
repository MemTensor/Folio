const fs = require('node:fs/promises'),
  path = require('node:path');
const MarkdownIt = require('markdown-it');
const { imageSize } = require('image-size');
const { svgPng } = require('./svg-png.cjs');
const { digest } = require('./state.cjs');
const { DingTalkError } = require('./dingtalk-cli.cjs');

const md = new MarkdownIt({ html: true, linkify: true });
const fenceLanguage = (info) =>
  md.utils
    .unescapeAll(String(info || ''))
    .trim()
    .split(/\s+/)[0];
const mathSpacing = (character) => !character || /\s/.test(character);
const unescapedDelimiter = (source, index) => {
  let precedingBackslashes = 0;
  for (let i = index - 1; source[i] === '\\'; i--) precedingBackslashes++;
  return precedingBackslashes % 2 === 0;
};
// Keep these delimiter rules identical to src/markdown.ts: what the editor shows
// as prose must not be published to DingTalk as a rasterised formula.
md.inline.ruler.before('escape', 'folio_latex_math', (state, silent) => {
  const opening = state.src.slice(state.pos, state.pos + 2);
  if (opening !== '\\(' && opening !== '\\[') return false;
  const closing = opening === '\\(' ? '\\)' : '\\]';
  let end = state.pos + 2;
  for (;;) {
    end = state.src.indexOf(closing, end);
    if (end === -1 || end + 2 > state.posMax) return false;
    if (unescapedDelimiter(state.src, end)) break;
    end++;
  }
  const content = state.src.slice(state.pos + 2, end);
  if (!content.trim() || content.includes('\n') || content.includes('`')) return false;
  if (!silent) {
    const t = state.push('math_inline', '', 0);
    t.content = content;
    t.meta = { display: opening === '\\[' };
  }
  state.pos = end + 2;
  return true;
});
md.inline.ruler.after('escape', 'folio_math', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
  if (mathSpacing(state.src[state.pos + 1])) return false;
  let end = state.pos + 1;
  for (;;) {
    end = state.src.indexOf('$', end);
    if (end === -1 || end >= state.posMax) return false;
    if (state.src[end - 1] !== '\\') break;
    end++;
  }
  if (end === state.pos + 1 || mathSpacing(state.src[end - 1])) return false;
  if (/[0-9]/.test(state.src[end + 1] || '')) return false;
  if (state.src.slice(state.pos + 1, end).includes('\n')) return false;
  if (!silent) {
    const t = state.push('math_inline', '', 0);
    t.content = state.src.slice(state.pos + 1, end);
  }
  state.pos = end + 1;
  return true;
});
md.block.ruler.before(
  'fence',
  'folio_math_block',
  (state, start, end, silent) => {
    const first = state.src
      .slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
      .trim();
    const bracket = first.startsWith('\\[');
    if (!first.startsWith('$$') && !bracket) return false;
    let last = start,
      content;
    if (bracket) {
      if (first.length > 4 && first.endsWith('\\]') && unescapedDelimiter(first, first.length - 2))
        content = first.slice(2, -2);
      else if (!first.includes('\\]')) {
        last = start + 1;
        let closingPrefix = '';
        while (last < end) {
          const line = state.src.slice(state.bMarks[last], state.eMarks[last]);
          const trimmed = line.trimEnd();
          const closingStart = trimmed.length - 2;
          if (trimmed.endsWith('\\]') && unescapedDelimiter(trimmed, closingStart)) {
            closingPrefix = line.slice(0, closingStart);
            break;
          }
          last++;
        }
        if (last === end) return false;
        const middle = state.getLines(start + 1, last, 0, false);
        const openingContent = first.slice(2);
        content = openingContent + (openingContent ? '\n' : '') + middle + closingPrefix;
      } else return false;
    } else if (first.length > 4 && first.endsWith('$$')) content = first.slice(2, -2);
    else {
      last = start + 1;
      while (last < end && state.src.slice(state.bMarks[last], state.eMarks[last]).trim() !== '$$')
        last++;
      if (last === end) return false;
      content = state.getLines(start + 1, last, 0, false);
    }
    if (bracket && !content.trim()) return false;
    if (silent) return true;
    const t = state.push('math_block', '', 0);
    t.block = true;
    t.content = content;
    state.line = last + 1;
    return true;
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);
const leaf = (text, marks = {}) => ['span', { 'data-type': 'leaf', ...marks }, text];
const text = (value, marks = {}) => ['span', { 'data-type': 'text' }, leaf(value, marks)];
const types = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
function imageDimensions(bytes) {
  let size;
  try {
    size = imageSize(bytes);
  } catch {
    throw new DingTalkError('无法读取图片尺寸，请检查图片文件。', 'DWS_CONTENT');
  }
  if (!size.width || !size.height) throw new DingTalkError('图片尺寸无效。', 'DWS_CONTENT');
  const scale = Math.min(1, 640 / size.width);
  return { width: size.width * scale, height: size.height * scale };
}
async function renderedFormula(source, display) {
  const { formulaSVG } = await import('./math.mjs');
  // MathJax 4 splits inline output into multiple SVGs around break points.
  // An image needs one SVG root; textstyle preserves inline operator sizing.
  const svg = await formulaSVG(display ? source : '{\\textstyle ' + source + '}', true);
  const size = (key, fallback) => {
    const m = svg.match(new RegExp('\\b' + key + '="([\\d.]+)(ex|em|px)?"'));
    return m ? Number(m[1]) * (m[2] === 'ex' ? 8 : m[2] === 'em' ? 16 : 1) : fallback;
  };
  const width = size('width', 200),
    height = size('height', 32);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new DingTalkError('公式尺寸无效，请检查 LaTeX。', 'DWS_CONTENT');
  const scaled = Math.min(1, 640 / width),
    normalized = svg.replace(
      /\b(width|height)="([\d.]+)(ex|em)"/g,
      (_m, key, n, unit) => `${key}="${Number(n) * (unit === 'ex' ? 8 : 16)}"`,
    );
  const png = await svgPng(normalized, width * scaled * 2);
  return {
    src: 'data:image/png;base64,' + png.toString('base64'),
    width: width * scaled,
    height: height * scaled,
  };
}
async function documentProjection(file, store, { diagrams = [] } = {}) {
  if (!Array.isArray(diagrams))
    throw new DingTalkError('图表数据无效，请重新生成预览。', 'DWS_CONTENT');
  const assets = [],
    warnings = [],
    stats = { formulas: 0, tables: 0, images: 0, diagrams: 0 };
  let sequence = 0,
    diagramIndex = 0,
    total = 0;
  const node = (tag, attrs = {}, ...children) => [
    tag,
    { uuid: 'folio-' + digest(file.path + ':' + sequence++).slice(0, 24), ...attrs },
    ...children,
  ];
  const paragraph = (children, attrs = {}) => node('p', attrs, ...children);
  const formula = async (source, display) => {
    stats.formulas++;
    const attributes = await renderedFormula(source, display);
    total += Buffer.byteLength(attributes.src);
    return node('img', attributes);
  };
  const image = async (src, alt = '') => {
    let url = src,
      dimensions = {};
    stats.images++;
    if (/^https?:\/\//i.test(src)) {
      warnings.push('网络图片沿用原链接，访问权限由图片来源决定。');
    } else if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(src)) {
      total += Buffer.byteLength(src);
      dimensions = imageDimensions(Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'));
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(src))
        throw new DingTalkError('图片地址不受支持：' + alt, 'DWS_CONTENT');
      const target = await store.safe(
          path.resolve(path.dirname(file.path), decodeURIComponent(src.split('#')[0])),
        ),
        mime = types[path.extname(target).toLowerCase()];
      if (!mime)
        throw new DingTalkError('请先将图片转换为 PNG、JPEG、GIF、WebP 或 SVG。', 'DWS_CONTENT');
      const stat = await fs.stat(target);
      if (stat.size > 5 * 1024 * 1024)
        throw new DingTalkError('单张图片超过 5 MB，请压缩后再发布。', 'DWS_CONTENT');
      const bytes = await fs.readFile(target);
      assets.push({ path: target, hash: digest(bytes) });
      total += bytes.length;
      dimensions = imageDimensions(bytes);
      url = `data:${mime};base64,${bytes.toString('base64')}`;
    }
    return node('img', { src: url, ...dimensions });
  };
  async function inline(tokens) {
    const children = [],
      marks = {};
    let leaves = [];
    const flush = () => {
      if (leaves.length) {
        children.push(['span', { 'data-type': 'text' }, ...leaves]);
        leaves = [];
      }
    };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'strong_open') marks.bold = true;
      else if (t.type === 'strong_close') delete marks.bold;
      else if (t.type === 'em_open') marks.italic = true;
      else if (t.type === 'em_close') delete marks.italic;
      else if (t.type === 's_open') marks.strike = true;
      else if (t.type === 's_close') delete marks.strike;
      else if (t.type === 'math_inline') {
        flush();
        children.push(await formula(t.content, t.meta?.display === true));
      } else if (t.type === 'image') {
        flush();
        children.push(await image(t.attrGet('src') || '', t.content));
      } else if (t.type === 'link_open') {
        flush();
        const href = t.attrGet('href') || '';
        let label = '';
        while (++i < tokens.length && tokens[i].type !== 'link_close')
          label += tokens[i].content || '';
        if (/^(https?:|mailto:|#)/i.test(href)) children.push(node('a', { href }, label));
        else {
          children.push(text(label + '（' + href + '）'));
          warnings.push('本地文档链接以路径文字保留。');
        }
      } else if (t.type === 'softbreak' || t.type === 'hardbreak') leaves.push(leaf('\n', marks));
      else if (t.type === 'html_inline') {
        const match = t.content.match(/<img\b[^>]*src=["']([^"']+)["']/i);
        if (match) {
          flush();
          children.push(await image(match[1]));
        } else if (/<br\s*\/?\s*>/i.test(t.content)) leaves.push(leaf('\n'));
      } else if (t.type === 'code_inline')
        leaves.push(
          leaf(t.content, { ...marks, fonts: { ascii: 'Courier New', eastAsia: 'DengXian' } }),
        );
      else if (t.content) leaves.push(leaf(t.content, marks));
    }
    flush();
    if (!children.some((n) => n[0] === 'span')) children.push(text(''));
    return children;
  }
  const tokens = md.parse(file.content, {}),
    root = ['root', {}],
    stack = [root],
    lists = [];
  let quote = 0;
  const add = (value) => stack.at(-1).push(value);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open' || t.type === 'paragraph_open') {
      const next = tokens[i + 1],
        attrs = {};
      if (quote) attrs.quote = true;
      if (lists.length) attrs.list = { ...lists.at(-1), level: lists.length - 1 };
      const contents = next?.type === 'inline' ? await inline(next.children || []) : [text('')];
      add(node(t.type === 'heading_open' ? t.tag : 'p', attrs, ...contents));
      if (next?.type === 'inline') i++;
    } else if (t.type === 'math_block') {
      add(paragraph([await formula(t.content.trim(), true), text('')], { jc: 'center' }));
    } else if (t.type === 'fence' || t.type === 'code_block') {
      if (fenceLanguage(t.info) === 'mermaid') {
        const diagram = diagrams[diagramIndex++];
        if (
          !diagram ||
          typeof diagram !== 'object' ||
          typeof diagram.png !== 'string' ||
          !/^data:image\/png;base64,/.test(diagram.png)
        )
          throw new DingTalkError(
            '此文档包含 Mermaid 图表，请从 Folio 桌面应用发布以生成图像。',
            'DWS_RENDER_REQUIRED',
          );
        if (diagram.source !== t.content)
          throw new DingTalkError('图表图片与当前源码不一致，请重新生成预览。', 'CONFLICT');
        stats.diagrams++;
        add(paragraph([await image(diagram.png), text('')]));
      } else add(node('code', { syntax: t.info.trim().split(/\s/)[0] || 'text', code: t.content }));
    } else if (t.type === 'table_open') {
      stats.tables++;
      const n = node('table');
      add(n);
      stack.push(n);
    } else if (t.type === 'tr_open') {
      const n = node('tr');
      add(n);
      stack.push(n);
    } else if (t.type === 'td_open' || t.type === 'th_open') {
      const n = node('tc', {
        colSpan: 1,
        rowSpan: 1,
        ...(t.type === 'th_open' ? { fill: '#F5F5F5' } : {}),
      });
      add(n);
      stack.push(n);
      const next = tokens[i + 1];
      if (next?.type === 'inline') {
        const align = t.attrGet('style')?.match(/text-align:(\w+)/)?.[1];
        n.push(paragraph(await inline(next.children || []), align ? { jc: align } : {}));
        i++;
      } else n.push(paragraph([text('')]));
    } else if (t.type === 'table_close') {
      const table = stack.pop(),
        rows = table.slice(2).filter((n) => n[0] === 'tr'),
        columns = Math.max(
          1,
          ...rows.map((row) => row.slice(2).filter((n) => n[0] === 'tc').length),
        );
      table[1].colsWidth = Array(columns).fill(600 / columns);
    } else if (['tr_close', 'td_close', 'th_close'].includes(t.type)) stack.pop();
    else if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open')
      lists.push({
        listId: 'folio-list-' + sequence++,
        isOrdered: t.type === 'ordered_list_open',
        ...(t.attrGet('start') ? { start: Number(t.attrGet('start')) } : {}),
      });
    else if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') lists.pop();
    else if (t.type === 'blockquote_open') quote++;
    else if (t.type === 'blockquote_close') quote--;
    else if (t.type === 'hr') add(node('hr'));
    else if (t.type === 'html_block') {
      const images = [...t.content.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)];
      for (const m of images) add(paragraph([await image(m[1]), text('')]));
      const words = md.utils.unescapeAll(t.content.replace(/<[^>]*>/g, '')).trim();
      if (words) add(paragraph([text(words)]));
      warnings.push('HTML 布局转换为钉钉段落格式。');
    }
  }
  if (diagramIndex !== diagrams.length)
    throw new DingTalkError('图表数量与当前文档不一致，请重新生成预览。', 'CONFLICT');
  if (root.length === 2) root.push(paragraph([text('')]));
  const encoded = JSON.stringify(root);
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024 || total > 6 * 1024 * 1024)
    throw new DingTalkError('文档和图片合计过大，请压缩图片或拆分文档后再发布。', 'DWS_CONTENT');
  return {
    jsonml: root,
    content: encoded,
    assets,
    stats,
    warnings: [...new Set(warnings)],
    packageHash: digest(encoded),
  };
}
// The service adds layout defaults and generated inline UUIDs. Every supplied
// attribute and child is still checked; extra content is never accepted.
function matchesProjection(expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((v, i) => matchesProjection(v, actual[i]));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => matchesProjection(v, actual[k]));
  }
  return expected === actual;
}
module.exports = { documentProjection, matchesProjection, renderedFormula, imageDimensions };
