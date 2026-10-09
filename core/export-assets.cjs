const fs = require('node:fs/promises');
const path = require('node:path');
const mime = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};
async function embedLocalImages(html, store) {
  const matches = [...html.matchAll(/src="(folio-asset:[^"]+)"/g)];
  let total = 0;
  for (const match of matches) {
    const url = new URL(match[1].replaceAll('&amp;', '&'));
    const file = await store.safe(url.searchParams.get('path'));
    const type = mime[path.extname(file).toLowerCase()];
    if (!type) throw Error('无法导出这种图片类型。');
    const stat = await fs.stat(file);
    total += stat.size;
    if (total > 80 * 1024 * 1024) throw Error('图片总量超过 80 MB，请压缩图片后导出。');
    const data = await fs.readFile(file);
    html = html.replace(match[0], `src="data:${type};base64,${data.toString('base64')}"`);
  }
  return html;
}
module.exports = { embedLocalImages };
