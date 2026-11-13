/** @param {string} src @param {{path?:string,remoteImages?:boolean}} env */
export function imageURL(src, env) {
  if (/^https?:/i.test(src)) return env.remoteImages ? src : '';
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) return src;
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || !env.path) return '';
  try {
    const normalized = env.path.replaceAll('\\', '/');
    const drive = /^[A-Za-z]:\//.test(normalized);
    const documentPath = (drive ? '/' : '') + normalized;
    const base = documentPath
      .slice(0, documentPath.lastIndexOf('/') + 1)
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const pathname = new URL(src, 'https://local' + base).pathname;
    const decoded = decodeURIComponent(pathname);
    const target = drive && /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
    return `folio-asset://local/?path=${encodeURIComponent(target)}&document=${encodeURIComponent(env.path)}`;
  } catch {
    return '';
  }
}
