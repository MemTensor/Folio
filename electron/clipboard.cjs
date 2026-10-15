const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
let generation = 0;
let preparing;

function createClipboardWriter(clipboard) {
  return (text) => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES)
      throw Object.assign(Error('复制内容无效或过长。'), { code: 'CLIPBOARD_INPUT' });
    clipboard.writeText(text);
    generation++;
    preparing?.abort();
  };
}

function createRichClipboardWriter(clipboard, prepare) {
  const validate = (content) => {
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
  };
  return (content, documentPath) => {
    validate(content);
    const ticket = ++generation;
    preparing?.abort();
    const write = (value) => {
      validate(value);
      if (ticket !== generation) return;
      clipboard.write({
        text: value.text,
        ...(value.html === undefined ? {} : { html: value.html }),
      });
    };
    if (!prepare) return write(content);
    const controller = new AbortController();
    preparing = controller;
    const timer = setTimeout(() => controller.abort(Error('图片复制超时，请稍后重试。')), 5000);
    return Promise.race([
      Promise.resolve().then(() => prepare(content, documentPath, controller.signal)),
      new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        }),
      ),
    ])
      .then(write)
      .catch((error) => {
        if (ticket === generation) throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        if (preparing === controller) preparing = null;
      });
  };
}
module.exports = { createClipboardWriter, createRichClipboardWriter, MAX_CLIPBOARD_BYTES };
