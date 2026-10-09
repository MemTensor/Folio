const PRINT_MAX_BYTES = 120 * 1024 * 1024;
const PRINT_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
function desktopCloudOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('云配置参数无效。');
  if (Object.keys(input).some((key) => !['apiKey', 'clearKey'].includes(key)))
    throw Error('桌面界面仅支持设置或清除 API Key。高级连接配置请通过 CLI 设置。');
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== 'string' || input.apiKey.length > 4096)
  )
    throw Error('API Key 格式无效。');
  if (input.clearKey !== undefined && typeof input.clearKey !== 'boolean')
    throw Error('清除凭据参数无效。');
  return { apiKey: input.apiKey, clearKey: input.clearKey === true };
}
function printHTML(html, maxBytes = PRINT_MAX_BYTES) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > maxBytes)
    throw Error('导出内容过大，请压缩图片或拆分文档。');
  // The first CSP applies even if a compromised renderer omits its own policy.
  return (
    '<!doctype html><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' +
    PRINT_CSP +
    '">' +
    html
  );
}
// The caller passes the whole sentence rather than a fragment to prepend: a message
// assembled here would match no dictionary entry and stay Chinese in an English window.
async function withDeadline(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { desktopCloudOptions, printHTML, withDeadline, PRINT_MAX_BYTES, PRINT_CSP };
