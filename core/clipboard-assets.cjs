const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const types = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};
const invalid = () => Object.assign(Error('复制内容无效或过长。'), { code: 'CLIPBOARD_INPUT' });
async function embedClipboardAssets(content, documentPath, workspaces, signal) {
  const check = () => signal?.throwIfAborted();
  check();
  if (!content.html?.includes('folio-asset:')) return content;
  const { store } = await workspaces.forPath(documentPath, { missing: true });
  const matches = [...content.html.matchAll(/src="(folio-asset:[^"]+)"/g)];
  if (matches.length > 20) throw invalid();
  let html = content.html,
    remaining = 3 * 1024 * 1024;
  const cache = new Map();
  for (const match of matches) {
    check();
    let data = cache.get(match[1]);
    if (!data) {
      const url = new URL(match[1].replaceAll('&amp;', '&'));
      if (url.hostname !== 'local' || url.searchParams.get('document') !== documentPath)
        throw invalid();
      const target = await store.safe(url.searchParams.get('path'));
      const type = types[path.extname(target).toLowerCase()];
      if (!type) throw invalid();
      const handle = await fs.open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        check();
        const before = await handle.stat();
        if (!before.isFile() || before.size > remaining) throw invalid();
        const bytes = Buffer.alloc(before.size + 1);
        let used = 0;
        for (;;) {
          check();
          const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
          used += bytesRead;
          if (!bytesRead || used === bytes.length) break;
        }
        const after = await handle.stat(),
          current = await fs.stat(await store.safe(target));
        check();
        if (
          used !== before.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          current.ino !== after.ino ||
          current.dev !== after.dev
        )
          throw invalid();
        remaining -= used;
        data = `data:${type};base64,${bytes.subarray(0, used).toString('base64')}`;
        cache.set(match[1], data);
      } finally {
        await handle.close();
      }
    }
    html = html.replace(match[0], `src="${data}"`);
  }
  return { ...content, html };
}
module.exports = { embedClipboardAssets };
