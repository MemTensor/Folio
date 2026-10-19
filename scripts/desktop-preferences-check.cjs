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
  const layout = await evaluate(() => ({
    count: document.querySelectorAll('.settings-sidebar button').length,
    nav: document.querySelector('.settings-sidebar').getBoundingClientRect().right,
    content: document.querySelector('.settings-content').getBoundingClientRect().left,
    height: document.querySelector('.settings-dialog').getBoundingClientRect().height,
  }));
  assert.equal(layout.count, 8);
  assert(layout.nav <= layout.content);
  assert(layout.height <= 600);
  const font = await evaluate(
    () =>
      document.querySelector('input[aria-label="文字大小"],input[aria-label="Text size"]').value,
  );
  await evaluate(() => document.querySelector('[data-settings-section="agent"]').click());
  await wait(() => !!document.querySelector('.agent-settings'));
  assert.equal(await evaluate(() => document.querySelectorAll('.modal-backdrop').length), 1);
  await capture('-settings-agent');
  web.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  web.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(
    () => document.querySelector('.settings-content').dataset.settingsPage === 'appearance',
  );
  assert.equal(
    await evaluate(
      () =>
        document.querySelector('input[aria-label="文字大小"],input[aria-label="Text size"]').value,
    ),
    font,
  );
  await capture('-settings-parent');
  for (const [section, selector] of [
    ['memory', '.memory-settings'],
    ['about', '.update-panel'],
  ]) {
    await evaluate(
      (section) => document.querySelector('[data-settings-section="' + section + '"]').click(),
      section,
    );
    await wait((selector) => !!document.querySelector(selector), selector);
    await click('.modal-heading', labels.back);
    await wait(
      () => document.querySelector('.settings-content').dataset.settingsPage === 'appearance',
    );
  }
  await evaluate(() => document.querySelector('[data-settings-section="writing"]').click());
  await evaluate(() => document.querySelector('[data-settings-section="agent"]').click());
  await wait(
    () =>
      !!document.querySelector('.agent-settings') &&
      !document.querySelectorAll('.agent-provider-options button')[0]?.disabled,
  );
  await click('.agent-settings-actions', en ? 'Connect and return to settings' : '连接并返回设置');
  await wait(() => document.querySelector('.settings-content')?.dataset.settingsPage === 'writing');
  await wait(() => document.activeElement?.getAttribute('data-settings-section') === 'writing');
  assert.equal(await evaluate(() => document.querySelectorAll('.modal-backdrop').length), 1);
  await evaluate(() => document.querySelector('[data-settings-section="reading"]').click());
  await wait(
    () =>
      !!document.querySelector(
        'select[aria-label="默认复制格式"],select[aria-label="Default copy format"]',
      ),
  );
  assert.equal(
    await evaluate(
      () =>
        document.querySelector(
          'select[aria-label="默认复制格式"],select[aria-label="Default copy format"]',
        ).value,
    ),
    'rich',
  );
  await capture('-settings-reading');
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
  await evaluate(() => document.querySelector('[data-settings-section="reading"]').click());
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
