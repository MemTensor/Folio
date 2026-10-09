import { t, localeTag, documentText } from './i18n';
import { renderMarkdown, renderDiagrams, escapeHTML } from './markdown';
export async function exportHTML(content: string, path: string) {
  const body = document.createElement('div');
  body.innerHTML = renderMarkdown(content, { path });
  await renderDiagrams(body, true);
  const failed = body.querySelector<HTMLElement>('.formula-error,[data-processed="error"]');
  if (failed)
    throw Error(
      t('请先修正公式或图表语法，再导出：') +
        (failed.title || failed.textContent || '').slice(0, 180),
    );
  body.querySelectorAll('input').forEach((n) => n.setAttribute('disabled', ''));
  const maths = Array.from(body.querySelectorAll<HTMLElement>('[data-math-source]')).map((n) => ({
    source: n.dataset.mathSource || '',
    svg: n.querySelector('svg')?.outerHTML || '',
  }));
  const diagrams = Array.from(body.querySelectorAll('.mermaid svg')).map((n) => n.outerHTML);
  const style = `body{max-width:800px;margin:40px auto;padding:0 24px;color:#303033;font:16px/1.8 -apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC',sans-serif}h1,h2{border-bottom:1px solid #e8e8e8;padding-bottom:.25em;line-height:1.4}h1{font-size:30px}h2{font-size:24px;margin-top:1.5em}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f7f7f7}[align=center]{text-align:center}[align=right]{text-align:right}[align=left]{text-align:left}thead{display:table-header-group}tr{break-inside:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f6f6f6;border:1px solid #eee;border-radius:4px;font:13px/1.6 monospace}code{background:#f6f6f6;font-family:monospace}pre code{background:none}blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:18px;color:#777}img{max-width:100%;height:auto;display:block;margin:20px auto}a{color:#49715b}mark{background:#f7edb8}.task-list-item{list-style:none}input{margin-left:-20px;margin-right:8px}.math-preview{text-align:center;overflow:hidden;padding:15px 0}.math-preview svg{max-width:100%;height:auto;min-height:1.5em}.formula-inline.math-preview{display:block}.formula-inline svg{vertical-align:middle;max-width:100%}.mermaid{background:none;border:0;text-align:center;white-space:normal}.mermaid svg{max-width:100%;height:auto}.frontmatter{color:#888}.frontmatter>span{display:block;font:11px sans-serif;margin-bottom:5px}.toc-preview a{display:block;text-decoration:none}.toc-preview a.toc-level-2{padding-left:14px}.toc-preview a.toc-level-3{padding-left:28px}.toc-preview a.toc-level-4{padding-left:42px}.toc-preview a.toc-level-5{padding-left:56px}.toc-preview a.toc-level-6{padding-left:70px}.image-unloaded{color:#888;font-size:12px}.callout{background:#f1f5ef;padding:8px 14px}.callout-label{margin-right:6px}.footnotes{font-size:13px}@media print{body{margin:0;max-width:none}pre,img,.math-preview,.mermaid{break-inside:avoid}h1,h2,h3{break-after:avoid}a{color:inherit;text-decoration:none}}`;
  return {
    diagrams,
    maths,
    html: `<!doctype html><html lang="${localeTag()}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><title>${escapeHTML(path.split('/').pop() || documentText('文档', 'Document'))}</title><style>${style}</style></head><body>${body.innerHTML}</body></html>`,
  };
}
