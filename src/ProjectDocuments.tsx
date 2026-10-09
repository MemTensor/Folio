import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, MagnifyingGlass, X, ArrowsClockwise } from '@phosphor-icons/react';
import { bridge } from './bridge';
import { t } from './i18n';
import { FileSortControl } from './FileSortControl';
import {
  createProjectDocumentListing,
  emptyDocumentListing,
  loadDocumentSort,
  saveDocumentSort,
} from './project-documents.mjs';
import type { FileSortMode } from './sidebar-order.mjs';
import './ProjectDocuments.css';

export function ProjectDocuments({
  root,
  active,
  refresh,
  enabled,
  onOpen,
  onMenu,
}: {
  root: string;
  active: string;
  refresh: number;
  enabled: boolean;
  onOpen: (path: string) => void;
  onMenu: (path: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [includeArchives, setIncludeArchives] = useState(false),
    [sort, setSort] = useState<FileSortMode>(() => loadDocumentSort(localStorage)),
    [listing, setListing] = useState(emptyDocumentListing);
  const loader = useMemo(
    () =>
      createProjectDocumentListing(
        (scope, options) => bridge.documents(scope, options),
        (scope) => bridge.cancelDocuments(scope),
        setListing,
      ),
    [],
  );
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    saveDocumentSort(localStorage, sort);
  }, [sort]);
  useEffect(() => {
    if (!enabled || !root) {
      loader.close();
      return;
    }
    // Typing filters filenames only. A short debounce avoids one worker request
    // per keystroke; cancellation invalidates earlier results immediately.
    const timer = window.setTimeout(
      () => void loader.open(root, { query: query.trim(), includeArchives, sort, limit: 100 }),
      query ? 150 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      loader.close();
    };
  }, [root, query, includeArchives, sort, enabled, loader]);
  useEffect(() => {
    if (lastRefresh.current === refresh) return;
    lastRefresh.current = refresh;
    if (enabled) void loader.refresh(false);
  }, [refresh, enabled, loader]);
  useEffect(() => {
    if (!enabled) return;
    const focus = () => void loader.refresh(false);
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [enabled, loader]);
  return (
    <section className="project-documents" aria-label={t('项目文档')} aria-busy={listing.loading}>
      <div className="search-input project-document-search">
        <MagnifyingGlass size={15} aria-hidden="true" />
        <input
          aria-label={t('按文件名查找文档')}
          placeholder={t('查找文档名称…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {query && (
          <button aria-label={t('清除搜索')} onClick={() => setQuery('')}>
            <X size={13} />
          </button>
        )}
      </div>
      <div className="section-label file-section-label">
        <span className="file-section-title">
          {t('项目文档')}
          {!!listing.documents.length && (
            <span>
              {listing.documents.length}
              {listing.total > listing.documents.length && ` / ${listing.total}`}
            </span>
          )}
        </span>
        <FileSortControl value={sort} onChange={setSort} />
      </div>
      <div className="project-document-options">
        <button
          className={includeArchives ? 'selected' : ''}
          aria-pressed={includeArchives}
          onClick={() => setIncludeArchives((value) => !value)}
        >
          {t('包含备份与镜像')}
        </button>
        <button
          aria-label={t('刷新文档列表')}
          title={t('刷新文档列表')}
          disabled={listing.loading}
          onClick={() => void loader.refresh()}
        >
          <ArrowsClockwise size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="project-document-list">
        {listing.documents.map((document) => (
          <button
            key={document.path}
            className={'project-document-row ' + (active === document.path ? 'selected' : '')}
            title={document.relativePath}
            aria-current={active === document.path ? 'page' : undefined}
            onClick={() => onOpen(document.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(document.path);
            }}
          >
            <FileText size={17} aria-hidden="true" />
            <span>
              <strong>{document.name.replace(/\.(?:md|markdown|mdown)$/i, '')}</strong>
              <small>
                {document.relativePath.includes('/')
                  ? document.relativePath.slice(0, document.relativePath.lastIndexOf('/'))
                  : t('项目根目录')}
              </small>
            </span>
          </button>
        ))}
      </div>
      {listing.loading && (
        <div className="sidebar-empty project-document-message" role="status">
          <span>{listing.loadingMore ? t('正在加载更多文档…') : t('正在查找项目文档…')}</span>
          <button onClick={() => loader.cancel()}>{t('取消')}</button>
        </div>
      )}
      {listing.error && (
        <div className="sidebar-empty project-document-message" role="alert">
          <span>{t('无法读取文档列表。')}</span>
          <small>{t(listing.error)}</small>
          <button onClick={() => void loader.refresh()}>{t('重试')}</button>
        </div>
      )}
      {listing.cancelled && (
        <div className="sidebar-empty project-document-message" role="status">
          <span>{t('已停止查找。')}</span>
          <button onClick={() => void loader.refresh()}>{t('重新查找')}</button>
        </div>
      )}
      {!listing.loading && !listing.error && !listing.cancelled && !listing.documents.length && (
        <div className="sidebar-empty project-document-message" role="status">
          {query ? t('没有匹配的文档名称。') : t('尚未找到 Markdown 文档。')}
        </div>
      )}
      {listing.hasMore && !listing.cancelled && (
        <div className="project-document-pagination">
          <button disabled={listing.loading} onClick={() => void loader.loadMore()}>
            {t('加载更多')}
          </button>
        </div>
      )}
      {listing.limited && !listing.hasMore && !listing.loading && (
        <p className="project-document-hint" role="status">
          {t('项目较大，仅列出已发现的文档。可切换到文件夹，或打开更具体的项目目录。')}
        </p>
      )}
      {!includeArchives && listing.excluded && (
        <p className="project-document-hint">{t('已隐藏备份与镜像中的文档。')}</p>
      )}
    </section>
  );
}
