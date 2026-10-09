/** @param {string} src @param {{path?:string,remoteImages?:boolean}} env */
export function imageURL(src, env) {
  if (/^https?:/i.test(src)) return env.remoteImages ? src : '';
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || !env.path) return '';
  try {
    const base = env.path
      .slice(0, env.path.lastIndexOf('/') + 1)
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const pathname = new URL(src, 'https://local' + base).pathname;
    return `folio-asset://local/?path=${encodeURIComponent(decodeURIComponent(pathname))}`;
  } catch {
    return '';
  }
}
