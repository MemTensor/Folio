import { formulaSVG, setMathLoader } from '../core/math.mjs';
import DOMPurify from 'dompurify';
const fonts = import.meta.glob('/node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js');
setMathLoader((name: string) => {
  const filename = name.split('/').pop();
  const load = fonts['/node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/' + filename];
  if (!load) throw Error('未打包的公式字体：' + filename);
  return load();
});
const cache = new Map<string, Promise<string>>();
export async function typesetMath(root: HTMLElement) {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>('[data-math-source]:not([data-math-ready])'),
  );
  for (const node of nodes) {
    const source = node.dataset.mathSource || '',
      display = node.dataset.mathDisplay === 'true',
      key = String(display) + source;
    try {
      if (!cache.has(key)) cache.set(key, formulaSVG(source, display));
      const svg = await cache.get(key)!;
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
      node.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      node.dataset.mathReady = 'true';
    } catch (e) {
      node.dataset.mathReady = 'error';
      node.classList.add('formula-error');
      node.textContent = source;
      node.title = e instanceof Error ? e.message : String(e);
    }
  }
}
