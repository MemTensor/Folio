import { t, localeTag, errorMessage } from './i18n';
import { useEffect, useState } from 'react';
import { FileText, FolderOpen, MagnifyingGlass, ArrowUpRight } from '@phosphor-icons/react';
import { bridge } from './bridge';
interface Project {
  id: string;
  root: string;
  name: string;
}
interface Entry {
  path: string;
  name: string;
  projectName: string;
  relativePath: string;
  modifiedAt: number;
  match?: { text: string } | null;
}
interface LibraryData {
  projects: Project[];
  documents: Entry[];
  total: number;
  hasMore?: boolean;
  unavailable?: string[];
  blocked?: string[];
  partialProjects?: string[];
  index?: { skipped: number; limited?: boolean };
}
const pageSize = 100;
export function DocumentLibrary({
  openDocument,
  openFolder,
  removeProject,
}: {
  openDocument: (path: string) => Promise<void>;
  openFolder: () => Promise<void>;
  removeProject?: (project: Project) => Promise<void>;
}) {
  const [query, setQuery] = useState(''),
    [project, setProject] = useState(''),
    [page, setPage] = useState(0),
    [refresh, setRefresh] = useState(0),
    [paused, setPaused] = useState(false);
  const [data, setData] = useState<LibraryData>({ projects: [], documents: [], total: 0 }),
    [busy, setBusy] = useState(true),
    [opening, setOpening] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (paused) return;
    let active = true;
    setBusy(true);
    const timer = setTimeout(
      () =>
        bridge
          .librarySnapshot({
            query,
            projectId: project || undefined,
            offset: page * pageSize,
            limit: pageSize,
          })
          .then((result) => {
            if (active) {
              setData(result);
              setError('');
            }
          })
          .catch((e) => {
            if (active) setError(errorMessage(e));
          })
          .finally(() => {
            if (active) setBusy(false);
          }),
      query ? 250 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
      void bridge.libraryCancel().catch(() => {});
    };
  }, [query, project, page, refresh, paused]);
  useEffect(() => {
    if (paused) return;
    const off = bridge.onTree(() => setRefresh((n) => n + 1));
    const timer = setInterval(() => setRefresh((n) => n + 1), 30000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [paused]);
  const run = async (fn: () => Promise<void>) => {
    if (opening) return;
    setOpening(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  };
  const selected = data.projects.find((p) => p.id === project);
  return (
    <div className="document-library">
      <div className="library-controls">
        <div className="library-search">
          <MagnifyingGlass size={17} />
          <input
            autoFocus
            aria-label={t('跨项目查找文档')}
            placeholder={t('查找文件名或文档内容…')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
              setPaused(false);
            }}
          />
        </div>
        <select
          aria-label={t('项目范围')}
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setPage(0);
            setPaused(false);
          }}
        >
          <option value="">{t('所有已打开的项目')}</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {data.projects.filter((other) => other.name === p.name).length > 1
                ? p.root.split('/').slice(-2).join('/')
                : p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="library-caption">
        <span>
          {paused
            ? t('查找已暂停')
            : busy
              ? t('正在查找…')
              : query
                ? t('{0} 份匹配文档', { '0': data.total })
                : t('最近打开或更新 · {0} 份文档', { '0': data.total })}
        </span>
        {busy && !paused && (
          <button
            onClick={() => {
              setPaused(true);
              setBusy(false);
            }}
          >
            {t('取消查找')}
          </button>
        )}
        {paused && <button onClick={() => setPaused(false)}>{t('继续查找')}</button>}
        <button disabled={opening} onClick={() => void run(openFolder)}>
          <FolderOpen size={14} />
          {t('打开其他文件夹')}
        </button>
      </div>
      {selected && removeProject && (
        <div className="library-caption">
          <span title={selected.root}>
            {selected.name} {t('· 原始文件保留')}
          </span>
          <button
            disabled={opening}
            onClick={() =>
              void run(async () => {
                await removeProject(selected);
                setProject('');
                setPage(0);
                setPaused(false);
                setRefresh((n) => n + 1);
              })
            }
          >
            {t('从文档库移除')}
          </button>
        </div>
      )}
      {error && (
        <p className="knowledge-error" role="alert">
          {t(error)}
        </p>
      )}
      {!!data.blocked?.length && (
        <p className="library-unavailable">
          {t(
            '有 {count} 个范围过大的目录已暂停索引。请选择具体项目文件夹；旧目录可在项目范围中选中后移除。',
            { count: data.blocked.length },
          )}
        </p>
      )}
      {data.index?.limited && (
        <p className="library-unavailable" role="status">
          {t('此范围较大，当前结果可能不完整。请选择更具体的项目缩小查找范围。')}
        </p>
      )}
      <div className="library-list" aria-busy={busy}>
        {data.documents.map((d) => (
          <button
            key={d.path}
            title={d.path}
            disabled={opening}
            className="library-document"
            onClick={() => void run(() => openDocument(d.path))}
          >
            <FileText size={20} />
            <span>
              <strong>{d.name}</strong>
              <small>
                {d.projectName} · {d.relativePath}
              </small>
              {d.match && <p>{d.match.text}</p>}
            </span>
            <time>
              {new Date(d.modifiedAt).toLocaleString(localeTag(), {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            <ArrowUpRight size={13} />
          </button>
        ))}
        {!busy && !data.documents.length && (
          <div className="panel-empty">
            <p>
              {query ? t('没有找到匹配文档。') : t('打开一个项目文件夹，文档会自动出现在这里。')}
            </p>
          </div>
        )}
      </div>
      {(data.total > pageSize || page > 0) && (
        <div className="library-pagination">
          <button disabled={busy || page === 0} onClick={() => setPage((p) => p - 1)}>
            {t('上一页')}
          </button>
          <span>
            {t('第 {page} 页，共 {pages} 页', {
              page: page + 1,
              pages: Math.max(1, Math.ceil(data.total / pageSize)),
            })}
          </span>
          <button disabled={busy || !data.hasMore} onClick={() => setPage((p) => p + 1)}>
            {t('下一页')}
          </button>
        </div>
      )}
      {!!data.unavailable?.length && (
        <p className="library-unavailable">
          {t('有 {count} 个项目文件夹暂时无法完整读取。', { count: data.unavailable.length })}
        </p>
      )}
      {!!data.index?.skipped && (
        <p className="library-unavailable">
          {t('有 {count} 份文件暂时无法搜索正文，打开原文件时可查看具体原因。', {
            count: data.index.skipped,
          })}
        </p>
      )}
    </div>
  );
}
