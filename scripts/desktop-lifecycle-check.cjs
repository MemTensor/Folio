const assert = require('node:assert/strict');
async function verifyDocumentLifecycle(window, controls) {
  const { file, referenceFile, researchFile, language } = controls;
  const evaluate = (fn, ...args) =>
    window.webContents.executeJavaScript(
      '(' + fn + ')(' + args.map(JSON.stringify).join(',') + ')',
    );
  const wait = async (check) => {
    for (let i = 0; i < 120; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error('Document lifecycle did not reach the expected state.');
  };
  const active = (path) =>
    evaluate((p) => document.querySelector('.document-surface')?.dataset.documentPath === p, path);
  const select = async (p) => {
    await evaluate(
      (path) => [...document.querySelectorAll('.doc-tab')].find((b) => b.title === path).click(),
      p,
    );
    await wait(() => active(p));
  };
  // Disable autosave in this generated fixture. Recovery drafts still run.
  await evaluate(() =>
    localStorage.setItem(
      'folio-preferences',
      JSON.stringify({
        ...JSON.parse(localStorage.getItem('folio-preferences') || '{}'),
        autoSave: false,
      }),
    ),
  );
  await window.loadURL('folio://app/index.html');
  await wait(() => active(file));
  controls.holdResearch();
  window.webContents.send('command', 'home');
  await wait(() => evaluate(() => !!document.querySelector('.project-home')));
  await evaluate(() =>
    [...document.querySelectorAll('.recent-document')]
      .find((b) => b.textContent.includes('Research'))
      .click(),
  );
  await wait(() => controls.researchStarted());
  await evaluate(
    (english) =>
      [...document.querySelectorAll('.project-home button')]
        .find((b) => b.textContent.trim() === (english ? 'Back to document' : '返回文档'))
        .click(),
    language === 'en',
  );
  await wait(controls.nativeRestored);
  controls.releaseResearch();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(await active(file), 'Canceled recent document must not become active.');
  window.webContents.send('open-request', {
    root: require('node:path').dirname(file),
    path: referenceFile,
  });
  await wait(() => active(referenceFile));
  await select(file);
  await evaluate(
    (english) =>
      [...document.querySelectorAll('.view-switch button')]
        .find((b) => b.textContent === (english ? 'Source' : '源码'))
        .click(),
    language === 'en',
  );
  await evaluate(() => {
    const input = document.querySelector('input[type=file]'),
      data = new DataTransfer();
    data.items.add(new File(['generated image bytes'], 'generated.png', { type: 'image/png' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(controls.imageStarted);
  await select(referenceFile);
  controls.releaseImage();
  await wait(() =>
    evaluate(
      () =>
        document.querySelector('.toast')?.textContent.includes('image') ||
        document.querySelector('.toast')?.textContent.includes('图片'),
    ),
  );
  assert.equal(
    await evaluate(() =>
      document.querySelector('.cm-content')?.textContent.includes('assets/generated.png'),
    ),
    false,
  );
  // Open the third tab explicitly: the canceled open must not have created it.
  window.webContents.send('command', 'home');
  await wait(() => evaluate(() => !!document.querySelector('.project-home')));
  await evaluate(() =>
    [...document.querySelectorAll('.recent-document')]
      .find((b) => b.textContent.includes('Research'))
      .click(),
  );
  await wait(() => active(researchFile));
  controls.contextAction('close-others');
  await evaluate(
    (path) =>
      [...document.querySelectorAll('.doc-tab')]
        .find((b) => b.title === path)
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
        ),
    file,
  );
  await wait(() => evaluate(() => document.querySelectorAll('.doc-tab').length === 1));
  assert(await active(file));
  assert.equal(await evaluate(() => document.querySelectorAll('.doc-tab.active').length), 1);
  return { canceledOpen: true, imageTargetProtected: true, remainingTabActive: true };
}
module.exports = { verifyDocumentLifecycle };
