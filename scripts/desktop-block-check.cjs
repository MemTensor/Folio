const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

// All coordinates and selections come from the built editor in a hidden
// Electron window. The document itself is a generated startup fixture.
async function verifyBlockSelection(window, initialContent, capturePath = null) {
  const web = window.webContents;
  const evaluate = (fn, ...args) =>
    web.executeJavaScript(`(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
  const pause = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(label, condition) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await condition()) return;
      await pause(20);
    }
    throw Error('Rendered block verification timed out: ' + label);
  }
  async function point(selector, offset, contains) {
    return evaluate(
      (selector, offset, contains) => {
        const element = Array.from(document.querySelectorAll(selector)).find(
          (candidate) => !contains || candidate.textContent.includes(contains),
        );
        if (!element) throw Error('Missing rendered text: ' + selector);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && (text.textContent || '').length <= offset) {
          offset -= (text.textContent || '').length;
          text = walker.nextNode();
        }
        if (!text) throw Error('Missing rendered character at ' + offset + ': ' + selector);
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        const rect = range.getBoundingClientRect();
        return { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2) };
      },
      selector,
      offset,
      contains,
    );
  }
  async function click(at, modifiers = []) {
    web.sendInputEvent({ type: 'mouseDown', button: 'left', ...at, modifiers });
    web.sendInputEvent({ type: 'mouseUp', button: 'left', ...at, modifiers });
    await pause();
  }

  const initial = await evaluate(() => {
    const pre = document.querySelector('.block-fence pre.code-preview');
    return {
      language: pre?.dataset.language,
      code: pre?.querySelector('code')?.textContent,
      fenceVisible: pre?.textContent?.includes('```'),
    };
  });
  assert.equal(initial.language, 'text');
  assert.equal(initial.code, 'alpha bravo charlie\nsecond line\n');
  assert.equal(initial.fenceVisible, false);

  const from = await point('.block-fence code', 6);
  const to = await point('.block-fence code', 12);
  web.focus();
  await evaluate(() => document.querySelector('.cm-content').focus());
  const beforeDrag = await evaluate(() => {
    const content = document.querySelector('.cm-content');
    const view = content.cmTile.root.view;
    return {
      source: view.state.doc.toString(),
      visibleText: content.innerText,
      editorFocused: document.activeElement === content,
    };
  });
  assert.equal(beforeDrag.editorFocused, true);
  assert.equal(beforeDrag.source, initialContent);
  web.sendInputEvent({ type: 'mouseDown', button: 'left', ...from });
  for (let step = 1; step <= 5; step++) {
    web.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(from.x + ((to.x - from.x) * step) / 5),
      y: Math.round(from.y + ((to.y - from.y) * step) / 5),
    });
    await pause(10);
  }
  web.sendInputEvent({ type: 'mouseUp', button: 'left', ...to });
  await pause();
  const selected = await evaluate(() => ({
    text: document.getSelection()?.toString(),
    stillRendered: !!document.querySelector('.block-fence pre.code-preview'),
    sourceVisible: !!document.querySelector('.cm-code-line'),
    previewFocused: document.activeElement === document.querySelector('.block-fence'),
  }));
  assert.match(selected.text, /bravo/);
  assert.equal(selected.stillRendered, true, 'dragging keeps the preview in place');
  assert.equal(selected.sourceVisible, false, 'dragging does not expose the Markdown fence');
  assert.equal(selected.previewFocused, true, 'the preview owns focus during native selection');

  web.sendInputEvent({ type: 'keyDown', keyCode: 'X' });
  web.sendInputEvent({ type: 'char', keyCode: 'X' });
  web.sendInputEvent({ type: 'keyUp', keyCode: 'X' });
  await pause();
  const afterTyping = await evaluate(() => {
    const content = document.querySelector('.cm-content');
    const view = content.cmTile.root.view;
    return {
      source: view.state.doc.toString(),
      visibleText: content.innerText,
      previewStillRendered: !!document.querySelector('.block-fence pre.code-preview'),
      previewFocused: document.activeElement === document.querySelector('.block-fence'),
      nativeSelection: document.getSelection()?.toString(),
    };
  });
  assert.equal(
    afterTyping.source,
    initialContent,
    'typing after a drag cannot edit a stale cursor',
  );
  assert.equal(afterTyping.visibleText, beforeDrag.visibleText, 'typing cannot alter preview DOM');
  assert.equal(afterTyping.previewStillRendered, true);
  assert.equal(afterTyping.previewFocused, true);
  assert.match(afterTyping.nativeSelection, /bravo/);

  const clipboard = await evaluate(() => {
    const preview = document.activeElement;
    const pasteData = new DataTransfer();
    pasteData.setData('text/plain', 'GENERATED_PASTE');
    const paste = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: pasteData,
    });
    preview.dispatchEvent(paste);
    const copyData = new DataTransfer();
    const copy = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: copyData,
    });
    preview.dispatchEvent(copy);
    const cutData = new DataTransfer();
    const cut = new ClipboardEvent('cut', {
      bubbles: true,
      cancelable: true,
      clipboardData: cutData,
    });
    preview.dispatchEvent(cut);
    return {
      pastePrevented: paste.defaultPrevented,
      copyPrevented: copy.defaultPrevented,
      cutPrevented: cut.defaultPrevented,
      copied: copyData.getData('text/plain'),
      cutText: cutData.getData('text/plain'),
    };
  });
  assert.equal(clipboard.pastePrevented, true);
  assert.equal(clipboard.copyPrevented, true);
  assert.equal(clipboard.cutPrevented, true);
  assert.equal(clipboard.copied, selected.text);
  assert.equal(clipboard.cutText, selected.text);

  web.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['meta'] });
  web.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['meta'] });
  await pause();
  const afterShortcut = await evaluate(() => {
    const content = document.querySelector('.cm-content');
    return {
      source: content.cmTile.root.view.state.doc.toString(),
      visibleText: content.innerText,
      previewStillRendered: !!document.querySelector('.block-fence pre.code-preview'),
    };
  });
  assert.equal(afterShortcut.source, initialContent, 'Cmd+B cannot edit a stale source cursor');
  assert.equal(afterShortcut.visibleText, beforeDrag.visibleText);
  assert.equal(afterShortcut.previewStillRendered, true);

  // Dispatch a clipboard event through the editor, where CodeMirror normally
  // copies its source selection. The widget selection must take precedence.
  const copied = await evaluate(() => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    document.querySelector('.cm-content').dispatchEvent(event);
    return { text: clipboardData.getData('text/plain'), prevented: event.defaultPrevented };
  });
  assert.equal(copied.prevented, true);
  assert.equal(copied.text, selected.text);

  for (const command of ['math', 'table']) web.send('command', command);
  await pause(80);
  assert.equal(
    await evaluate(() => !document.querySelector('.rich-editor,.table-editor')),
    true,
    'insertion commands cannot use a stale source cursor while preview text is selected',
  );
  assert.equal(
    await evaluate(() => !!document.querySelector('.block-fence pre.code-preview')),
    true,
  );

  await click(await point('.block-fence code', 8));
  await waitFor('ordinary click opens source', () =>
    evaluate(() => !!document.querySelector('.cm-code-line')),
  );
  const source = await evaluate(() => ({
    text: Array.from(document.querySelectorAll('.cm-code-line'), (line) => line.textContent).join(
      '\n',
    ),
    rendered: Array.from(document.querySelectorAll('.block-fence')).some((node) =>
      node.textContent.includes('alpha bravo charlie'),
    ),
  }));
  assert.match(source.text, /```text/);
  assert.equal(source.rendered, false);

  const sourceFrom = await point('.cm-code-line', 6, 'alpha bravo charlie');
  const sourceTo = await point('.cm-code-line', 6, 'second line');
  web.sendInputEvent({ type: 'mouseDown', button: 'left', ...sourceFrom });
  for (let step = 1; step <= 5; step++) {
    web.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(sourceFrom.x + ((sourceTo.x - sourceFrom.x) * step) / 5),
      y: Math.round(sourceFrom.y + ((sourceTo.y - sourceFrom.y) * step) / 5),
    });
    await pause(10);
  }
  web.sendInputEvent({ type: 'mouseUp', button: 'left', ...sourceTo });
  await pause();
  const sourceDrag = await evaluate(() => {
    const content = document.querySelector('.cm-content');
    const view = content.cmTile.root.view;
    const range = view.state.selection.main;
    const clipboardData = new DataTransfer();
    content.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }),
    );
    return {
      selected: view.state.sliceDoc(range.from, range.to),
      copied: clipboardData.getData('text/plain'),
      source: view.state.doc.toString(),
      rendered: Array.from(document.querySelectorAll('.block-fence')).some((node) =>
        node.textContent.includes('alpha bravo charlie'),
      ),
    };
  });
  assert.match(
    sourceDrag.selected,
    /bravo charlie\nsecond/,
    'dragging across active code lines selects source text',
  );
  assert.equal(sourceDrag.copied, sourceDrag.selected, 'copy uses the active source selection');
  assert.equal(sourceDrag.source, initialContent, 'selecting the source does not change Markdown');
  assert.equal(sourceDrag.rendered, false, 'selection keeps the code block editable');

  // A long code line wraps visually without a Markdown newline. Reproduce the
  // user's actual one-line stack record after clicking its rendered code block.
  await click(await point('.block-fence code', 10, 'stack=image'));
  await waitFor('long fenced source opened', () =>
    evaluate(() =>
      Array.from(document.querySelectorAll('.cm-code-line')).some((line) =>
        line.textContent.includes('stack=image'),
      ),
    ),
  );
  const longFrom = await point('.cm-code-line', 4, 'stack=image');
  const longTo = await point('.cm-code-line', 160, 'stack=image');
  assert(longTo.y > longFrom.y, 'long generated code line must wrap visibly');
  web.sendInputEvent({ type: 'mouseDown', button: 'left', ...longFrom });
  for (let step = 1; step <= 6; step++) {
    web.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(longFrom.x + ((longTo.x - longFrom.x) * step) / 6),
      y: Math.round(longFrom.y + ((longTo.y - longFrom.y) * step) / 6),
    });
    await pause(10);
  }
  web.sendInputEvent({ type: 'mouseUp', button: 'left', ...longTo });
  await pause();
  const longDrag = await evaluate(() => {
    const content = document.querySelector('.cm-content');
    const view = content.cmTile.root.view;
    const range = view.state.selection.main;
    const selectionLayer = document.querySelector('.live-mode .cm-selectionLayer');
    const selectedCodeLine = Array.from(document.querySelectorAll('.cm-code-line')).find((line) =>
      line.textContent.includes('stack=image'),
    );
    const visibleSelection = Array.from(
      selectionLayer?.querySelectorAll('.cm-selectionBackground') || [],
    ).some((marker) => {
      const markerRect = marker.getBoundingClientRect();
      const lineRect = selectedCodeLine?.getBoundingClientRect();
      return (
        lineRect &&
        markerRect.width > 0 &&
        markerRect.height > 0 &&
        markerRect.left < lineRect.right &&
        markerRect.right > lineRect.left &&
        markerRect.top < lineRect.bottom &&
        markerRect.bottom > lineRect.top
      );
    });
    const clipboardData = new DataTransfer();
    content.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }),
    );
    return {
      selected: view.state.sliceDoc(range.from, range.to),
      copied: clipboardData.getData('text/plain'),
      source: view.state.doc.toString(),
      selectionLayerZIndex: Number(getComputedStyle(selectionLayer).zIndex),
      selectionLayerPointerEvents: getComputedStyle(selectionLayer).pointerEvents,
      visibleSelection,
    };
  });
  assert.match(longDrag.selected, /bridge=.*mcore=/);
  assert.equal(longDrag.copied, longDrag.selected);
  assert.equal(longDrag.source, initialContent);
  assert(longDrag.visibleSelection, 'the selected code line has a visible highlight marker');
  assert(longDrag.selectionLayerZIndex > 0, 'the selection is painted above the code background');
  assert.equal(longDrag.selectionLayerPointerEvents, 'none', 'the highlight cannot block dragging');
  if (capturePath) {
    const image = await web.capturePage();
    await fs.writeFile(capturePath.replace(/\.png$/, '-active-code.png'), image.toPNG(), {
      flag: 'wx',
    });
  }

  const fenceFrom = await point('.cm-code-line', 2, '```text');
  const fenceTo = await point('.cm-code-line', 18, 'stack=image');
  web.sendInputEvent({ type: 'mouseDown', button: 'left', ...fenceFrom });
  for (let step = 1; step <= 5; step++) {
    web.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(fenceFrom.x + ((fenceTo.x - fenceFrom.x) * step) / 5),
      y: Math.round(fenceFrom.y + ((fenceTo.y - fenceFrom.y) * step) / 5),
    });
    await pause(10);
  }
  web.sendInputEvent({ type: 'mouseUp', button: 'left', ...fenceTo });
  await pause();
  const markerDrag = await evaluate(() => {
    const content = document.querySelector('.cm-content');
    const view = content.cmTile.root.view;
    const range = view.state.selection.main;
    return {
      selected: view.state.sliceDoc(range.from, range.to),
      source: view.state.doc.toString(),
    };
  });
  assert.match(markerDrag.selected, /`text\nstack=image/);
  assert.equal(markerDrag.source, initialContent);

  // A click below the fence restores its preview; Shift-click into that
  // preview should extend CodeMirror's source selection as before.
  await click(await point('.md-block', 1, 'After the code.'));
  await waitFor('code preview restored', () =>
    evaluate(() => !!document.querySelector('.block-fence code')),
  );
  await click(await point('.block-fence code', 7), ['shift']);
  await waitFor('Shift-click extends source selection', () =>
    evaluate(() => !!document.querySelector('.cm-code-line')),
  );
  const extended = await evaluate(() => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    document.querySelector('.cm-content').dispatchEvent(event);
    return clipboardData.getData('text/plain');
  });
  assert.match(extended, /second line/);
  assert.match(extended, /```\n\nA/);

  assert.equal(initialContent.includes('```text'), true);
  return { dragSelected: selected.text, copied: copied.text, clickToEdit: true, shiftClick: true };
}

module.exports = { verifyBlockSelection };
