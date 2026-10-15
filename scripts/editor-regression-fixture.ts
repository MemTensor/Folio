import { parser, renderMarkdown, imageURL } from '../src/markdown';
import { copySelection, clipboardPayload } from '../src/reading-copy';
import { liveExtension } from '../src/editor';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import DOMPurify from 'dompurify';
const result: any = {};
const uri = 'folio-asset://local/?path=%2Fgenerated%2Fother-project%2Fpic.png';
const rawImage = renderMarkdown(`<img src="${uri}">`, { path: '/generated/current/Doc.md' });
result.asset = {
  rawHtmlPreserved: /<img[^>]*src="folio-asset:/i.test(rawImage),
  directImageURL: imageURL(uri, { path: '/generated/current/Doc.md' }),
  absoluteMarkdownURL: imageURL('/generated/other-project/pic.png', {
    path: '/generated/current/Doc.md',
  }),
};
const source = 'prefix ![Plot](assets/plot.png) suffix';
const root = document.createElement('div');
root.innerHTML = renderMarkdown(source, { path: '/generated/current/Doc.md', copySource: source });
document.body.append(root);
const image = root.querySelector('img')!,
  selection = window.getSelection()!,
  range = document.createRange();
range.selectNode(image);
selection.removeAllRanges();
selection.addRange(range);
const copied = copySelection(root, source)!;
result.copyImageOnly = { markdown: copied.markdown, rich: clipboardPayload(copied, 'rich') };
const p = root.querySelector('p')!;
range.selectNodeContents(p);
selection.removeAllRanges();
selection.addRange(range);
const whole = copySelection(root, source)!;
result.copyWholeParagraph = { markdown: whole.markdown, rich: clipboardPayload(whole, 'rich') };
root.remove();
selection.removeAllRanges();
let parses = 0,
  sanitizes = 0;
const originalParse = parser.parse.bind(parser),
  originalSanitize = DOMPurify.sanitize.bind(DOMPurify);
parser.parse = (...args: any[]) => {
  parses++;
  return originalParse(...args);
};
DOMPurify.sanitize = (...args: any[]) => {
  sanitizes++;
  return originalSanitize(...args);
};
result.selectionPerformance = [];
for (const count of [100, 500, 1000]) {
  const text = Array.from(
    { length: count },
    (_, i) => `Paragraph ${i}: generated **bold** content.`,
  ).join('\n\n');
  let state = EditorState.create({
    doc: text,
    extensions: [
      liveExtension(
        { path: '/generated/Doc.md' },
        () => {},
        () => {},
        false,
      ),
    ],
  });
  const trials = [];
  for (let i = 1; i <= 3; i++) {
    parses = 0;
    sanitizes = 0;
    const start = performance.now();
    state = state.update({ selection: { anchor: i } }).state;
    trials.push({ ms: Math.round((performance.now() - start) * 10) / 10, parses, sanitizes });
  }
  parses = 0;
  sanitizes = 0;
  state = state.update({ changes: { from: 0, insert: 'x' } }).state;
  result.selectionPerformance.push({
    paragraphs: count,
    characters: text.length,
    lines: state.doc.lines,
    trials,
    typing: { parses, sanitizes },
  });
}
const env = { path: '/generated/Task.md' },
  text = 'initial paragraph\n\n- [ ] first\n\nother paragraph\n\n- [x] second\n';
const a = EditorState.create({
  doc: text,
  extensions: [
    liveExtension(
      env,
      () => {},
      () => {},
      false,
    ),
  ],
});
const b = a.update({ changes: { from: 0, insert: 'x' } }).state;
function widgets(s: any) {
  const values: any[] = [];
  for (const set of s.facet(EditorView.decorations)) {
    const it = set.iter();
    while (it.value) {
      if (it.value.widget?.html.includes('data-task-offset')) values.push(it.value.widget);
      it.next();
    }
  }
  return values;
}
const wa = widgets(a),
  wb = widgets(b);
result.taskWidgets = {
  before: wa.length,
  after: wb.length,
  equal: wa.map((w, i) => w.eq(wb[i])),
  offsetsBefore: wa.map((w) => w.html.match(/data-task-offset="\d+"/g)),
  offsetsAfter: wb.map((w) => w.html.match(/data-task-offset="\d+"/g)),
};
(window as any).reviewResults = result;

const formatted = 'prefix **bold** [link](https://example.invalid) suffix';
const context = document.createElement('div');
context.innerHTML = renderMarkdown(formatted, {
  path: '/generated/context.md',
  copySource: formatted,
});
document.body.append(context);
const selected = document.createRange();
selected.setStart(context.querySelector('strong')!.firstChild!, 0);
selected.setEnd(context.querySelector('a')!.firstChild!, 4);
selection.removeAllRanges();
selection.addRange(selected);
const mapped = copySelection(context, formatted)?.sourceRange;
result.agentSelection = mapped ? formatted.slice(mapped.from, mapped.to) : null;
context.remove();
selection.removeAllRanges();
