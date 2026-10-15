// Runs only the bundled generated fixture, never a user's workspace or profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'user-data'));
app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadFile(path.join(directory, 'fixture.html'));
      const code = await fs.readFile(path.join(directory, 'fixture.js'), 'utf8');
      await win.webContents.executeJavaScript(
        'try {' + code + '} catch(e) { window.fixtureError=String(e.stack); }',
      );
      const error = await win.webContents.executeJavaScript('window.fixtureError');
      assert(!error, error);
      const result = await win.webContents.executeJavaScript('window.reviewResults');
      assert.equal(result.asset.rawHtmlPreserved, false);
      assert.equal(result.copyImageOnly.markdown, '![Plot](assets/plot.png)');
      assert.equal(result.copyImageOnly.rich.text, '![Plot](assets/plot.png)');
      assert.equal(result.copyWholeParagraph.markdown, 'prefix ![Plot](assets/plot.png) suffix');
      assert.equal(result.agentSelection, '**bold** [link](https://example.invalid)');
      assert(result.taskWidgets.equal.every(Boolean));
      for (const sample of result.selectionPerformance) {
        assert(sample.trials.every((t) => t.parses === 0 && t.sanitizes === 0));
        assert.equal(sample.typing.parses, 1);
        assert.equal(sample.typing.sanitizes, 0);
      }
      console.log(
        JSON.stringify({
          ok: true,
          selectionPerformance: result.selectionPerformance,
          stableTasks: true,
          sourceMapping: true,
          imageCopies: true,
        }),
      );
    } finally {
      win.destroy();
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
