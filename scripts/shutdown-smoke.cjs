const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.setPath('userData', process.argv[2]);
app.disableHardwareAcceleration();
require('../electron/shutdown.cjs').installShutdown(app, async () => {
  await fs.mkdir(process.argv[2], { recursive: true });
  await fs.writeFile(path.join(process.argv[2], 'drained'), 'done');
});
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  app.quit();
});
