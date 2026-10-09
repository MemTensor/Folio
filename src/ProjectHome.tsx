import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  FolderOpen,
  Plus,
  ArrowsClockwise,
  MagnifyingGlass,
  GearSix,
  ArrowRight,
  CloudArrowUp,
  WarningCircle,
  Star,
  FileText,
  X,
} from '@phosphor-icons/react';
import { bridge } from './bridge';
import { t, getLocale, setLocale, localeTag, errorMessage } from './i18n';
import {
  selectProjectShelf,
  discoverableProjects,
  projectTitle,
  recentShelfDocuments,
} from './project-shelf.mjs';
import type { ProjectOverview, ExperiencePreferences, Workspace } from './types';

export function ProjectSettings({
  data,
  onChange,
}: {
  data: ProjectOverview;
  onChange: (data: ProjectOverview) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const update = async (
    patch: Partial<ExperiencePreferences> & { syncEnabled?: boolean; syncProjectIds?: string[] },
  ) => {
    setBusy(true);
    setError('');
    try {
      onChange(await bridge.projectConfigure(patch));
      if (patch.language) setLocale(patch.language);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const selected: string[] = data.sync?.projectIds || [];
  const bind = async (projectId: string, cloudId: string) => {
    setBusy(true);
    setError('');
    try {
      onChange(await bridge.projectSyncBind({ projectId, cloudId: cloudId || null }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="project-settings" aria-busy={busy}>
      <label className="project-setting">
        <span>{t('语言')}</span>
        <select
          aria-label={t('语言')}
          value={getLocale()}
          disabled={busy}
          onChange={(e) => void update({ language: e.target.value as 'zh-CN' | 'en' })}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <label className="project-setting">
        <span>
          {t('启动时显示项目首页')}
          <small>{t('以项目为单位打开文档，随时回到正在编辑的内容。')}</small>
        </span>
        <input
          type="checkbox"
          checked={data.preferences.homeOnLaunch}
          disabled={busy}
          onChange={(e) => void update({ homeOnLaunch: e.target.checked })}
        />
      </label>
      <label className="project-setting">
        <span>
          {t('发现 Agent 项目')}
          <small>{t('读取 Codex 和 Claude Code 的项目记录，不扫描整个磁盘。')}</small>
        </span>
        <input
          type="checkbox"
          checked={data.preferences.discoverProjects}
          disabled={busy}
          onChange={(e) => void update({ discoverProjects: e.target.checked })}
        />
      </label>
      <label className="project-setting">
        <span>
          {t('iCloud 文档同步')}
          <small>{t('仅同步选中项目的 Markdown 和引用的图片、附件，单文件小于 100 MB。')}</small>
        </span>
        <input
          type="checkbox"
          checked={!!data.sync?.enabled}
          disabled={busy || !data.sync?.available}
          onChange={(e) => void update({ syncEnabled: e.target.checked })}
        />
      </label>
      {!data.sync?.available && (
        <p className="project-hint">{t('请先在 macOS 系统设置中启用 iCloud Drive。')}</p>
      )}
      {data.sync?.enabled && (
        <fieldset className="sync-projects">
          <legend>{t('同步的项目')}</legend>
          {data.projects
            .filter((p) => p.registered)
            .map((p) => (
              <div key={p.id} className="sync-project-choice">
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      void update({
                        syncProjectIds: e.target.checked
                          ? [...selected, p.id]
                          : selected.filter((id) => id !== p.id),
                      })
                    }
                  />
                  <span>
                    {p.name}
                    <small>{p.root}</small>
                  </span>
                </label>
                {selected.includes(p.id) && !!data.sync?.cloudProjects?.length && (
                  <select
                    disabled={busy}
                    aria-label={t('iCloud 中的项目：{name}', { name: p.name })}
                    value={data.sync?.bindings?.[p.id] || ''}
                    onChange={(e) => void bind(p.id, e.target.value)}
                  >
                    <option value="">{t('独立同步此项目')}</option>
                    {data.sync.cloudProjects.map((c) => (
                      <option key={c.id} value={c.id}>
                        {t('连接：{name}', { name: c.name })}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          <p className="project-hint">
            {t('先打开项目即可加入同步列表。关闭同步会保留已有文件；删除不会传递到另一端。')}
          </p>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="project-error">
          {t(error)}
        </p>
      )}
    </div>
  );
}

export function FirstRun({
  data,
  onChange,
  onDone,
}: {
  data: ProjectOverview;
  onChange: (data: ProjectOverview) => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const focusScope = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const scope = focusScope.current;
      if (!scope) return;
      const controls = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ),
      ).filter((node) => node.offsetParent !== null);
      if (!controls.length) {
        event.preventDefault();
        return;
      }
      const first = controls[0],
        last = controls[controls.length - 1],
        outside = !scope.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap, true);
    return () => {
      document.removeEventListener('keydown', trap, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    focusScope.current?.querySelector<HTMLElement>('#welcome-title')?.focus();
  }, [step]);
  const finish = async () => {
    setBusy(true);
    try {
      onChange(await bridge.projectConfigure({ onboarded: true }));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="first-run"
      ref={focusScope}
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
    >
      <div className="welcome-card">
        <div className="welcome-brand">
          <BookOpen size={30} />
          <span>Folio</span>
          <select
            aria-label={t('语言')}
            value={getLocale()}
            disabled={busy}
            onChange={(e) => {
              const language = e.target.value as 'zh-CN' | 'en';
              setBusy(true);
              void bridge
                .projectConfigure({ language })
                .then((data) => {
                  setLocale(language);
                  onChange(data);
                })
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <p className="eyebrow">{t('文档，让人与 Agent 接续工作。')}</p>
        <h1 id="welcome-title" tabIndex={-1}>
          {step === 0 ? t('欢迎使用 Folio') : t('选择你的工作方式')}
        </h1>
        {step === 0 ? (
          <div className="welcome-features">
            <section>
              <BookOpen size={22} />
              <h3>{t('专注阅读与写作')}</h3>
              <p>{t('直接打开 Markdown，公式、图表和表格与正文一起编辑。')}</p>
            </section>
            <section>
              <FolderOpen size={22} />
              <h3>{t('按项目整理文档')}</h3>
              <p>{t('项目首页集中入口，文件仍保存在原来的文件夹。')}</p>
            </section>
            <section>
              <ArrowsClockwise size={22} />
              <h3>{t('与 Agent 安心协作')}</h3>
              <p>{t('外部修改及时显示；未保存的内容与冲突留给你审阅。')}</p>
            </section>
          </div>
        ) : (
          <ProjectSettings data={data} onChange={onChange} />
        )}
        <div className="welcome-actions">
          <button disabled={busy} onClick={() => void finish()}>
            {step === 0 ? t('跳过引导') : t('开始使用')}
          </button>
          {step === 0 && (
            <button className="primary" onClick={() => setStep(1)}>
              {t('继续')}
              <ArrowRight size={16} />
            </button>
          )}
        </div>
        {error && <p role="alert">{t(error)}</p>}
      </div>
    </div>
  );
}

export function ProjectHome({
  data,
  onChange,
  onOpen,
  onOpenDocument,
  onChoose,
  onResume,
  onCancelOpen,
  onSettings,
}: {
  data: ProjectOverview;
  onChange: (data: ProjectOverview) => void;
  onOpen: (w: Workspace, isCurrent: () => boolean) => Promise<void>;
  onOpenDocument: (path: string, isCurrent: () => boolean) => Promise<void>;
  onChoose: () => Promise<void>;
  onResume: () => void;
  onCancelOpen: () => Promise<void>;
  onSettings: () => void;
}) {
  const [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [opening, setOpening] = useState<string | null>(null),
    [openingDocument, setOpeningDocument] = useState<string | null>(null),
    [pinning, setPinning] = useState<string | null>(null),
    [discover, setDiscover] = useState(false),
    [discoveryQuery, setDiscoveryQuery] = useState(''),
    [includeTemporary, setIncludeTemporary] = useState(false),
    [candidateData, setCandidateData] = useState<ProjectOverview | null>(null),
    [discovering, setDiscovering] = useState(false);
  const openRequest = useRef(0),
    discoveryDialog = useRef<HTMLDialogElement>(null),
    discoveryInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      openRequest.current++;
    },
    [],
  );
  useEffect(() => {
    const dialog = discoveryDialog.current;
    if (!dialog) return;
    if (discover) {
      if (!dialog.open) dialog.showModal();
      discoveryInput.current?.focus();
    } else if (dialog.open) dialog.close();
  }, [discover]);
  useEffect(() => {
    if (!data.preferences.discoverProjects) {
      setCandidateData(null);
      setDiscovering(false);
      return;
    }
    if (!discover) return;
    let canceled = false;
    setDiscovering(true);
    setError('');
    void bridge
      .projectOverview({ discover: true })
      .then((result) => {
        if (!canceled) setCandidateData(result);
      })
      .catch((error) => {
        if (!canceled) setError(errorMessage(error));
      })
      .finally(() => {
        if (!canceled) setDiscovering(false);
      });
    return () => {
      canceled = true;
    };
  }, [discover, data.preferences.discoverProjects]);
  const cancelOpen = () => {
    openRequest.current++;
    setOpening(null);
    setOpeningDocument(null);
    void onCancelOpen().catch((error) => setError(errorMessage(error)));
  };
  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      if (discover)
        setCandidateData(await bridge.projectOverview({ discover: true, refresh: true }));
      else onChange(await bridge.projectOverview({ refresh: true }));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const enableDiscovery = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // Discovery begins through the effect only after this explicit opt-in
      // succeeds and the persisted preference reaches this component.
      onChange(await bridge.projectConfigure({ discoverProjects: true }));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const open = async (id: string) => {
    const request = ++openRequest.current;
    setOpeningDocument(null);
    setOpening(id);
    setError('');
    try {
      const info = await bridge.projectOpen(id);
      if (request !== openRequest.current) {
        await onCancelOpen();
        return;
      }
      await onOpen(info, () => request === openRequest.current);
    } catch (error) {
      if (request === openRequest.current) setError(errorMessage(error));
    } finally {
      if (request === openRequest.current) setOpening(null);
    }
  };
  const openDocument = async (path: string) => {
    const request = ++openRequest.current;
    setOpening(null);
    setOpeningDocument(path);
    setError('');
    try {
      await onOpenDocument(path, () => request === openRequest.current);
    } catch (error) {
      if (request === openRequest.current) setError(errorMessage(error));
    } finally {
      if (request === openRequest.current) setOpeningDocument(null);
    }
  };
  const sync = async () => {
    setBusy(true);
    setError('');
    try {
      await bridge.projectSyncNow();
      onChange(await bridge.projectOverview());
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const pinnedProjects = data.preferences.pinnedProjects || [],
    pinned = new Set(pinnedProjects),
    shelf = selectProjectShelf(data.projects, pinnedProjects),
    projects = shelf.filter((project) =>
      (project.name + ' ' + project.root)
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    ),
    recentDocuments = recentShelfDocuments(
      data.recentDocuments || [],
      data.projects,
      pinnedProjects,
    ),
    candidateProjects = [
      ...new Map(
        [
          ...(data.preferences.discoverProjects ? candidateData?.projects || [] : []),
          ...data.projects,
        ].map((project) => [project.id, project]),
      ).values(),
    ],
    candidates = discoverableProjects(candidateProjects, {
      query: discoveryQuery,
      pinnedProjects,
      includeTemporary,
    });
  const label = (project: ProjectOverview['projects'][number]) => projectTitle(project, t('文档'));
  const shortPath = (root: string) => root.replace(/^\/Users\/[^/]+\//, '~/');
  const showDiscovery = (initial = '') => {
    setDiscoveryQuery(initial);
    setDiscover(true);
  };
  const closeDiscovery = () => {
    setDiscover(false);
    if (opening) cancelOpen();
  };
  const pin = async (id: string) => {
    if (pinning) return;
    setPinning(id);
    setError('');
    try {
      onChange(
        await bridge.projectConfigure({
          pinnedProjects: pinned.has(id)
            ? pinnedProjects.filter((value) => value !== id)
            : [id, ...pinnedProjects],
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPinning(null);
    }
  };
  const pinButton = (project: ProjectOverview['projects'][number]) => (
    <button
      className={'project-pin ' + (pinned.has(project.id) ? 'is-pinned' : '')}
      aria-label={t(pinned.has(project.id) ? '取消置顶：{name}' : '置顶项目：{name}', {
        name: label(project),
      })}
      title={pinned.has(project.id) ? t('取消置顶') : t('置顶项目')}
      aria-pressed={pinned.has(project.id)}
      disabled={pinning !== null}
      onClick={() => void pin(project.id)}
    >
      <Star size={17} weight={pinned.has(project.id) ? 'fill' : 'regular'} />
    </button>
  );
  return (
    <div className="project-home">
      <header className="project-home-header">
        <div className="project-wordmark">
          <BookOpen size={25} />
          <strong>Folio</strong>
        </div>
        <button
          onClick={() => {
            cancelOpen();
            onResume();
          }}
        >
          {t('返回文档')}
          <ArrowRight size={16} />
        </button>
        <button aria-label={t('写作设置')} title={t('写作设置')} onClick={onSettings}>
          <GearSix size={20} />
        </button>
      </header>
      <main>
        <div className="project-home-heading">
          <div>
            <h1>{t('项目')}</h1>
            <p>{t('常用项目与最近文档。')}</p>
          </div>
          <div className="project-home-actions">
            <button
              onClick={() => {
                cancelOpen();
                void onChoose().catch((error) => setError(errorMessage(error)));
              }}
            >
              <FolderOpen size={17} />
              {t('打开文件夹')}
            </button>
            <button className="primary" onClick={() => showDiscovery()}>
              <Plus size={17} />
              {t('添加项目')}
            </button>
          </div>
        </div>
        <div className="project-home-tools">
          <label>
            <MagnifyingGlass size={17} />
            <input
              value={query}
              aria-label={t('查找常用项目')}
              placeholder={t('查找常用项目…')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button onClick={() => showDiscovery(query)}>
            {t('发现更多项目')}
            <ArrowRight size={14} />
          </button>
          {data.sync?.enabled && (
            <button disabled={busy} onClick={() => void sync()}>
              <CloudArrowUp size={17} />
              {t('立即同步')}
            </button>
          )}
        </div>
        {opening && !discover && (
          <p className="project-hint" role="status">
            {t('正在打开项目…')}
            <button onClick={cancelOpen}>{t('取消打开')}</button>
          </p>
        )}
        {error && !discover && (
          <p className="project-error" role="alert">
            {t(error)}
          </p>
        )}
        <section className="project-shelf" aria-labelledby="project-shelf-heading">
          <div className="shelf-section-heading">
            <h2 id="project-shelf-heading">{t('常用与最近项目')}</h2>
            <span>{t('置顶的项目会排在前面。')}</span>
          </div>
          <div className="project-grid">
            {projects.map((project, index) => (
              <div className="project-shelf-item" key={project.id}>
                <button
                  className="project-card"
                  disabled={opening === project.id}
                  aria-busy={opening === project.id}
                  onClick={() => void open(project.id)}
                  title={project.root}
                >
                  <span className={'notebook-cover cover-' + (index % 5)}>
                    <span className="notebook-spine" />
                    <BookOpen size={24} />
                    <strong className="project-card-name">{label(project)}</strong>
                    <span>{(project.sources || ['Folio']).join(' · ')}</span>
                  </span>
                  <small>{shortPath(project.root)}</small>
                </button>
                {pinButton(project)}
              </div>
            ))}
          </div>
          {!projects.length && (
            <div className="shelf-empty">
              <p>
                {query ? t('常用项目中没有匹配结果。') : t('打开或置顶一个项目，下次从这里继续。')}
              </p>
              <button onClick={() => showDiscovery(query)}>
                {t('发现更多项目')}
                <ArrowRight size={15} />
              </button>
            </div>
          )}
        </section>
        <section className="recent-documents" aria-labelledby="recent-documents-heading">
          <div className="shelf-section-heading">
            <h2 id="recent-documents-heading">{t('最近文档')}</h2>
          </div>
          {recentDocuments.length ? (
            <div className="recent-document-list">
              {recentDocuments.map((document) => (
                <button
                  className="recent-document"
                  key={document.path}
                  disabled={openingDocument !== null}
                  onClick={() => void openDocument(document.path)}
                  title={document.path}
                >
                  <FileText size={19} />
                  <span>
                    <strong>{document.name.replace(/\.(?:md|markdown|mdown)$/i, '')}</strong>
                    <small>
                      {document.projectName}
                      {document.relativePath ? ' · ' + document.relativePath : ''}
                    </small>
                  </span>
                  <time dateTime={new Date(document.lastOpenedAt).toISOString()}>
                    {new Date(document.lastOpenedAt).toLocaleDateString(localeTag(), {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <p className="project-hint">{t('打开过的文档会显示在这里。')}</p>
          )}
        </section>
        {data.sync?.enabled && <SyncSummary data={data} onChange={onChange} />}
      </main>
      <dialog
        ref={discoveryDialog}
        className="project-discovery"
        aria-labelledby="project-discovery-heading"
        onCancel={(event) => {
          event.preventDefault();
          closeDiscovery();
        }}
      >
        <header>
          <div>
            <h2 id="project-discovery-heading">{t('添加或发现项目')}</h2>
            <p>{t('从本机项目记录中选择，打开后会出现在首页。')}</p>
          </div>
          <button aria-label={t('关闭')} onClick={closeDiscovery}>
            <X size={19} />
          </button>
        </header>
        <div className="project-discovery-tools">
          <label>
            <MagnifyingGlass size={18} />
            <input
              ref={discoveryInput}
              value={discoveryQuery}
              aria-label={t('查找项目')}
              placeholder={t('查找项目…')}
              onChange={(event) => setDiscoveryQuery(event.target.value)}
            />
          </label>
          <button
            disabled={busy || discovering}
            onClick={() => void refresh()}
            title={t('刷新项目记录')}
            aria-label={t('刷新项目记录')}
          >
            <ArrowsClockwise size={18} />
          </button>
        </div>
        <label className="discovery-temporary">
          <input
            type="checkbox"
            checked={includeTemporary}
            onChange={(event) => setIncludeTemporary(event.target.checked)}
          />
          {t('包含临时项目')}
        </label>
        {opening && (
          <p className="project-hint" role="status">
            {t('正在打开项目…')}
            <button onClick={cancelOpen}>{t('取消打开')}</button>
          </p>
        )}
        {error && (
          <p className="project-error" role="alert">
            {t(error)}
          </p>
        )}
        {discovering && (
          <p className="project-hint" role="status">
            {t('正在查找本机项目…')}
          </p>
        )}
        <div className="discovery-project-list">
          {candidates.map((project) => (
            <div className="discovery-project" key={project.id}>
              <button
                className="discovery-project-open"
                disabled={opening === project.id}
                onClick={() => void open(project.id)}
                title={project.root}
              >
                <FolderOpen size={20} />
                <span>
                  <strong>{label(project)}</strong>
                  <small>{shortPath(project.root)}</small>
                </span>
                <ArrowRight size={16} />
              </button>
              {pinButton(project)}
            </div>
          ))}
          {!candidates.length && !discovering && (
            <p className="shelf-empty">{t('没有匹配的项目。可以直接选择文件夹。')}</p>
          )}
        </div>
        <footer>
          <p>
            {data.preferences.discoverProjects
              ? t('仅显示可用项目；临时任务默认隐藏。')
              : t('开启后读取 Codex / Claude Code 的本机项目记录，不读取文档正文。')}
            {((data.preferences.discoverProjects && candidateData?.limited) || data.limited) &&
              ' ' + t('项目记录较多，已限制此次读取范围。可直接打开其他文件夹。')}
          </p>
          {!data.preferences.discoverProjects && (
            <button className="primary" disabled={busy} onClick={() => void enableDiscovery()}>
              {t('开启项目发现')}
            </button>
          )}
          <button
            onClick={() => {
              setDiscover(false);
              cancelOpen();
              void onChoose().catch((error) => setError(errorMessage(error)));
            }}
          >
            <FolderOpen size={16} />
            {t('打开文件夹')}
          </button>
        </footer>
      </dialog>
    </div>
  );
}
function SyncSummary({
  data,
  onChange,
}: {
  data: ProjectOverview;
  onChange: (data: ProjectOverview) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const resolve = async (id: string, choice: 'local' | 'cloud') => {
    setBusy(true);
    try {
      await bridge.projectSyncResolve({ id, choice });
      onChange(await bridge.projectOverview());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sync-summary">
      <h3>
        <CloudArrowUp size={18} />
        {t('iCloud 同步')}
      </h3>
      <p>
        {data.sync?.lastSyncedAt
          ? t('上次同步：{time}', {
              time: new Date(data.sync.lastSyncedAt).toLocaleString(getLocale()),
            })
          : t('选择项目后可开始同步。')}
      </p>
      {(data.sync?.conflicts || []).map((c: any) => (
        <div className="sync-conflict" key={c.id}>
          <WarningCircle size={18} />
          <span>
            {c.projectName} / {c.path}
          </span>
          <button disabled={busy} onClick={() => void resolve(c.id, 'local')}>
            {t('保留本地')}
          </button>
          <button disabled={busy} onClick={() => void resolve(c.id, 'cloud')}>
            {t('采用 iCloud 版本')}
          </button>
        </div>
      ))}
      {error && <p role="alert">{t(error)}</p>}
      {data.sync?.message && <p>{t(data.sync.message)}</p>}
    </section>
  );
}
