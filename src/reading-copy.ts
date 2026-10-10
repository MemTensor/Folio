import DOMPurify from 'dompurify';

const sources = new WeakMap<Element, () => { from: number; to: number; raw: string }>();
export function registerCopySource(
  node: Element,
  source: () => { from: number; to: number; raw: string },
) {
  sources.set(node, source);
}
const controls = 'button[data-folio-remote-enable],input,.table-edit-button,.image-unloaded small';
function meaningful(fragment: DocumentFragment) {
  return !!fragment.textContent || !!fragment.querySelector('img,svg path,svg text,math');
}
function fullySelected(range: Range, node: Element) {
  const whole = node.ownerDocument.createRange();
  whole.selectNodeContents(node);
  if (node.contains(range.startContainer)) {
    const before = whole.cloneRange();
    before.setEnd(range.startContainer, range.startOffset);
    if (meaningful(before.cloneContents())) return false;
  } else if (range.compareBoundaryPoints(Range.START_TO_START, whole) > 0) return false;
  if (node.contains(range.endContainer)) {
    const after = whole.cloneRange();
    after.setStart(range.endContainer, range.endOffset);
    if (meaningful(after.cloneContents())) return false;
  } else if (range.compareBoundaryPoints(Range.END_TO_END, whole) < 0) return false;
  return true;
}
function selectedFragment(range: Range, root: HTMLElement) {
  let fragment = range.cloneContents();
  let parent =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  while (parent && parent !== root && root.contains(parent)) {
    const wrapper = parent.cloneNode(false) as Element;
    wrapper.append(fragment);
    const next = root.ownerDocument.createDocumentFragment();
    next.append(wrapper);
    fragment = next;
    if (parent.hasAttribute('data-folio-copy-from') || parent.classList.contains('md-block')) break;
    parent = parent.parentElement;
  }
  fragment.querySelectorAll(controls).forEach((node) => node.remove());
  return fragment;
}
const wrap = (text: string, mark: string) => {
  const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return parts[2] ? parts[1] + mark + parts[2] + mark + parts[3] : text;
};
function markdownNode(node: Node, complete: Map<string, string>): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)
    return '';
  const el = node as HTMLElement;
  const key = el.dataset ? el.dataset.folioCopyFrom + ':' + el.dataset.folioCopyTo : '';
  if (complete.has(key)) return complete.get(key)!;
  const inner = () =>
    Array.from(node.childNodes)
      .map((child) => markdownNode(child, complete))
      .join('');
  const tag = el.tagName?.toLowerCase();
  if (el.hasAttribute?.('data-math-source')) {
    const source = el.getAttribute('data-math-source') || '';
    return el.getAttribute('data-math-display') === 'true'
      ? '\n\n$$\n' + source + '\n$$\n\n'
      : '$' + source + '$';
  }
  if (tag === 'pre') {
    const source =
      el.dataset.source ?? el.querySelector('code')?.textContent ?? el.textContent ?? '';
    const language = el.classList.contains('mermaid') ? 'mermaid' : el.dataset.language || '';
    const ticks = '`'.repeat(
      Math.max(3, ...(source.match(/`+/g) || []).map((run) => run.length + 1)),
    );
    return '\n\n' + ticks + language + '\n' + source.replace(/\n$/, '') + '\n' + ticks + '\n\n';
  }
  if (tag === 'strong' || tag === 'b') return wrap(inner(), '**');
  if (tag === 'em' || tag === 'i') return wrap(inner(), '*');
  if (tag === 's' || tag === 'del') return wrap(inner(), '~~');
  if (tag === 'mark') return wrap(inner(), '==');
  if (tag === 'code') {
    const text = el.textContent || '';
    const ticks = '`'.repeat(
      Math.max(1, ...(text.match(/`+/g) || []).map((run) => run.length + 1)),
    );
    return (
      ticks + (text.startsWith('`') ? ' ' : '') + text + (text.endsWith('`') ? ' ' : '') + ticks
    );
  }
  if (tag === 'a') return '[' + inner() + '](' + (el.getAttribute('href') || '') + ')';
  if (tag === 'img')
    return '![' + (el.getAttribute('alt') || '') + '](' + (el.getAttribute('src') || '') + ')';
  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n\n---\n\n';
  if (tag && /^h[1-6]$/.test(tag))
    return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + inner() + '\n\n';
  if (tag === 'blockquote')
    return (
      '\n\n' +
      inner()
        .trim()
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n') +
      '\n\n'
    );
  if (tag === 'ul' || tag === 'ol')
    return (
      '\n\n' +
      Array.from(el.children)
        .map(
          (li, i) =>
            (tag === 'ol' ? String(Number(el.getAttribute('start') || 1) + i) + '. ' : '- ') +
            markdownNode(li, complete).trim().replace(/\n/g, '\n  '),
        )
        .join('\n') +
      '\n\n'
    );
  if (tag === 'table') {
    const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.children).map((cell) =>
        markdownNode(cell, complete).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>'),
      ),
    );
    if (!rows.length) return '';
    return (
      '\n\n' +
      [rows[0], rows[0].map(() => '---'), ...rows.slice(1)]
        .map((row) => '| ' + row.join(' | ') + ' |')
        .join('\n') +
      '\n\n'
    );
  }
  if (tag === 'p' || tag === 'div') return inner() + '\n\n';
  return inner();
}

export interface CopySelection {
  text: string;
  html: string;
  markdown: string;
}
export function copySelection(
  root: HTMLElement,
  content: string,
  selection = root.ownerDocument.getSelection(),
): CopySelection | null {
  content = sources.get(root)?.().raw ?? content;
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const complete = new Map<string, string>();
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('[data-folio-copy-from],.md-block'),
  ).filter((node) => range.intersectsNode(node));
  const spans = blocks
    .map((node) => {
      const provider = sources.get(node);
      const source = provider?.() || {
        from: Number(node.dataset.folioCopyFrom),
        to: Number(node.dataset.folioCopyTo),
        raw: '',
      };
      if (
        !Number.isInteger(source.from) ||
        !Number.isInteger(source.to) ||
        source.from < 0 ||
        source.to > content.length ||
        source.from >= source.to
      )
        return null;
      const raw = content.slice(source.from, source.to);
      if (provider && raw !== source.raw) return null;
      const full = fullySelected(range, node);
      if (full) complete.set(source.from + ':' + source.to, raw);
      return { ...source, full };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const fragment = selectedFragment(range, root);
  let markdown = markdownNode(fragment, complete).replace(/^\n+|\n+$/g, '');
  if (fullySelected(range, root)) markdown = content;
  else if (spans.length && spans.every((span) => span.full))
    markdown = content.slice(spans[0].from, spans.at(-1)!.to);
  const holder = root.ownerDocument.createElement('div');
  holder.append(fragment);
  holder.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes])
      if (
        attribute.name.startsWith('data-') ||
        ['contenteditable', 'tabindex', 'style'].includes(attribute.name) ||
        (attribute.name === 'id' && node.namespaceURI !== 'http://www.w3.org/2000/svg')
      )
        node.removeAttribute(attribute.name);
  });
  const html = DOMPurify.sanitize(holder.innerHTML, {
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'style',
      'button',
      'input',
      'audio',
      'video',
    ],
    FORBID_ATTR: ['style', 'srcset'],
  });
  const rich = root.ownerDocument.createElement('div');
  rich.innerHTML = html;
  rich
    .querySelectorAll('table')
    .forEach((node) => node.setAttribute('style', 'border-collapse:collapse'));
  rich
    .querySelectorAll('td,th')
    .forEach((node) => node.setAttribute('style', 'border:1px solid #cccccc;padding:6px 10px'));
  const text = selection.toString() || markdown;
  return { text, html: rich.innerHTML, markdown };
}
export function clipboardPayload(selected: CopySelection, format: 'source' | 'rich') {
  const content =
    format === 'source'
      ? { text: selected.markdown }
      : { text: selected.text, html: selected.html };
  if (
    new TextEncoder().encode(content.text + ('html' in content ? content.html : '')).length >
    4 * 1024 * 1024
  )
    throw Error('复制内容无效或过长。');
  return content;
}
