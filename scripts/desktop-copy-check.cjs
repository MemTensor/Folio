const assert = require('node:assert/strict');
async function verifyReadingCopy(window, choose, copied, rich, original, language) {
  const web = window.webContents,
    en = language === 'en';
  const evaluate = (fn, ...args) =>
    web.executeJavaScript(`(${fn})(${args.map(JSON.stringify).join(',')})`);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  async function wait(check, ...args) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(check, ...args)) return;
      await pause();
    }
    throw Error('Reading copy verification timed out: ' + check.toString());
  }
  async function copy(id) {
    choose(id);
    const before = copied().length;
    await evaluate(() =>
      document
        .querySelector('.reading-article')
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
        ),
    );
    for (let i = 0; i < 100 && copied().length === before; i++) await pause();
    assert(copied().length > before, 'Copy action did not reach the native clipboard bridge.');
  }
  const selectAll = () =>
    evaluate(() => {
      const article = document.querySelector('.reading-article'),
        range = document.createRange();
      range.selectNodeContents(article);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.activeElement?.blur();
    });
  await selectAll();
  await copy('copy-source');
  assert.equal(copied().at(-1), original);
  await copy('copy-rich');
  assert.match(rich().at(-1).html, /<strong>/);
  assert.match(rich().at(-1).html, /<table/);
  assert.match(rich().at(-1).html, /<ul/);
  assert.match(rich().at(-1).html, /<svg/);
  const references = await evaluate((html) => {
    const fragment = document.createElement('template');
    fragment.innerHTML = html;
    const ids = new Set([...fragment.content.querySelectorAll('[id]')].map((node) => node.id));
    return [...fragment.content.querySelectorAll('use')].every((node) =>
      ids.has((node.getAttribute('href') || node.getAttribute('xlink:href') || '').slice(1)),
    );
  }, rich().at(-1).html);
  assert.equal(references, true, 'Copied formula SVGs must retain their glyph definitions.');
  assert.doesNotMatch(rich().at(-1).html, /data-folio-|<button/);
  const richDefault = await evaluate(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    document.body.dispatchEvent(event);
    return {
      text: data.getData('text/plain'),
      html: data.getData('text/html'),
      prevented: event.defaultPrevented,
    };
  });
  assert(richDefault.prevented);
  assert.match(richDefault.html, /<strong>/);
  assert(!richDefault.text.includes('**问题一'));
  await evaluate(
    (en) =>
      document
        .querySelector('button[aria-label="' + (en ? 'Writing settings' : '写作设置') + '"]')
        .click(),
    en,
  );
  await wait(() => !!document.querySelector('.settings-sidebar'));
  await evaluate(() => document.querySelector('[data-settings-section="reading"]').click());
  await wait(
    () =>
      !!document.querySelector(
        'select[aria-label="默认复制格式"],select[aria-label="Default copy format"]',
      ),
  );
  await evaluate(() => {
    const field = document.querySelector(
      'select[aria-label="默认复制格式"],select[aria-label="Default copy format"]',
    );
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, 'source');
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await evaluate(() => document.querySelector('.modal-heading .icon-button').click());
  await wait(() => !document.querySelector('.modal-backdrop'));
  await selectAll();
  const sourceDefault = await evaluate(() => {
    const data = new DataTransfer();
    document.body.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }),
    );
    return {
      text: data.getData('text/plain'),
      html: data.getData('text/html'),
      saved: JSON.parse(localStorage.getItem('folio-preferences')).readingCopy,
    };
  });
  assert.equal(sourceDefault.text, original);
  assert.equal(sourceDefault.html, '');
  assert.equal(sourceDefault.saved, 'source');
  await copy('copy-rich');
  assert.match(rich().at(-1).html, /<strong>/);
  const partial = await evaluate(() => {
    const strong = document.querySelector('.reading-article strong');
    const text = strong.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  await copy('copy-source');
  assert.equal(copied().at(-1), '**' + partial + '**');
  await copy('copy-rich');
  assert.match(rich().at(-1).html, /<strong>/);
  assert.equal(rich().at(-1).text, partial);
  // Repeated words in the same paragraph must use the selected occurrence.
  await evaluate(() => {
    const paragraph = [...document.querySelectorAll('.reading-article p')].find((p) =>
      p.textContent.includes('Token-MI 需要'),
    );
    const text = [...paragraph.childNodes].find(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.includes('Token-MI 需要'),
    );
    const start = text.textContent.indexOf('Token-MI');
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 8);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await copy('copy-source');
  assert.equal(copied().at(-1), 'Token-MI');
  // A selection in a settings input never inherits the reading clipboard policy.
  await evaluate(
    (en) =>
      document
        .querySelector('button[aria-label="' + (en ? 'Writing settings' : '写作设置') + '"]')
        .click(),
    en,
  );
  await wait(() => !!document.querySelector('.settings-sidebar'));
  await evaluate(() => document.querySelector('[data-settings-section="agent"]').click());
  await wait(
    () =>
      !!document.querySelector('.agent-provider-options') &&
      !document.querySelectorAll('.agent-provider-options button')[1].disabled,
  );
  await evaluate(() => document.querySelectorAll('.agent-provider-options button')[1].click());
  await wait(() => !!document.querySelector('.agent-api-settings input'));
  const inputCopy = await evaluate(() => {
    const input = document.querySelector('.agent-api-settings input');
    input.focus();
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    input.dispatchEvent(event);
    const bodyEvent = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    document.body.dispatchEvent(bodyEvent);
    return event.defaultPrevented || bodyEvent.defaultPrevented;
  });
  assert.equal(inputCopy, false);
  await evaluate(() => document.querySelector('.settings-back').click());
  await wait(
    () => document.querySelector('.settings-content').dataset.settingsPage === 'appearance',
  );
  await evaluate(() => document.querySelector('.modal-heading .icon-button').click());
  await wait(() => !document.querySelector('.modal-backdrop'));
  return {
    sourcePreserved: true,
    richFormatting: true,
    keyboardPreference: true,
    partialFormatting: true,
    inputIsolated: true,
  };
}
module.exports = { verifyReadingCopy };
