const fs = require('node:fs/promises'),
  path = require('node:path');
const { initWasm, Resvg } = require('@resvg/resvg-wasm');
let ready, fonts;
async function fallbackFonts() {
  if (!fonts)
    fonts = (async () => {
      const files =
        process.platform === 'darwin'
          ? [
              '/System/Library/Fonts/Supplemental/Arial.ttf',
              '/System/Library/Fonts/STHeiti Medium.ttc',
            ]
          : process.platform === 'win32'
            ? [
                path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'),
                path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'simsun.ttc'),
              ]
            : [
                '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
              ];
      const data = await Promise.all(files.map((file) => fs.readFile(file).catch(() => null)));
      if (!data[1])
        throw Error('此公式包含需系统字体渲染的文字，请在安装了中文字体的桌面环境发布。');
      return data.filter(Boolean);
    })();
  return fonts;
}
async function svgPng(svg, width) {
  if (!ready)
    ready = (async () => {
      let bytes;
      try {
        bytes = await fs.readFile(path.join(__dirname, 'resvg.wasm'));
      } catch {
        bytes = await fs.readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
      }
      await initWasm(bytes);
    })();
  await ready;
  const font = /<text\b/.test(svg)
    ? {
        fontBuffers: await fallbackFonts(),
        defaultFontFamily: process.platform === 'darwin' ? 'Arial' : 'DejaVu Sans',
      }
    : { loadSystemFonts: false };
  const renderer = new Resvg(svg, {
    font,
    background: '#ffffff',
    fitTo: { mode: 'width', value: Math.max(1, Math.ceil(width)) },
  });
  let rendered;
  try {
    rendered = renderer.render();
    return Buffer.from(rendered.asPng());
  } finally {
    rendered?.free();
    renderer.free();
  }
}
module.exports = { svgPng };
