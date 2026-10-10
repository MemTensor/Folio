import { t } from './i18n';
import {
  Component,
  forwardRef,
  memo,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { renderMarkdown } from './markdown';
import { registerCopySource } from './reading-copy';

export class PreviewBoundary extends Component<
  { resetKey: string; onSource: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="panel-empty" role="alert">
        <h3>{t('这份文档暂时无法预览')}</h3>
        <p>{t('原文仍然保留。切换到源码可以继续阅读和修改。')}</p>
        <button className="primary" onClick={this.props.onSource}>
          {t('切换到源码')}
        </button>
      </div>
    );
  }
}

// Rendering a document is a full parse plus sanitise. Without memo it repeated on
// every unrelated state change in the application, including each progress tick
// while an update downloads.
export const ReadingContent = memo(
  forwardRef<
    HTMLElement,
    ComponentPropsWithoutRef<'article'> & { content: string; path: string; remoteImages: boolean }
  >(({ content, path, remoteImages, ...props }, ref) => {
    const html = useMemo(
      () =>
        renderMarkdown(content, { path, remoteImages, imageControls: true, copySource: content }),
      [content, path, remoteImages],
    );
    return (
      <article
        {...props}
        ref={(node) => {
          if (node) registerCopySource(node, () => ({ from: 0, to: content.length, raw: content }));
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }),
);
