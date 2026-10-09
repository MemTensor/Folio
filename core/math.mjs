import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { DefaultFont } from '@mathjax/src/js/output/svg/DefaultFont.js';
import { MathJaxMhchemFontExtension } from '@mathjax/mathjax-mhchem-font-extension/js/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/js/input/tex/cancel/CancelConfiguration.js';
import '@mathjax/src/js/input/tex/braket/BraketConfiguration.js';
import '@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js';
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
DefaultFont.addExtension(MathJaxMhchemFontExtension);
mathjax.asyncLoad = (name) => import(/* @vite-ignore */ name);
export function setMathLoader(loader) {
  mathjax.asyncLoad = loader;
}
export async function formulaSVG(source, display = true) {
  if (source.length > 30000) throw Error('公式超过 30,000 个字符，请拆分后编辑。');
  const tex = new TeX({
    packages: [
      'base',
      'ams',
      'newcommand',
      'configmacros',
      'mathtools',
      'cancel',
      'braket',
      'mhchem',
    ],
    maxBuffer: 50000,
    maxMacros: 2000,
    tags: 'none',
    formatError: (_jax, error) => {
      throw Error(error.message);
    },
  });
  const svg = new SVG({ fontCache: 'none' });
  const document = mathjax.document('', { InputJax: tex, OutputJax: svg });
  const output = await mathjax.handleRetriesFor(() =>
    document.convert(source, { display, em: 16, ex: 8, containerWidth: 1000 }),
  );
  return adaptor.innerHTML(output);
}
