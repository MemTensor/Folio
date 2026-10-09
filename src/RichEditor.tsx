import { t, documentText } from './i18n';
import { useState, useEffect, useRef } from 'react';
import { Modal } from './App';
import { renderMarkdown, renderDiagrams } from './markdown';
import { formulaEditorBody, formulaEditorMarkdown } from './formula-editor.mjs';
export function RichEditor({
  kind,
  raw,
  onApply,
  onClose,
  applyError,
}: {
  kind: 'math' | 'diagram';
  raw: string;
  onApply: (value: string) => void;
  onClose: () => void;
  applyError?: string;
}) {
  const unwrap = (s: string) =>
    kind === 'math' ? formulaEditorBody(s) : s.trim().replace(/^```mermaid\s*|\s*```$/g, '');
  const [source, setSource] = useState(unwrap(raw)),
    [problem, setProblem] = useState(''),
    [busy, setBusy] = useState(true);
  const preview = useRef<HTMLDivElement>(null);
  const wrapped = (s: string) =>
    kind === 'math' ? formulaEditorMarkdown(raw, s) : '```mermaid\n' + s + '\n```';
  const presets =
    kind === 'math'
      ? [
          [
            t('分式'),
            '\\frac{\\partial \\mathcal{L}}{\\partial \\theta} = \\frac{1}{N}\\sum_{i=1}^{N}\\nabla_\\theta \\ell_i',
          ],
          [t('矩阵'), 'A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'],
          [
            t('多行对齐'),
            '\\begin{aligned}\nf(x) &= (x+1)^2 \\\\\n     &= x^2 + 2x + 1\n\\end{aligned}',
          ],
          [t('分段函数'), 'f(x) = \\begin{cases} x^2 & x \\ge 0 \\\\ -x & x < 0 \\end{cases}'],
          [t('带编号'), '\\int_0^1 x^2 \\, dx = \\frac{1}{3} \\tag{1}'],
        ]
      : [
          [
            t('流程图'),
            documentText(
              'flowchart LR\n  A[想法] --> B[写作]\n  B --> C{审阅}\n  C -->|通过| D[发布]\n  C -->|修改| B',
              'flowchart LR\n  A[Idea] --> B[Draft]\n  B --> C{Review}\n  C -->|Approved| D[Publish]\n  C -->|Changes| B',
            ),
          ],
          [
            t('时序图'),
            documentText(
              'sequenceDiagram\n  participant H as 人类\n  participant A as AI Agent\n  H->>A: 请求修改\n  A-->>H: 提交文档\n  H->>H: 审阅与合并',
              'sequenceDiagram\n  participant H as Human\n  participant A as AI Agent\n  H->>A: Request changes\n  A-->>H: Submit document\n  H->>H: Review and merge',
            ),
          ],
          [
            t('甘特图'),
            documentText(
              'gantt\n  title 写作计划\n  dateFormat YYYY-MM-DD\n  section 文档\n  初稿 :a, 2026-09-15, 3d\n  审阅 :after a, 2d',
              'gantt\n  title Writing plan\n  dateFormat YYYY-MM-DD\n  section Document\n  Draft :a, 2026-09-15, 3d\n  Review :after a, 2d',
            ),
          ],
          [
            t('饼图'),
            documentText(
              'pie title 内容分布\n  "正文" : 60\n  "图表" : 25\n  "附录" : 15',
              'pie title Content mix\n  "Body" : 60\n  "Diagrams" : 25\n  "Appendix" : 15',
            ),
          ],
        ];
  useEffect(() => {
    let current = true;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const holder = document.createElement('div');
        holder.innerHTML = renderMarkdown(wrapped(source));
        await renderDiagrams(holder, true);
        if (current && preview.current) {
          preview.current.replaceChildren(...Array.from(holder.childNodes));
          const failure = preview.current.querySelector<HTMLElement>(
            '.formula-error,[data-processed="error"]',
          );
          setProblem(failure?.title || '');
          setBusy(false);
        }
      } catch (e) {
        if (current) {
          setProblem(String(e));
          setBusy(false);
        }
      }
    }, 220);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [source]);
  return (
    <Modal
      title={kind === 'math' ? t('公式编辑器') : t('Mermaid 图表编辑器')}
      onClose={onClose}
      wide
    >
      <div className="rich-editor">
        <div className="rich-presets">
          <span>{t('快速插入')}</span>
          {presets.map(([label, value]) => (
            <button key={label} onClick={() => setSource(value)}>
              {label}
            </button>
          ))}
        </div>
        <textarea
          autoFocus
          spellCheck={false}
          aria-label={kind === 'math' ? t('LaTeX 公式源码') : t('Mermaid 图表源码')}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <div className="rich-preview-label">
          {busy
            ? t('正在排版…')
            : t('即时预览 · ') + (kind === 'math' ? t('MathJax · 矢量公式') : 'Mermaid')}
        </div>
        <div ref={preview} className="rich-preview markdown-body" />
        {(problem || applyError) && (
          <p className="rich-error" role="alert">
            {problem || applyError}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <span className="subtle">{t('源码将原样保存为 Markdown。')}</span>
        <span className="spacer" />
        <button onClick={onClose}>{t('取消')}</button>
        <button
          className="primary"
          disabled={busy || !!problem || !source.trim()}
          onClick={() => onApply(wrapped(source))}
        >
          {t('应用到文档')}
        </button>
      </div>
    </Modal>
  );
}
