import { t, getLocale, subscribeLocale, documentText } from './i18n';
import { useEffect, useRef } from 'react';
import {
  EditorState,
  StateField,
  Compartment,
  Transaction,
  EditorSelection,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  Decoration,
  WidgetType,
  keymap,
  drawSelection,
  highlightActiveLine,
  dropCursor,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import {
  history,
  historyField,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
} from '@codemirror/language';
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  parser,
  renderMarkdown,
  renderTokens,
  renderDiagrams,
  headings,
  type RenderEnv,
} from './markdown';
import { taskToggleChange } from './task-markers.mjs';
import { registerCopySource } from './reading-copy';
// Folio binds these chords to its own formatting commands on the document. Left in
// place, CodeMirror's defaults run first and win: Mod-i selects the enclosing
// syntax node so "italic" wraps a whole paragraph, Mod-/ comments the line out,
// and Shift-Mod-k deletes it before the inline-code command inserts anything.
const reservedChords = new Set(['Mod-i', 'Mod-/', 'Shift-Mod-k']);
const editorKeymap = defaultKeymap.filter(
  (binding) => !reservedChords.has(binding.key || '') && !reservedChords.has(binding.mac || ''),
);
export interface EditorSettings {
  mode: 'live' | 'source' | 'read';
  focus: boolean;
  typewriter: boolean;
  spellcheck: boolean;
  remoteImages: boolean;
  lineNumbers: boolean;
  lightweight?: boolean;
}
export interface EditorHandle {
  view: EditorView;
  lock: (value: boolean) => void;
  command: (id: string) => void;
  jump: (line: number) => void;
  selection: () => string;
}
interface Props {
  path: string;
  content: string;
  revision: number;
  settings: EditorSettings;
  onChange: (text: string) => void;
  onCursor: (line: number, column: number, selection: string) => void;
  onReady: (handle: EditorHandle | null) => void;
  onLink: (href: string) => void;
  onImage: (files: File[]) => void;
  onTable: (from: number, to: number, raw: string, kind?: 'table' | 'math' | 'diagram') => void;
}
class BlockWidget extends WidgetType {
  readonly locale = getLocale();
  constructor(
    readonly raw: string,
    readonly from: number,
    readonly to: number,
    readonly env: RenderEnv,
    readonly type: string,
    readonly html: string,
    readonly links: (s: string) => void,
    readonly table: Props['onTable'],
  ) {
    super();
  }
  eq(other: BlockWidget) {
    // Deliberately not comparing `from`: an edit early in the document shifts every
    // later block, and treating that as a change rebuilt each one's DOM and
    // re-rendered every Mermaid diagram on the keystroke. Handlers resolve their
    // own position through `locate()` instead.
    return (
      this.locale === other.locale &&
      this.html === other.html &&
      this.raw === other.raw &&
      this.env.path === other.env.path &&
      this.env.remoteImages === other.env.remoteImages
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.className = 'md-block markdown-body block-' + this.type;
    dom.tabIndex = -1;
    dom.innerHTML = this.html;
    const copyPreview = (event: ClipboardEvent) => {
      const selection = dom.ownerDocument.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        !dom.contains(selection.anchorNode) ||
        !event.clipboardData
      )
        return;
      event.clipboardData.clearData();
      event.clipboardData.setData('text/plain', selection.toString());
      event.preventDefault();
    };
    dom.addEventListener('copy', copyPreview);
    dom.addEventListener('cut', copyPreview);
    dom.addEventListener('paste', (event) => event.preventDefault());
    /** Where this widget currently sits, which is not where it was built. */
    const locate = () => {
      let from = this.from;
      try {
        const at = view.posAtDOM(dom);
        if (Number.isInteger(at) && at >= 0 && at <= view.state.doc.length) from = at;
      } catch {
        // Fall back to the construction position if the node has left the view.
      }
      return { from, to: Math.min(view.state.doc.length, from + this.raw.length) };
    };
    registerCopySource(dom, () => ({ ...locate(), raw: this.raw }));
    if (
      this.type === 'table_open' ||
      this.type === 'math_block' ||
      (this.type === 'fence' && this.raw.startsWith('```mermaid'))
    ) {
      const kind =
        this.type === 'table_open' ? 'table' : this.type === 'math_block' ? 'math' : 'diagram';
      const button = document.createElement('button');
      button.className = 'table-edit-button';
      button.textContent =
        kind === 'table' ? t('编辑表格') : kind === 'math' ? t('编辑公式') : t('编辑图表');
      button.type = 'button';
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (view.state.readOnly) return;
        const span = locate();
        this.table(span.from, span.to, this.raw, kind);
      });
      dom.append(button);
    }
    const picture = dom.querySelector('img');
    if (picture) {
      const button = document.createElement('button');
      button.className = 'table-edit-button';
      button.textContent = t('放大图片');
      button.type = 'button';
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent('folio-image', { detail: { src: picture.src, alt: picture.alt } }),
        );
      });
      dom.append(button);
    }
    const editAt = (e: MouseEvent) => {
      const span = locate();
      const rect = dom.getBoundingClientRect();
      const ratio = Math.min(0.98, Math.max(0, (e.clientY - rect.top) / rect.height));
      const rawLines = this.raw.split('\n');
      const row = Math.floor(ratio * rawLines.length);
      const prefix = rawLines.slice(0, row).join('\n').length + (row ? 1 : 0);
      let pos = Math.min(span.to, span.from + prefix);
      // Use the rendered text caret when it maps directly to Markdown. Object
      // widgets and transformed text keep the source-line fallback above.
      const caret = dom.ownerDocument.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (
        caret &&
        caret.startContainer.nodeType === Node.TEXT_NODE &&
        dom.contains(caret.startContainer)
      ) {
        const fragment = caret.startContainer.textContent || '';
        let best = -1;
        if (fragment)
          for (
            let at = this.raw.indexOf(fragment);
            at !== -1;
            at = this.raw.indexOf(fragment, at + 1)
          )
            if (best < 0 || Math.abs(at - prefix) < Math.abs(best - prefix)) best = at;
        if (best >= 0) pos = Math.min(span.to, span.from + best + caret.startOffset);
      }
      view.dispatch({
        selection: { anchor: e.shiftKey ? view.state.selection.main.anchor : pos, head: pos },
        scrollIntoView: false,
        userEvent: 'select.pointer',
      });
      view.focus();
    };
    let handledMouseDown = false;
    dom.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      handledMouseDown = false;
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;
      const link = target.closest('a');
      if (link && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handledMouseDown = true;
        this.links(link.getAttribute('href') || '');
        return;
      }
      const checkbox = target.closest('input[type=checkbox]') as HTMLInputElement | null;
      if (checkbox && !e.shiftKey) {
        e.preventDefault();
        handledMouseDown = true;
        if (view.state.readOnly) return;
        const span = locate();
        const change = taskToggleChange(
          view.state.doc.toString(),
          Number(checkbox.dataset.taskOffset),
          span.from,
          span.to,
        );
        if (change) view.dispatch({ changes: change });
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        handledMouseDown = true;
        editAt(e);
        return;
      }
      // CodeMirror owns the editable parent of this read-only widget. Letting
      // Chromium handle a drag here can briefly select the preview, then jump
      // back to CodeMirror's cursor. Keep the gesture inside the widget and
      // update the browser selection explicitly as the pointer moves.
      e.preventDefault();
      dom.focus({ preventScroll: true });
      const start = dom.ownerDocument.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (!start || !dom.contains(start.startContainer)) return;
      const origin = { x: e.clientX, y: e.clientY };
      let dragged = false;
      const selectTo = (event: MouseEvent) => {
        const end = dom.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
        if (!end || !view.contentDOM.contains(end.startContainer)) return;
        dom.ownerDocument
          .getSelection()
          ?.setBaseAndExtent(
            start.startContainer,
            start.startOffset,
            end.startContainer,
            end.startOffset,
          );
      };
      const move = (event: MouseEvent) => {
        if (!(event.buttons & 1)) return;
        if (!dragged && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 4) return;
        dragged = true;
        handledMouseDown = true;
        event.preventDefault();
        selectTo(event);
      };
      const up = (event: MouseEvent) => {
        dom.ownerDocument.removeEventListener('mousemove', move, true);
        dom.ownerDocument.removeEventListener('mouseup', up, true);
        if (dragged) {
          event.preventDefault();
          selectTo(event);
        } else {
          // The previous native selection remains until this click completes;
          // enter source here so it cannot be mistaken for a new drag.
          event.preventDefault();
          handledMouseDown = true;
          editAt(event);
        }
      };
      dom.ownerDocument.addEventListener('mousemove', move, true);
      dom.ownerDocument.addEventListener('mouseup', up, true);
    });
    dom.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      if (handledMouseDown) {
        handledMouseDown = false;
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest('button, input[type=checkbox]')) return;
      if (target.closest('a') && (e.metaKey || e.ctrlKey)) return;
      const selection = dom.ownerDocument.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        (dom.contains(selection.anchorNode) || dom.contains(selection.focusNode))
      )
        return;
      editAt(e);
    });
    requestAnimationFrame(() => {
      void renderDiagrams(dom).then(() => view.requestMeasure());
    });
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}
export function selectedWidgetText(view: EditorView) {
  const selection = view.contentDOM.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return null;
  const element =
    selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? (selection.anchorNode as Element)
      : selection.anchorNode.parentElement;
  const widget = element?.closest('.md-block');
  return widget && view.contentDOM.contains(widget) ? selection.toString() : null;
}
function liveExtension(
  env: RenderEnv,
  links: Props['onLink'],
  table: Props['onTable'],
  focus: boolean,
): Extension {
  const build = (state: EditorState) => {
    const text = state.doc.toString(),
      context: any = {},
      tokens = parser.parse(text, context),
      ranges: any[] = [];
    const active = state.selection.ranges;
    const hs = headings(text);
    const covered = new Set<number>();
    const intersects = (from: number, to: number) =>
      active.some((s) => s.from <= to && s.to >= from);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.level !== 0 || !token.map || token.nesting === -1) continue;
      const start = token.map[0] + 1,
        end = Math.min(state.doc.lines, token.map[1]);
      if (start > end || start > state.doc.lines) continue;
      const from = state.doc.line(start).from,
        to = state.doc.line(end).to;
      for (let n = start; n <= end; n++) covered.add(n);
      if (from === to) continue;
      if (!intersects(from, to)) {
        let last = i + 1;
        if (token.nesting === 1) {
          while (last < tokens.length && !(tokens[last].level === 0 && tokens[last].nesting === -1))
            last++;
          last = Math.min(last + 1, tokens.length);
        }
        const renderEnv = { ...context, ...env, headings: hs, lineOffset: 0 };
        const html = renderTokens(tokens.slice(i, last), renderEnv);
        ranges.push(
          Decoration.replace({
            widget: new BlockWidget(
              state.sliceDoc(from, to),
              from,
              to,
              renderEnv,
              token.type,
              html,
              links,
              table,
            ),
            block: true,
          }).range(from, to),
        );
      } else {
        for (let n = start; n <= end; n++) {
          const line = state.doc.line(n),
            heading = /^(#{1,6}) /.exec(line.text);
          const cls = heading
            ? 'cm-heading cm-h' + heading[1].length
            : token.type === 'fence'
              ? 'cm-code-line'
              : token.type === 'blockquote_open'
                ? 'cm-quote-line'
                : token.type === 'frontmatter'
                  ? 'cm-frontmatter-line'
                  : '';
          if (cls) ranges.push(Decoration.line({ class: cls }).range(line.from));
          if (heading) {
            const markerTo = line.from + heading[0].length;
            // Keep the Markdown marker in the document while the heading is
            // being edited. Reveal it only when the cursor enters the marker
            // itself, where hiding it would make that cursor position ambiguous.
            if (!active.some((s) => s.from < markerTo && s.to >= line.from))
              ranges.push(Decoration.replace({}).range(line.from, markerTo));
          }
        }
      }
    }
    for (let n = 1; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      if (!covered.has(n) && !l.text && !intersects(l.from, l.to))
        ranges.push(Decoration.line({ class: 'cm-blank-line' }).range(l.from));
    }
    return Decoration.set(ranges, true);
  };
  const field = StateField.define<DecorationSet>({
    create: build,
    update: (value, tr) => (tr.docChanged || tr.selection ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field, EditorView.editorAttributes.of({ class: focus ? 'focus-mode' : '' })];
}
const states = new Map<string, any>(),
  scrolls = new Map<string, number>();
export function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    ref = useRef(props),
    viewRef = useRef<EditorView | null>(null),
    setting = useRef(new Compartment()),
    editing = useRef(new Compartment());
  ref.current = props;
  const extensions = () => {
    const s = ref.current.settings;
    return [
      s.mode === 'source'
        ? [...(s.lineNumbers ? [lineNumbers(), foldGutter()] : []), highlightActiveLine()]
        : liveExtension(
            { path: ref.current.path, remoteImages: s.remoteImages, imageControls: true },
            (s) => ref.current.onLink(s),
            (...args) => ref.current.onTable(...args),
            s.focus,
          ),
      EditorView.contentAttributes.of({
        spellcheck: String(s.spellcheck),
        'aria-label': t('Markdown 编辑器'),
        'data-testid': 'markdown-editor',
      }),
      EditorView.editorAttributes.of({ class: s.typewriter ? 'typewriter-mode' : '' }),
    ];
  };
  useEffect(() => {
    if (!host.current) return;
    const update = EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((t) => t.annotation(Transaction.remote)))
        ref.current.onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head,
          line = u.state.doc.lineAt(head);
        ref.current.onCursor(
          line.number,
          head - line.from + 1,
          u.state.sliceDoc(u.state.selection.main.from, u.state.selection.main.to),
        );
      }
      if (ref.current.settings.typewriter && (u.docChanged || u.selectionSet))
        requestAnimationFrame(() => {
          if (viewRef.current === u.view)
            u.view.dispatch({
              effects: EditorView.scrollIntoView(u.state.selection.main.head, { y: 'center' }),
            });
        });
    });
    const base: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      ...(ref.current.settings.lightweight
        ? []
        : [
            EditorView.lineWrapping,
            markdown({ codeLanguages: languages }),
            syntaxHighlighting(defaultHighlightStyle),
          ]),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([
        ...closeBracketsKeymap,
        ...markdownKeymap,
        ...searchKeymap,
        ...editorKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      update,
      setting.current.of(extensions()),
      editing.current.of([]),
      EditorView.domEventHandlers({
        copy: (event, view) => {
          const text = selectedWidgetText(view);
          if (text === null || !event.clipboardData) return false;
          event.clipboardData.clearData();
          event.clipboardData.setData('text/plain', text);
          return true;
        },
        cut: (event, view) => {
          const text = selectedWidgetText(view);
          if (text === null || !event.clipboardData) return false;
          // A rendered widget is a preview of source, not an editable DOM node.
          event.clipboardData.clearData();
          event.clipboardData.setData('text/plain', text);
          return true;
        },
        drop: (event) => {
          if (viewRef.current?.state.readOnly) {
            event.preventDefault();
            return true;
          }
          if (event.dataTransfer?.files.length) {
            event.preventDefault();
            ref.current.onImage(Array.from(event.dataTransfer.files));
            return true;
          }
          return false;
        },
        paste: (event) => {
          if (viewRef.current?.state.readOnly) {
            event.preventDefault();
            return true;
          }
          const files = Array.from(event.clipboardData?.files || []);
          if (files.length) {
            event.preventDefault();
            ref.current.onImage(files);
            return true;
          }
          return false;
        },
      }),
    ];
    const cached = states.get(props.path);
    let state =
      cached && cached.doc === props.content
        ? EditorState.fromJSON(cached, { extensions: base }, { history: historyField })
        : EditorState.create({ doc: props.content, extensions: base });
    // A newly opened heading starts at source position zero. Move that initial
    // caret past its Markdown marker so writing mode opens on the visible title.
    // A later deliberate Home/arrow move into the marker still reveals it.
    const initialHeading = /^(#{1,6}) /.exec(props.content);
    if (
      ref.current.settings.mode === 'live' &&
      initialHeading &&
      state.selection.main.empty &&
      state.selection.main.head === 0
    )
      state = state.update({
        selection: EditorSelection.cursor(initialHeading[0].length),
        annotations: Transaction.addToHistory.of(false),
      }).state;
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    const handle: EditorHandle = {
      view,
      lock: (value) =>
        view.dispatch({
          effects: editing.current.reconfigure([
            EditorState.readOnly.of(value),
            EditorView.editable.of(!value),
          ]),
        }),
      command: (id) => runCommand(view, id),
      jump: (line) => {
        const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({
          selection: { anchor: l.from },
          effects: EditorView.scrollIntoView(l.from, { y: 'start' }),
        });
        view.focus();
      },
      selection: () =>
        selectedWidgetText(view) ??
        view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    };
    props.onReady(handle);
    const cursor = view.state.selection.main,
      line = view.state.doc.lineAt(cursor.head);
    props.onCursor(
      line.number,
      cursor.head - line.from + 1,
      view.state.sliceDoc(cursor.from, cursor.to),
    );
    requestAnimationFrame(() => {
      if (viewRef.current === view) view.scrollDOM.scrollTop = scrolls.get(props.path) || 0;
    });
    return () => {
      scrolls.set(props.path, view.scrollDOM.scrollTop);
      states.set(props.path, view.state.toJSON({ history: historyField }));
      if (states.size > 30) {
        const old = states.keys().next().value!;
        states.delete(old);
        scrolls.delete(old);
      }
      view.destroy();
      viewRef.current = null;
      ref.current.onReady(null);
    };
  }, [props.path, props.settings.lightweight]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== props.content) {
      const pos = Math.min(view.state.selection.main.head, props.content.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.content },
        selection: { anchor: pos },
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [props.revision, props.content]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setting.current.reconfigure(extensions()) });
  }, [
    props.settings.mode,
    props.settings.focus,
    props.settings.typewriter,
    props.settings.spellcheck,
    props.settings.remoteImages,
    props.settings.lineNumbers,
  ]);
  useEffect(
    () =>
      subscribeLocale(() => {
        viewRef.current?.dispatch({ effects: setting.current.reconfigure(extensions()) });
      }),
    [],
  );
  return (
    <div
      className={'editor-host ' + (props.settings.mode === 'source' ? 'source-mode' : 'live-mode')}
      ref={host}
    />
  );
}
export function insertText(view: EditorView, text: string, placeholder?: string) {
  if (view.state.readOnly) return;
  const selection = view.state.selection.main;
  const from = selection.from;
  view.dispatch({
    changes: { from, to: selection.to, insert: text },
    selection: placeholder
      ? EditorSelection.range(
          from + text.indexOf(placeholder),
          from + text.indexOf(placeholder) + placeholder.length,
        )
      : { anchor: from + text.length },
  });
  view.focus();
}
export function runCommand(view: EditorView, id: string) {
  if (view.state.readOnly) return;
  if (id === 'find') {
    openSearchPanel(view);
    return;
  }
  // A native selection in a rendered widget has no equivalent CodeMirror
  // source range. Applying a formatting command at the old source cursor would
  // silently edit unrelated Markdown.
  if (selectedWidgetText(view) !== null) return;
  const range = view.state.selection.main,
    selected = view.state.sliceDoc(range.from, range.to),
    line = view.state.doc.lineAt(range.from);
  const wrap = (mark: string, fallback = documentText('文字', 'text'), end = mark) => {
    const value = selected || fallback;
    const core = value.trim();
    if (!core) return;
    // Inline delimiters must hug the text. Keep selected indentation and line
    // breaks outside them so formatting a whole line still renders correctly.
    const leading = value.slice(0, value.indexOf(core));
    const trailing = value.slice(value.indexOf(core) + core.length);
    insertText(view, leading + mark + core + end + trailing, core);
  };
  if (id === 'bold') wrap('**');
  else if (id === 'italic') wrap('*');
  else if (id === 'strike') wrap('~~');
  else if (id === 'highlight') wrap('==');
  else if (id === 'code') wrap('`', 'code');
  else if (id === 'link') {
    const label = selected || documentText('链接文字', 'link text');
    insertText(view, `[${label}](https://example.com)`, 'https://example.com');
  } else if (id === 'image')
    insertText(
      view,
      `![${documentText('图片说明', 'image description')}](assets/image.png)`,
      'assets/image.png',
    );
  else if (id === 'codeblock') {
    const body = selected || documentText('代码', 'code');
    insertText(view, '\n```text\n' + body + '\n```\n', body);
  } else if (id === 'math')
    insertText(view, '\n$$\n' + (selected || 'E = mc^2') + '\n$$\n', selected || 'E = mc^2');
  else if (id === 'rule') insertText(view, '\n\n---\n\n');
  else if (id === 'toc') insertText(view, '[toc]\n');
  else {
    const prefixes: Record<string, string> = {
      paragraph: '',
      quote: '> ',
      bullet: '- ',
      ordered: '1. ',
      task: '- [ ] ',
    };
    const prefix = id.startsWith('heading-')
      ? '#'.repeat(Number(id.slice(-1))) + ' '
      : prefixes[id];
    if (prefix === undefined) return;
    const end = view.state.doc.lineAt(range.to);
    const changes = [];
    for (let n = line.number; n <= end.number; n++) {
      const l = view.state.doc.line(n);
      changes.push({
        from: l.from,
        to:
          l.from + (l.text.match(/^(?:#{1,6} |> |[-*+] (?:\[[ xX]\] )?|\d+\. )/)?.[0].length || 0),
        insert: prefix,
      });
    }
    view.dispatch({ changes });
    view.focus();
  }
}
