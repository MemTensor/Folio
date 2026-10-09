const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function verifyAgentPanel(window, original, capturePath, language) {
  const web = window.webContents;
  const evaluate = (fn, ...args) =>
    web.executeJavaScript(`(${fn})(${args.map((v) => JSON.stringify(v)).join(',')})`);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  async function wait(check) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(check)) return;
      await pause();
    }
    throw Error('Agent panel UI timed out.');
  }
  const en = language === 'en';
  const labels = {
    open: en ? 'Document assistant' : 'Agent 文档助手',
    connect: en ? 'Connect Codex' : '连接 Codex',
    send: en ? 'Send to agent' : '发送给 Agent',
    view: en ? 'Review changes' : '查看修改',
    accept: en ? 'Accept changes' : '接受修改',
    undo: en ? 'Undo changes' : '撤销修改',
    close: en ? 'Close agent panel' : '关闭 Agent 面板',
  };
  const clickLabel = async (label) => {
    const clicked = await evaluate((label) => {
      const root = document.querySelector('.folio-agent') || document;
      const button = [...root.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label,
      );
      if (!button || button.disabled) return false;
      button.click();
      return true;
    }, label);
    assert(clicked, 'Missing or disabled agent button: ' + label);
    await pause();
  };
  const toolbarBounds = () => {
    const { x, y, width, height } = document
      .querySelector('.editor-toolbar')
      .getBoundingClientRect();
    return { x, y, width, height };
  };
  const collapsedToolbar = await evaluate(toolbarBounds);
  await clickLabel(labels.open);
  await wait(() => !!document.querySelector('.folio-agent .agent-connect-card'));
  assert.deepEqual(
    await evaluate(toolbarBounds),
    collapsedToolbar,
    'Agent must not squeeze the toolbar.',
  );
  assert.equal(
    await evaluate(() => {
      const toolbar = document.querySelector('.editor-toolbar').getBoundingClientRect();
      const panel = document.querySelector('.folio-agent').getBoundingClientRect();
      return panel.top >= toolbar.bottom;
    }),
    true,
    'The sidebar must not cover document controls.',
  );
  const layout = await evaluate(() => {
    const panel = document.querySelector('.folio-agent'),
      compose = document.querySelector('.agent-composer');
    const a = panel.getBoundingClientRect(),
      b = compose.getBoundingClientRect();
    return {
      width: a.width,
      height: a.height,
      composerVisible: b.bottom < a.bottom,
      display: getComputedStyle(panel).display,
    };
  });
  assert.equal(layout.width, 374);
  assert(layout.height > 600);
  assert(layout.composerVisible);
  assert.equal(layout.display, 'flex');
  await clickLabel(labels.connect);
  await wait(() => !!document.querySelector('.agent-provider-button .agent-dot.ready'));
  await wait(() => !!document.querySelector('.agent-hint-loading'));
  assert.equal(
    await evaluate(() => document.querySelector('.agent-composer textarea').disabled),
    false,
  );
  if (capturePath) {
    await evaluate(() => {
      document.documentElement.dataset.theme = 'sepia';
    });
    await web.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + '-loading.png'),
      (await web.capturePage()).toPNG(),
      { flag: 'wx' },
    );
    await evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
  }
  await wait(() => document.querySelectorAll('.agent-starters button').length === 3);
  assert.equal(
    await evaluate(() => document.querySelector('.agent-starters button').textContent.trim()),
    'Clarify startup wording',
  );
  await evaluate(() => document.querySelector('.agent-starters button').click());
  await pause();
  assert.equal(
    await evaluate(() => document.querySelector('.agent-composer textarea').value),
    'Clarify the FOLIO_DESKTOP_SMOKE_BODY sentence in this document without inventing facts.',
  );
  assert.equal(
    await evaluate(() =>
      [...document.querySelectorAll('.folio-agent button')].some((b) =>
        ['断开连接', 'Disconnect'].includes(b.textContent.trim()),
      ),
    ),
    false,
  );
  await evaluate(() => {
    const field = document.querySelector('.agent-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      field,
      'RETRY_INTERRUPTED_FIXTURE',
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pause();
  await clickLabel(labels.send);
  await wait(() => !!document.querySelector('.agent-retry'));
  assert.equal(await evaluate(() => document.querySelector('.agent-composer textarea').value), '');
  await evaluate(() => document.querySelector('.agent-retry').click());
  await wait(() =>
    [...document.querySelectorAll('.agent-reply')].some((reply) =>
      reply.textContent.includes('Recovered generated request.'),
    ),
  );
  await evaluate(() => {
    const selector = document.querySelector('.agent-compose-footer select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(
      selector,
      'fixture-precise',
    );
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await evaluate(() => {
    const field = document.querySelector('.agent-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      field,
      'Inspect the rendered table and refine this generated sentence.',
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pause();
  await evaluate(() => {
    const selector = document.querySelector('.agent-effort');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(
      selector,
      'high',
    );
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await pause();
  assert.equal(await evaluate(() => !!document.querySelector('.agent-mode')), false);
  await clickLabel(labels.send);
  await wait(() => !!document.querySelector('.agent-proposal'));
  await wait(() => !!document.querySelector('.agent-sources'));
  await evaluate(() => document.querySelector('.agent-sources summary').click());
  assert.equal(
    await evaluate(() =>
      [...document.querySelectorAll('.agent-sources button')].some((button) =>
        button.textContent.includes('Reference.md'),
      ),
    ),
    true,
  );
  await evaluate(() =>
    [...document.querySelectorAll('.agent-sources button')]
      .find((button) => button.textContent.includes('Reference.md'))
      .click(),
  );
  await wait(() => document.querySelector('.doc-tab.active').textContent.includes('Reference'));
  await evaluate(() =>
    [...document.querySelectorAll('.doc-tab')]
      .find((tab) => tab.textContent.includes('Startup'))
      .click(),
  );
  await wait(() => document.querySelector('.doc-tab.active').textContent.includes('Startup'));
  const untouched = await evaluate(() =>
    document.querySelector('.cm-content').cmTile.root.view.state.doc.toString(),
  );
  assert.equal(untouched, original);
  assert.equal(await evaluate(() => !!document.querySelector('.agent-edit-list')), false);
  await clickLabel(labels.view);
  await wait(() => !!document.querySelector('.agent-diff-after'));
  assert.equal(await evaluate(() => !!document.querySelector('.agent-edit input:checked')), true);
  await wait(() => !!document.querySelector('.agent-reply [data-math-ready="true"]'));
  if (capturePath) {
    const image = await web.capturePage();
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + '-review.png'),
      image.toPNG(),
      { flag: 'wx' },
    );
  }
  await clickLabel(labels.accept);
  await wait(() =>
    document
      .querySelector('.cm-content')
      .cmTile.root.view.state.doc.toString()
      .includes('_REFINED'),
  );
  const messageCount = await evaluate(() => document.querySelectorAll('.agent-message').length);
  // Close long enough for the actual service to stop its runtime. Reopening
  // must automatically reconnect and ignore the stale IPC snapshot while
  // retaining the completed conversation and the accepted proposal.
  await clickLabel(labels.close);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await clickLabel(labels.open);
  assert.equal(await evaluate(() => !!document.querySelector('.agent-dot.ready')), true);
  await wait(() => !!document.querySelector('.agent-dot.ready'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(() => !!document.querySelector('.agent-dot.ready')), true);
  assert.equal(await evaluate(() => !!document.querySelector('.agent-connect-card')), false);
  assert.equal(await evaluate(() => document.querySelector('.agent-effort').value), 'high');
  assert.equal(
    await evaluate(() => document.querySelectorAll('.agent-message').length),
    messageCount,
  );
  await clickLabel(labels.undo);
  await wait(
    () =>
      !document
        .querySelector('.cm-content')
        .cmTile.root.view.state.doc.toString()
        .includes('_REFINED'),
  );
  assert.equal(
    await evaluate(() =>
      document.querySelector('.cm-content').cmTile.root.view.state.doc.toString(),
    ),
    original,
  );
  // A human edit during review makes the proposal obsolete rather than moving
  // its replacement to a different sentence or overwriting the new content.
  assert.equal(
    await evaluate(() => document.querySelector('.agent-compose-footer select').value),
    'fixture-precise',
  );
  await evaluate(() => {
    const field = document.querySelector('.agent-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      field,
      'Another generated revision.',
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pause();
  await clickLabel(labels.send);
  await wait(() => document.querySelectorAll('.agent-proposal').length === 2);
  await evaluate(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nHuman addition.\n' } });
  });
  await pause();
  const stale = await evaluate(
    () => [...document.querySelectorAll('.agent-proposal-actions .primary')].at(-1).disabled,
  );
  assert.equal(stale, true);
  await evaluate((original) => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
  }, original);
  await pause();
  await evaluate(() => document.querySelector('.cm-content').cmTile.root.view.focus());
  web.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['meta'] });
  web.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['meta'] });
  await wait(() => !document.querySelector('.window-title .unsaved-dot'));
  // Narrow windows show the panel above the document without squeezing it to
  // an unusable text column. Screenshot verifies the real themed layout.
  window.setSize(960, 850);
  await pause();
  assert.equal(
    await evaluate(() => getComputedStyle(document.querySelector('.folio-agent')).position),
    'absolute',
  );
  assert.equal(
    await evaluate(() => {
      const panel = document.querySelector('.folio-agent').getBoundingClientRect();
      const toolbar = document.querySelector('.editor-toolbar').getBoundingClientRect();
      const bar = document.querySelector('.document-bar').getBoundingClientRect();
      return (
        panel.top >= toolbar.bottom &&
        [...document.querySelectorAll('.document-actions button')].every((button) => {
          const box = button.getBoundingClientRect();
          return box.left >= bar.left && box.right <= bar.right && !button.disabled;
        })
      );
    }),
    true,
    'All important document actions must remain reachable in a narrow window.',
  );
  if (capturePath) {
    await web.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + '-narrow.png'),
      (await web.capturePage()).toPNG(),
      { flag: 'wx' },
    );
  }
  window.setSize(1200, 850);
  await pause();
  if (capturePath) {
    await evaluate(() => {
      document.documentElement.dataset.theme = 'sepia';
    });
    await web.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + '-sepia.png'),
      (await web.capturePage()).toPNG(),
      { flag: 'wx' },
    );
    await evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
  }
  const clickDocumentAction = async (label) => {
    assert.equal(
      await evaluate((label) => {
        const button = [...document.querySelectorAll('.document-actions button')].find(
          (button) => button.getAttribute('aria-label') === label,
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, label),
      true,
    );
    await pause();
  };
  await clickDocumentAction(en ? 'Review changes' : '改动审阅');
  await wait(() => !!document.querySelector('.review-panel'));
  assert.deepEqual(await evaluate(toolbarBounds), collapsedToolbar);
  await clickDocumentAction(en ? 'Version history' : '历史版本');
  await wait(() => !!document.querySelector('.history-panel'));
  await clickDocumentAction(en ? 'Publish or sync to DingTalk' : '发布或同步到钉钉');
  await wait(() => !!document.querySelector('.dingtalk-panel'));
  await evaluate(() => document.querySelector('.modal-heading .icon-button').click());
  await wait(() => !document.querySelector('.modal-backdrop'));
  await clickDocumentAction(labels.open);
  await wait(() => !!document.querySelector('.agent-dot.ready'));
  assert.equal(await evaluate(() => !!document.querySelector('.error-banner')), false);
  await clickLabel(en ? 'Agent settings' : 'Agent 设置');
  await wait(
    () =>
      !!document.querySelector('.agent-provider-options') &&
      !document.querySelectorAll('.agent-provider-options button')[1].disabled,
  );
  const previewContext = await evaluate(() => {
    const doc = document.querySelector('.document-surface');
    return { path: doc.dataset.documentPath, revision: Number(doc.dataset.documentRevision) };
  });
  const blockedPreview = await require('./../electron/agent-preview.cjs').captureDocumentPreview(
    window,
    previewContext,
  );
  assert.equal(blockedPreview.available, false, 'Modal UI must never be captured for the model.');
  await evaluate(() => document.querySelectorAll('.agent-provider-options button')[1].click());
  await evaluate((en) => {
    const values = [
      [en ? 'API base URL' : 'API 基础地址', 'https://generated-provider.invalid/v1'],
      ['Agent API Key', 'generated-api-key'],
      [en ? 'Model name' : '模型名称', 'fixture-api'],
    ];
    for (const [label, value] of values) {
      const input = document.querySelector('.agent-api-settings input[aria-label="' + label + '"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, en);
  await pause();
  await evaluate(
    (label) =>
      [...document.querySelectorAll('.agent-settings-actions button')]
        .find((b) => b.textContent.trim() === label)
        .click(),
    en ? 'Save and connect' : '保存并连接',
  );
  await wait(
    () =>
      document.querySelector('.agent-api-settings input[aria-label="Agent API Key"]').value === '',
  );
  assert.equal(
    await evaluate(
      () => document.querySelector('.agent-api-settings input[aria-label="Agent API Key"]').type,
    ),
    'password',
  );
  await evaluate(
    (label) =>
      [...document.querySelectorAll('.agent-settings-actions button')]
        .find((b) => b.textContent.trim() === label)
        .click(),
    en ? 'Check service' : '检测服务',
  );
  await wait(() => !!document.querySelector('#agent-api-models option[value="fixture-api"]'));
  assert.equal(
    await evaluate(() => !!document.querySelector('.agent-settings-disconnect button')),
    true,
  );
  if (capturePath) {
    await web.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const image = await web.capturePage();
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + '-settings.png'),
      image.toPNG(),
      { flag: 'wx' },
    );
  }
  await evaluate(() => document.querySelector('.modal-heading .icon-button').click());
  await wait(() => !document.querySelector('.modal-backdrop'));
  assert.equal(
    await evaluate(() =>
      [...document.querySelectorAll('.folio-agent button')].some((b) =>
        ['断开连接', 'Disconnect'].includes(b.textContent.trim()),
      ),
    ),
    false,
  );
  if (capturePath) {
    await evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await pause();
    const image = await web.capturePage();
    await fs.writeFile(
      path.join(path.dirname(capturePath), path.basename(capturePath, '.png') + '-dark.png'),
      image.toPNG(),
      { flag: 'wx' },
    );
    await evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
  }
  return {
    reviewBeforeApply: true,
    accepted: true,
    undone: true,
    staleBlocked: true,
    formulaRendered: true,
    responsive: true,
    reconnectAfterReopen: true,
    staleConnectionSnapshotIgnored: true,
    modelRemembered: true,
    apiSettingsConfigured: true,
    disconnectOnlyInSettings: true,
    documentHintsGenerated: true,
    automaticReplyRepair: true,
    reasoningEffortRemembered: true,
    interruptedRequestRetried: true,
    visualPreviewRequested: true,
    toolbarStableAcrossPanels: true,
    directDocumentActions: true,
    referenceSourcesDisplayedAndOpened: true,
  };
}
module.exports = { verifyAgentPanel };
