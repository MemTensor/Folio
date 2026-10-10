const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function verifyPreferences(window, language, imageRequests, capturePath) {
  const web = window.webContents;
  const evaluate = (fn, ...args) =>
    web.executeJavaScript(`(${fn})(${args.map(JSON.stringify).join(',')})`);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  const en = language === 'en';
  const labels = {
    settings: en ? 'Writing settings' : '写作设置',
    agent: en ? 'Agent settings' : 'Agent 设置',
    back: en ? 'Back to settings' : '返回设置',
    closeBack: en ? 'Close and return to settings' : '关闭并返回设置',
    close: en ? 'Close' : '关闭',
  };
  async function wait(check, ...args) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(check, ...args)) return;
      await pause();
    }
    throw Error('Preferences navigation did not complete: ' + check.toString());
  }
  async function click(root, label) {
    assert(
      await evaluate(
        (root, label) => {
          const button = [...document.querySelector(root).querySelectorAll('button')].find(
            (b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label,
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        },
        root,
        label,
      ),
    );
    await pause();
  }
  async function capture(suffix) {
    if (!capturePath) return;
    await web.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + suffix + '.png'),
      (await web.capturePage()).toPNG(),
      { flag: 'wx' },
    );
  }
  await click('.app', labels.settings);
  await wait(() => !!document.querySelector('.settings-dialog'));
  const overview = await evaluate(() => {
    const dialog = document.querySelector('.settings-dialog');
    dialog.scrollTop = 120;
    return {
      scroll: dialog.scrollTop,
      font: document.querySelector('input[aria-label="文字大小"],input[aria-label="Text size"]')
        ?.value,
    };
  });
  await click('.settings-body', labels.agent);
  await wait(
    () => !!document.querySelector('.settings-back') && !!document.querySelector('.agent-settings'),
  );
  assert.equal(await evaluate(() => document.querySelectorAll('.modal-backdrop').length), 1);
  assert.equal(await evaluate(() => document.querySelector('.settings-body').hidden), true);
  assert.equal(
    await evaluate(() => getComputedStyle(document.querySelector('.settings-body')).display),
    'none',
  );
  assert.equal(
    await evaluate(() => document.querySelector('.modal-heading h2').textContent),
    labels.agent,
  );
  await capture('-settings-agent');
  web.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  web.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(
    () =>
      !!document.querySelector('.settings-body') &&
      !document.querySelector('.settings-body').hidden &&
      !document.querySelector('.agent-settings'),
  );
  assert.equal(
    await evaluate(() => document.querySelector('.settings-dialog').scrollTop),
    overview.scroll,
  );
  assert.equal(await evaluate(() => document.activeElement.textContent.trim()), labels.agent);
  assert.equal(
    await evaluate(
      () =>
        document.querySelector('input[aria-label="文字大小"],input[aria-label="Text size"]')?.value,
    ),
    overview.font,
  );
  await click('.settings-body', labels.agent);
  await wait(() => !!document.querySelector('.agent-settings'));
  await click('.modal-heading', labels.closeBack);
  await wait(() => !document.querySelector('.settings-body').hidden);
  await capture('-settings-parent');
  for (const [label, selector] of [
    [en ? 'AI memory settings' : 'AI 记忆设置', '.memory-settings'],
    [en ? 'Check for updates…' : '检查更新…', '.update-panel'],
  ]) {
    await click('.settings-body', label);
    await wait((selector) => !!document.querySelector(selector), selector);
    await click('.modal-heading', labels.back);
    await wait(
      (selector) =>
        !document.querySelector('.settings-body').hidden && !document.querySelector(selector),
      selector,
    );
  }
  await click('.modal-heading', labels.close);
  await wait(() => !document.querySelector('.modal-backdrop'));
  assert.equal(imageRequests(), 0);
  assert(await evaluate(() => !!document.querySelector('.cm-content [data-folio-remote-enable]')));
  await evaluate(() => [...document.querySelectorAll('.view-switch button')][2].click());
  await wait(() => !!document.querySelector('.reading-article [data-folio-remote-enable]'));
  assert.equal(await evaluate(() => document.querySelector('.reading-article img') === null), true);
  await evaluate(() =>
    [...document.querySelectorAll('.reading-article button')]
      .find((b) => b.textContent === 'Forged image control')
      .click(),
  );
  assert.equal(imageRequests(), 0);
  assert(
    await evaluate(() => !!document.querySelector('.reading-article [data-folio-remote-enable]')),
  );
  await evaluate(() => document.querySelector('.reading-article .image-unloaded').scrollIntoView());
  await capture('-images-blocked');
  await evaluate(() =>
    document.querySelector('.reading-article [data-folio-remote-enable]').click(),
  );
  await wait(() => !!document.querySelector('.reading-article img'));
  await evaluate(() => document.querySelector('.reading-article img').scrollIntoView());
  await wait(() => document.querySelector('.reading-article img').naturalWidth === 1);
  assert.equal(imageRequests(), 1);
  assert.equal(
    await evaluate(
      () => document.querySelector('.reading-article [data-folio-remote-enable]') === null,
    ),
    true,
  );
  await click('.app', labels.settings);
  await evaluate((en) => {
    const label = en ? 'Load remote images' : '加载网络图片';
    const row = [...document.querySelectorAll('.settings-toggle')].find(
      (n) => n.querySelector('strong')?.textContent === label,
    );
    const checkbox = row.querySelector('input');
    if (checkbox.checked) checkbox.click();
  }, en);
  await click('.modal-heading', labels.close);
  await wait(() => !!document.querySelector('.reading-article [data-folio-remote-enable]'));
  await evaluate(() => document.querySelector('.view-switch button:first-child').click());
  await wait(() => !!document.querySelector('.cm-content [data-folio-remote-enable]'));
  await evaluate(() => document.querySelector('.cm-content [data-folio-remote-enable]').click());
  await wait(() => !!document.querySelector('.cm-content img'));
  return {
    settingsReturn: true,
    scopePreserved: true,
    remoteImagesOptIn: true,
    forgedControlRejected: true,
  };
}
module.exports = { verifyPreferences };
