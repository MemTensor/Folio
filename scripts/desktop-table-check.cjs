const assert = require('node:assert/strict');

// Exercise the built application through its real DOM and preload bridge. The
// caller supplies only a generated document and a generated-file save backend.
async function verifyTableEditor(window, initialContent, readSavedContent) {
  const web = window.webContents;
  const cells = '.table-editor tbody tr:nth-child(2)';
  const firstCell = `${cells} td:nth-child(1) textarea`;
  const multilineCell = `${cells} td:nth-child(2) textarea`;
  const evaluate = (fn, ...args) =>
    web.executeJavaScript(`(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
  async function waitFor(label, condition) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const values = await evaluate(() =>
      Array.from(document.querySelectorAll('.table-editor textarea'), (cell) => cell.value),
    );
    throw Error(
      'Table editor verification timed out: ' + label + '; cells=' + JSON.stringify(values),
    );
  }
  const value = (selector) => evaluate((s) => document.querySelector(s)?.value, selector);
  async function focusEnd(selector) {
    web.focus();
    await evaluate((s) => {
      const cell = document.querySelector(s);
      if (!cell) throw Error('Missing table cell: ' + s);
      cell.focus();
      cell.setSelectionRange(cell.value.length, cell.value.length);
    }, selector);
  }
  function key(keyCode, modifiers = []) {
    web.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Return') web.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    web.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  async function applyAndSave(expected) {
    await evaluate(() => document.querySelector('.modal-actions .primary').click());
    await waitFor('table dialog closed', () =>
      evaluate(() => !document.querySelector('.table-editor')),
    );
    web.send('command', 'save');
    await waitFor(
      'exact Markdown saved to generated file',
      async () => (await readSavedContent()) === expected,
    );
    assert.equal(await readSavedContent(), expected);
  }
  async function reopen() {
    // Applying a table leaves the cursor at its source start. The ordinary
    // toolbar command must therefore reopen that same table.
    web.send('command', 'table');
    await waitFor('table reopened', async () => (await value(multilineCell)) !== undefined);
  }

  await evaluate(() => document.querySelector('.block-table_open .table-edit-button').click());
  await waitFor('multiline text area', async () => (await value(multilineCell)) !== undefined);
  assert.equal(await value(multilineCell), 'one\ntwo');
  await focusEnd(multilineCell);
  await web.insertText('X');
  await waitFor(
    'native Chromium text input',
    async () => (await value(multilineCell)) === 'one\ntwoX',
  );
  const typedContent = initialContent.replace('one<br>two', 'one<br>twoX');
  await applyAndSave(typedContent);

  await reopen();
  assert.equal(await value(multilineCell), 'one\ntwoX');
  await focusEnd(multilineCell);
  key('Return');
  await waitFor(
    'Enter inserts a cell line break',
    async () => (await value(multilineCell)) === 'one\ntwoX\n',
  );
  await web.insertText('third');
  await waitFor(
    'typing continues on the new cell line',
    async () => (await value(multilineCell)) === 'one\ntwoX\nthird',
  );
  await focusEnd(firstCell);
  key('Tab');
  await waitFor('Tab advances to the next cell', () =>
    evaluate((s) => document.activeElement === document.querySelector(s), multilineCell),
  );
  key('Tab', ['shift']);
  await waitFor('Shift-Tab returns to the previous cell', () =>
    evaluate((s) => document.activeElement === document.querySelector(s), firstCell),
  );

  await evaluate(() => document.querySelector('.modal-actions button').click());
  const pasteCell = '.table-editor tbody tr:nth-child(3) td:nth-child(1) textarea';
  await waitFor('new table row', async () => (await value(pasteCell)) === '');
  await focusEnd(pasteCell);
  const interceptedPaste = await evaluate((selector) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'left\tright\r\nnext\tlast\r\n');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
    document.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  }, pasteCell);
  assert.equal(interceptedPaste, true, 'spreadsheet paste uses the table grid handler');
  await waitFor('spreadsheet paste expands the grid', () =>
    evaluate(() => document.querySelectorAll('.table-editor tbody tr').length === 4),
  );
  const grid = await evaluate(() =>
    Array.from(document.querySelectorAll('.table-editor tbody tr'), (row) =>
      Array.from(row.querySelectorAll('textarea'), (cell) => cell.value),
    ),
  );
  assert.deepEqual(grid, [
    ['Label', 'Notes'],
    ['sample', 'one\ntwoX\nthird'],
    ['left', 'right'],
    ['next', 'last'],
  ]);
  const pastedContent = typedContent.replace(
    '| sample | one<br>twoX |',
    '| sample | one<br>twoX<br>third |\n| left | right |\n| next | last |',
  );
  await applyAndSave(pastedContent);
  return { multilineInput: true, enter: true, tab: true, spreadsheetPaste: true, saved: true };
}

module.exports = { verifyTableEditor };
