const assert = require('node:assert/strict');

async function verifyContextMenu(window, choose, marker) {
  const web = window.webContents;
  const evaluate = (fn, ...args) =>
    web.executeJavaScript(`(${fn})(${args.map(JSON.stringify).join(',')})`);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  async function wait(check) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(check)) return;
      await pause();
    }
    throw Error('Context action did not complete.');
  }
  async function rightClick(selector, id) {
    choose(id);
    await evaluate((selector) => {
      const node = document.querySelector(selector);
      if (!node) throw Error('Context target missing.');
      node.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
      );
    }, selector);
    await pause();
  }
  await evaluate(() => document.querySelector('.view-switch button:last-child').click());
  await wait(() => !!document.querySelector('.reading-article'));
  await rightClick('.reading-article', 'select-document');
  assert(await evaluate((marker) => window.getSelection().toString().includes(marker), marker));
  assert.equal(await evaluate(() => window.getSelection().toString().includes('workspace')), false);
  await rightClick('.project-document-row', 'reveal');
  assert.equal(await evaluate(() => !!document.querySelector('.modal-backdrop')), false);
  await rightClick('.reading-article', 'edit-source');
  await wait(() => !!document.querySelector('.source-mode'));
  const points = await evaluate((marker) => {
    const line = [...document.querySelectorAll('.cm-line')].find(
      (node) => node.textContent === marker,
    );
    if (!line) throw Error('Source line missing.');
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const first = nodes[0],
      last = nodes.at(-1);
    const start = document.createRange(),
      end = document.createRange();
    start.setStart(first, 0);
    start.setEnd(first, 1);
    end.setStart(last, last.textContent.length - 1);
    end.setEnd(last, last.textContent.length);
    const a = start.getBoundingClientRect(),
      b = end.getBoundingClientRect();
    return {
      from: { x: Math.round(a.left + 1), y: Math.round(a.top + a.height / 2) },
      to: { x: Math.round(b.right - 1), y: Math.round(b.top + b.height / 2) },
    };
  }, marker);
  web.focus();
  await evaluate(() => document.querySelector('.cm-content').focus());
  web.sendInputEvent({ type: 'mouseDown', button: 'left', ...points.from });
  web.sendInputEvent({ type: 'mouseMove', button: 'left', ...points.to });
  web.sendInputEvent({ type: 'mouseUp', button: 'left', ...points.to });
  await pause();
  assert.equal(await evaluate(() => window.getSelection().toString().trimEnd()), marker);
  await rightClick('.cm-content', 'bold');
  await wait(() =>
    document.querySelector('.cm-content').textContent.includes('**FOLIO_DESKTOP_SMOKE_BODY**'),
  );
  web.sendInputEvent({
    type: 'keyDown',
    keyCode: 'Z',
    modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
  });
  await wait(
    () =>
      !document.querySelector('.cm-content').textContent.includes('**FOLIO_DESKTOP_SMOKE_BODY**'),
  );
  await rightClick('.doc-tab', 'close-tab');
  await wait(() => !document.querySelector('.doc-tab'));
  return {
    documentOnlySelection: true,
    sourceFormattingUndo: true,
    fileTarget: true,
    draftBeforeClose: true,
  };
}
module.exports = { verifyContextMenu };
