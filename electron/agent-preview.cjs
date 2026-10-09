const MAX_BYTES = 1024 * 1024;
const unavailable = (reason) => ({ available: false, reason, viewportOnly: true });

async function captureDocumentPreview(window, input) {
  if (!window || window.isDestroyed()) return unavailable('The document window is unavailable.');
  const inspect = () =>
    window.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector('.document-surface');
    if (!doc || document.querySelector('.modal-backdrop,.project-home,.first-run')) return null;
    const box = doc.getBoundingClientRect();
    let right = Math.min(innerWidth, box.right);
    for (const panel of document.querySelectorAll('.folio-agent,.right-panel')) {
      const p = panel.getBoundingClientRect();
      if (p.left > box.left && p.left < right && p.bottom > box.top && p.top < box.bottom) right = p.left;
    }
    const x = Math.max(0, Math.ceil(box.left)), y = Math.max(0, Math.ceil(box.top));
    const width = Math.floor(right - x), height = Math.floor(Math.min(innerHeight, box.bottom) - y);
    return { path: doc.dataset.documentPath, revision: Number(doc.dataset.documentRevision), mode: doc.dataset.documentMode, rect: { x, y, width, height } };
  })()`);
  const before = await inspect();
  if (
    !before ||
    before.path !== input.path ||
    before.revision !== input.revision ||
    !['live', 'read'].includes(before.mode) ||
    before.rect.width < 100 ||
    before.rect.height < 100
  )
    return unavailable(
      'A matching visible writing or reading view is not available. Use the supplied Markdown; do not infer unseen rendering.',
    );
  let image = await window.webContents.capturePage(before.rect);
  const after = await inspect();
  if (JSON.stringify(before) !== JSON.stringify(after))
    return unavailable('The document view changed during capture.');
  if (image.getSize().width > 1200) image = image.resize({ width: 1200, quality: 'good' });
  let bytes = image.toPNG();
  if (bytes.length > MAX_BYTES) {
    image = image.resize({ width: Math.min(800, image.getSize().width), quality: 'good' });
    bytes = image.toPNG();
  }
  if (bytes.length > MAX_BYTES) return unavailable('This visible preview is too large.');
  return {
    available: true,
    image: 'data:image/png;base64,' + bytes.toString('base64'),
    viewportOnly: true,
    mode: before.mode,
    revision: before.revision,
    width: image.getSize().width,
    height: image.getSize().height,
  };
}
module.exports = { captureDocumentPreview };
