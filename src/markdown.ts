import { t } from './i18n';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import tasks from 'markdown-it-task-lists';
import { full as emoji } from 'markdown-it-emoji';
import DOMPurify from 'dompurify';
import katex from 'katex';
import hljs from 'highlight.js';
import { imageURL } from './image-url.mjs';
import { annotateTaskMarkers } from './task-markers.mjs';
export { imageURL } from './image-url.mjs';
export interface RenderEnv {
  path?: string;
  remoteImages?: boolean;
  headings?: Heading[];
  lineOffset?: number;
}
export interface Heading {
  level: number;
  text: string;
  line: number;
  id: string;
}
export const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const parser = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
  highlight: (code, lang) => {
    if (lang === 'mermaid')
      return `<pre class="mermaid" data-source="${escapeHTML(code)}">${escapeHTML(code)}</pre>`;
    if (lang && hljs.getLanguage(lang))
      return `<pre class="code-preview" data-language="${escapeHTML(lang)}"><code class="hljs">${hljs.highlight(code, { language: lang }).value}</code></pre>`;
    return `<pre class="code-preview" data-language="${escapeHTML(lang || 'text')}"><code>${escapeHTML(code)}</code></pre>`;
  },
})
  .use(footnote)
  .use(mark)
  .use(sub)
  .use(sup)
  .use(tasks, { enabled: true, label: true })
  .use(emoji);
parser.core.ruler.after('github-task-lists', 'folio-task-markers', annotateTaskMarkers);
parser.renderer.rules.folio_task_checkbox = (tokens, i, _options, env) => {
  const id = crypto.randomUUID();
  env.taskMarkers.set(id, tokens[i].meta);
  return `<span data-folio-task="${id}"></span>`;
};
const spacing = (character: string | undefined) => !character || /\s/.test(character);
const unescapedDelimiter = (source: string, index: number) => {
  let precedingBackslashes = 0;
  for (let i = index - 1; source[i] === '\\'; i--) precedingBackslashes++;
  return precedingBackslashes % 2 === 0;
};
// The backslash is part of the LaTeX delimiter, so this rule must run before
// Markdown's ordinary escape rule consumes it. Code spans and fences are still
// handled by MarkdownIt before their contents reach this inline rule.
parser.inline.ruler.before('escape', 'math_latex_inline', (state, silent) => {
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
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.meta = { display: opening === '\\[' };
  }
  state.pos = end + 2;
  return true;
});
parser.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
  const start = state.pos;
  // `$` opens a formula only when it hugs its content, and the closing `$` may not
  // be followed by a digit. Without this, prose such as "It costs $5 and $10" is
  // read as one formula, which also tears apart any link or emphasis it spans.
  if (spacing(state.src[start + 1])) return false;
  let end = start + 1;
  for (;;) {
    end = state.src.indexOf('$', end);
    // Stay inside the current inline context: posMax is the end of a link label
    // or emphasis run, and a closing `$` beyond it belongs to other text.
    if (end === -1 || end >= state.posMax) return false;
    if (state.src[end - 1] !== '\\') break;
    end++;
  }
  if (end === start + 1 || spacing(state.src[end - 1])) return false;
  if (/[0-9]/.test(state.src[end + 1] || '')) return false;
  if (state.src.slice(start + 1, end).includes('\n')) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = state.src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
});
parser.renderer.rules.math_inline = (tokens, i) => {
  const display = tokens[i].meta?.display === true;
  return `<span class="${display ? 'formula-inline math-preview' : 'formula-inline'}" data-math-source="${escapeHTML(tokens[i].content)}" data-math-display="${display}">${escapeHTML(tokens[i].content)}</span>`;
};
parser.block.ruler.before(
  'fence',
  'math_block',
  (state, start, end, silent) => {
    const first = state.src
      .slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
      .trim();
    const bracket = first.startsWith('\\[');
    if (!first.startsWith('$$') && !bracket) return false;
    let last = start,
      content = '';
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
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.map = [start, last + 1];
    token.content = content;
    state.line = last + 1;
    return true;
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);
parser.renderer.rules.math_block = (tokens, i) =>
  `<div class="math-preview" data-math-source="${escapeHTML(tokens[i].content)}" data-math-display="true">${escapeHTML(tokens[i].content)}</div>`;
parser.block.ruler.before('hr', 'frontmatter', (state, start, end, silent) => {
  if (start !== 0 || state.src.slice(state.bMarks[0], state.eMarks[0]).trim() !== '---')
    return false;
  let last = 1;
  while (
    last < end &&
    !['---', '...'].includes(state.src.slice(state.bMarks[last], state.eMarks[last]).trim())
  )
    last++;
  if (last === end) return false;
  if (silent) return true;
  const token = state.push('frontmatter', 'pre', 0);
  token.block = true;
  token.map = [0, last + 1];
  token.content = state.getLines(1, last, 0, false);
  state.line = last + 1;
  return true;
});
parser.renderer.rules.frontmatter = (tokens, i) =>
  `<pre class="frontmatter"><span>${escapeHTML(t('文档属性'))}</span><code>${escapeHTML(tokens[i].content)}</code></pre>`;
parser.block.ruler.before('paragraph', 'toc', (state, start, _end, silent) => {
  if (!/^\[toc\]$/i.test(state.src.slice(state.bMarks[start], state.eMarks[start]).trim()))
    return false;
  if (silent) return true;
  const token = state.push('toc', 'nav', 0);
  token.map = [start, start + 1];
  token.block = true;
  state.line = start + 1;
  return true;
});
parser.renderer.rules.toc = (_tokens, _i, _opts, env: RenderEnv) =>
  // Depth travels as a class, not an inline style: DOMPurify strips `style` from
  // rendered Markdown, which flattened every entry to the same indent.
  `<nav class="toc-preview">${(env.headings || [])
    .map(
      (h) =>
        `<a class="toc-level-${Math.min(6, Math.max(1, h.level))}" href="#${h.id}">${escapeHTML(h.text)}</a>`,
    )
    .join('')}</nav>`;
parser.renderer.rules.image = (tokens, i, _options, env: RenderEnv) => {
  const token = tokens[i],
    src = token.attrGet('src') || '',
    url = imageURL(src, env),
    alt = token.content;
  return url
    ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(alt)}" loading="lazy" />`
    : `<span class="image-unloaded">${escapeHTML(t('图片：'))}${escapeHTML(alt || src)}${/^https?:/.test(src) ? t(' · 网络图片未启用') : ''}</span>`;
};
export function headings(content: string): Heading[] {
  const tokens = parser.parse(content, {}),
    seen = new Map<string, number>();
  return tokens.flatMap((token, i) => {
    if (token.type !== 'heading_open' || !token.map) return [];
    const text = tokens[i + 1].content,
      slug = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/\s+/g, '-'),
      count = seen.get(slug) || 0;
    seen.set(slug, count + 1);
    return [
      {
        level: Number(token.tag[1]),
        text,
        line: token.map[0] + 1,
        id: slug + (count ? '-' + count : ''),
      },
    ];
  });
}
export function renderMarkdown(content: string, env: RenderEnv = {}) {
  const context: any = {};
  const tokens = parser.parse(content, context);
  return renderTokens(tokens, { ...context, ...env, headings: env.headings || headings(content) });
}
export function renderTokens(tokens: any[], env: RenderEnv = {}) {
  const hs = env.headings || [];
  let index = 0;
  for (const token of tokens) {
    if (token.type === 'heading_open')
      token.attrSet(
        'id',
        (env.lineOffset !== undefined
          ? hs.find((h) => h.line === (token.map?.[0] || 0) + env.lineOffset! + 1)
          : hs[index++]
        )?.id || '',
      );
    if (token.type === 'th_open' || token.type === 'td_open') {
      const align = token.attrGet('style')?.match(/text-align:(left|center|right)/)?.[1];
      if (align) token.attrSet('align', align);
    }
  }
  const taskMarkers = new Map<string, { offset: number; checked: boolean }>();
  const html = parser.renderer.render(tokens, parser.options, {
    ...env,
    headings: hs,
    taskMarkers,
  });
  const safe = DOMPurify.sanitize(html, {
    ADD_URI_SAFE_ATTR: ['data-source'],
    ADD_TAGS: ['math', 'semantics', 'annotation'],
    ADD_ATTR: ['target'],
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'style',
      'input',
      'audio',
      'video',
      'source',
    ],
    FORBID_ATTR: ['srcdoc', 'srcset', 'style'],
    ALLOW_DATA_ATTR: true,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|folio-asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  }).replace(
    /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g,
    (_m, t) =>
      `<blockquote class="callout callout-${t.toLowerCase()}"><p><strong class="callout-label">${t}</strong>`,
  );
  const fragment = document.createElement('template');
  fragment.innerHTML = safe;
  fragment.content.querySelectorAll<HTMLElement>('[data-folio-task]').forEach((node) => {
    const marker = taskMarkers.get(node.dataset.folioTask || '');
    if (!marker) {
      node.removeAttribute('data-folio-task');
      return;
    }
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-list-item-checkbox';
    checkbox.setAttribute('aria-label', t('任务状态'));
    if (marker.checked) checkbox.setAttribute('checked', '');
    checkbox.dataset.taskOffset = String(marker.offset);
    node.replaceWith(checkbox);
  });
  fragment.content.querySelectorAll('img').forEach((img) => {
    const source = img.getAttribute('src') || '',
      url = source.startsWith('folio-asset:') ? source : imageURL(source, env);
    if (url) img.setAttribute('src', url);
    else {
      const placeholder = document.createElement('span');
      placeholder.className = 'image-unloaded';
      placeholder.textContent = t('图片：') + (img.alt || source) + t(' · 未加载');
      img.replaceWith(placeholder);
    }
  });
  return fragment.innerHTML;
}
export async function renderDiagrams(root: HTMLElement, exporting = false) {
  if (root.querySelector('[data-math-source]:not([data-math-ready])')) {
    const { typesetMath } = await import('./mathjax');
    await typesetMath(root);
  }
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.mermaid:not([data-processed])'));
  if (!nodes.length) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: !exporting && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral',
    fontFamily: 'system-ui',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });
  for (const node of nodes) {
    if (!node.isConnected && !exporting) continue;
    try {
      const { svg } = await mermaid.render(
        'diagram-' + crypto.randomUUID().replaceAll('-', ''),
        node.dataset.source || node.textContent || '',
      );
      if (node.isConnected || exporting) {
        node.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        node.dataset.processed = 'true';
      }
    } catch {
      node.dataset.processed = 'error';
      node.title = t('图表语法错误；点击编辑源码。');
    }
  }
}
