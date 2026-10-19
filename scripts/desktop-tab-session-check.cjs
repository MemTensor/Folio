const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function verifyTabSession(window, language, fixtures, capturePath) {
  const web = window.webContents,
    en = language === 'en';
  const evaluate = (fn, ...args) =>
    web.executeJavaScript(`(${fn})(${args.map(JSON.stringify).join(',')})`);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  async function wait(fn, ...args) {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(fn, ...args)) return;
      await pause();
    }
    throw Error('Tab session check timed out: ' + fn.toString());
  }
  async function button(label, root = '.close-session-dialog') {
    assert(
      await evaluate(
        (label, root) => {
          const button = [...document.querySelector(root).querySelectorAll('button')].find(
            (b) => b.textContent.trim() === label,
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        },
        label,
        root,
      ),
    );
    await pause();
  }
  const prefs = () => evaluate(() => JSON.parse(localStorage.getItem('folio-preferences')));
  const snapshot = () => evaluate(() => JSON.parse(localStorage.getItem('folio-tab-session')));
  async function reload(config) {
    await evaluate((config) => {
      if (config) {
        localStorage.setItem(
          'folio-preferences',
          JSON.stringify({
            ...JSON.parse(localStorage.getItem('folio-preferences')),
            restoreTabs: config.preference,
            autoSave: false,
          }),
        );
        localStorage.setItem(
          'folio-tab-session',
          JSON.stringify({
            version: 1,
            paths: config.paths,
            active: config.active,
            restore: true,
            resumeOnce: !!config.resumeOnce,
          }),
        );
      }
    }, config || null);
    fixtures.noInitial();
    const boots = fixtures.boots();
    await window.loadURL('folio://app/index.html');
    await wait(() => !!document.querySelector('.app'));
    for (let i = 0; i < 120 && fixtures.boots() <= boots; i++) await pause();
    assert(fixtures.boots() > boots, 'Startup must finish before close');
  }
  async function requestClose() {
    web.send('command', 'close-request');
    await wait(() => !!document.querySelector('.close-session-dialog'));
  }
  const { file, referenceFile } = fixtures;
  web.send('open-request', { root: path.dirname(file), path: file });
  await wait(
    (file) => document.querySelector('.document-surface')?.dataset.documentPath === file,
    file,
  );
  web.send('command', 'settings');
  await wait(() => !!document.querySelector('.settings-dialog'));
  await evaluate(() => document.querySelector('[data-settings-section="general"]').click());
  assert.deepEqual(
    await evaluate(() =>
      [...document.querySelector('.settings-content select').options].map((o) => o.value),
    ),
    ['always', 'never', 'ask'],
  );
  assert.equal(
    await evaluate(() => document.querySelector('.settings-content select').value),
    'ask',
  );
  for (const preference of ['always', 'never', 'ask']) {
    await evaluate((preference) => {
      const control = document.querySelector('.settings-content select');
      control.value = preference;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }, preference);
    await wait(
      (preference) =>
        JSON.parse(localStorage.getItem('folio-preferences')).restoreTabs === preference,
      preference,
    );
  }
  await evaluate(() =>
    document.querySelector('.settings-dialog .modal-heading button:last-child').click(),
  );
  await requestClose();
  await evaluate(() => document.querySelector('.close-session-remember input').click());
  await button(en ? 'Keep editing' : '继续编辑');
  assert.equal((await prefs()).restoreTabs, 'ask', 'Cancel must not remember the checkbox');
  assert.equal(fixtures.closes(), 0);

  await requestClose();
  await evaluate(() => {
    document.querySelectorAll('input[name="restore-tabs"]')[1].click();
    document.querySelector('.close-session-remember input').click();
  });
  if (capturePath) {
    await web.executeJavaScript(
      'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + '-close-tabs.png'),
      (await web.capturePage()).toPNG(),
      { flag: 'wx' },
    );
  }
  await button(en ? 'Close Folio' : '关闭 Folio');
  assert.equal(fixtures.closes(), 1);
  assert.equal((await prefs()).restoreTabs, 'never');
  assert.deepEqual((await snapshot()).paths, []);
  await reload();
  assert.equal(
    await evaluate(() => document.querySelectorAll('.doc-tab').length),
    0,
    'The last document must not reopen an empty session',
  );
  web.send('open-request', { root: path.dirname(file), path: file });
  await wait(
    (file) => document.querySelector('.document-surface')?.dataset.documentPath === file,
    file,
  );

  // Restore tab order and the active tab across a renderer restart.
  await reload({ preference: 'always', paths: [referenceFile, file], active: referenceFile });
  assert.deepEqual(
    await evaluate(() => [...document.querySelectorAll('.doc-tab')].map((n) => n.title)),
    [referenceFile, file],
  );
  assert.equal(
    await evaluate(() => document.querySelector('.doc-tab.active').title),
    referenceFile,
  );
  web.send('command', 'close-request');
  for (let i = 0; i < 120 && fixtures.closes() < 2; i++) await pause();
  assert.equal(fixtures.closes(), 2);
  assert.equal(await evaluate(() => !!document.querySelector('.close-session-dialog')), false);

  // A failed draft write must keep the window open and the remembered policy unchanged.
  await reload({ preference: 'ask', paths: [file], active: file });
  web.send('command', 'source');
  await wait(() => document.querySelector('.document-surface')?.dataset.documentMode === 'source');
  await evaluate(() => document.querySelector('.cm-content').focus());
  web.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['meta'] });
  web.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['meta'] });
  await web.insertText('\nGENERATED_UNSAVED_SESSION\n');
  await wait(() => !!document.querySelector('.unsaved-dot'));
  await requestClose();
  fixtures.failDrafts(true);
  await evaluate(() => document.querySelector('.close-session-remember input').click());
  await button(en ? 'Keep drafts and close' : '保留草稿并关闭');
  await wait(() => !!document.querySelector('.close-session-dialog [role="alert"]'));
  assert.equal(fixtures.closes(), 2);
  assert.equal((await prefs()).restoreTabs, 'ask');
  fixtures.failDrafts(false);
  await button(en ? 'Keep drafts and close' : '保留草稿并关闭');
  for (let i = 0; i < 120 && fixtures.closes() < 3; i++) await pause();
  assert.equal(fixtures.closes(), 3);
  assert.equal((await prefs()).restoreTabs, 'always');
  assert(fixtures.draft(file).content.includes('GENERATED_UNSAVED_SESSION'));
  await reload();
  await wait(() =>
    document.querySelector('.cm-content')?.textContent.includes('GENERATED_UNSAVED_SESSION'),
  );
  // Update restart is a one-time exception to never restore.
  await reload({
    preference: 'never',
    paths: [file, referenceFile],
    active: referenceFile,
    resumeOnce: true,
  });
  assert.equal(await evaluate(() => document.querySelectorAll('.doc-tab').length), 2);
  assert.equal((await snapshot()).resumeOnce, false);
  return {
    closeAll: true,
    remember: true,
    restoreOrderAndActive: true,
    draftFailureStaysOpen: true,
    draftsRecovered: true,
    finderOpen: true,
    updateRestart: true,
  };
}
module.exports = { verifyTabSession };
