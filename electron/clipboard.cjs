const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;

function createClipboardWriter(clipboard) {
  return (text) => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES)
      throw Object.assign(Error('复制内容无效或过长。'), { code: 'CLIPBOARD_INPUT' });
    clipboard.writeText(text);
  };
}

function createRichClipboardWriter(clipboard) {
  return (content) => {
    if (
      !content ||
      typeof content !== 'object' ||
      Array.isArray(content) ||
      Object.keys(content).some((key) => !['text', 'html'].includes(key)) ||
      typeof content.text !== 'string' ||
      (content.html !== undefined && typeof content.html !== 'string') ||
      Buffer.byteLength(content.text, 'utf8') + Buffer.byteLength(content.html || '', 'utf8') >
        MAX_CLIPBOARD_BYTES
    )
      throw Object.assign(Error('复制内容无效或过长。'), { code: 'CLIPBOARD_INPUT' });
    clipboard.write({
      text: content.text,
      ...(content.html === undefined ? {} : { html: content.html }),
    });
  };
}
module.exports = { createClipboardWriter, createRichClipboardWriter, MAX_CLIPBOARD_BYTES };
