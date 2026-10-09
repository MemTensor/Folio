const { BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { printHTML, withDeadline } = require('../core/desktop-policy.cjs');
async function printPDF(html, target, tempRoot) {
  const dir = await fs.mkdtemp(path.join(tempRoot, 'folio-print-'));
  const file = path.join(dir, 'document.html'),
    url = pathToFileURL(file).href;
  const isolated = session.fromPartition('folio-print-' + crypto.randomUUID());
  let window;
  try {
    await fs.writeFile(file, printHTML(html), { mode: 0o600 });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: details.url !== url || details.resourceType !== 'mainFrame' }),
    );
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await withDeadline(
      () => window.loadFile(file),
      20000,
      '导出文档加载超时，请检查图片或缩小文档后重试。',
    );
    await withDeadline(
      () =>
        window.webContents.executeJavaScript(
          `Promise.all([document.fonts.ready,...Array.from(document.images).map(image=>image.complete?(image.naturalWidth?Promise.resolve():Promise.reject(Error('图片加载失败'))):new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('图片加载失败'));}))])`,
        ),
      15000,
      '字体和图片加载超时，请检查图片或缩小文档后重试。',
    );
    const bytes = await withDeadline(
      () =>
        window.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
        }),
      30000,
      '生成 PDF 超时，请检查图片或缩小文档后重试。',
    );
    await fs.writeFile(target, bytes);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    isolated.webRequest.onBeforeRequest(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
module.exports = { printPDF };
