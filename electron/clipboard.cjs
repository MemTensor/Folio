const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;

function createClipboardWriter(clipboard) {
  return (text) => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES)
      throw Object.assign(Error('复制内容无效或过长。'), { code: 'CLIPBOARD_INPUT' });
    clipboard.writeText(text);
  };
}

module.exports = { createClipboardWriter, MAX_CLIPBOARD_BYTES };
