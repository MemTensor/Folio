import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  Sun,
  Leaf,
  Moon,
  Check,
  PencilSimple,
  BookOpen,
  FolderOpen,
  Sparkle,
  Brain,
  Info,
} from '@phosphor-icons/react';
import { Modal } from './App';
import { AgentSettings } from './AgentSettings';
import { MemorySettings } from './MemorySettings';
import { UpdatePanel } from './UpdatePanel';
import { ProjectSettings } from './ProjectHome';
import { bridge } from './bridge';
import { t } from './i18n';
import type { Prefs } from './preferences';
import type { ProjectOverview, UpdateState } from './types';

type Section = 'appearance' | 'writing' | 'reading' | 'projects' | 'agent' | 'memory' | 'about';
const advanced = (section: Section) =>
  section === 'agent' || section === 'memory' || section === 'about';

export function SettingsPanel({
  prefs,
  setPrefs,
  projectData,
  setProjectData,
  root,
  updateState,
  installing,
  onInstall,
  onClose,
  onNotice,
  onError,
  onGuide,
}: {
  prefs: Prefs;
  setPrefs: Dispatch<SetStateAction<Prefs>>;
  projectData: ProjectOverview | null;
  setProjectData: Dispatch<SetStateAction<ProjectOverview | null>>;
  root: string;
  updateState: UpdateState | null;
  installing: boolean;
  onInstall: () => Promise<void>;
  onClose: () => void;
  onNotice: (message: string) => void;
  onError: (error: unknown) => void;
  onGuide: () => void;
}) {
  const [section, setSection] = useState<Section>('appearance');
  const parent = useRef<Section>('appearance');
  const scrolls = useRef(new Map<Section, number>()),
    content = useRef<HTMLDivElement>(null);
  const categories = [
    ['appearance', t('外观'), Sun],
    ['writing', t('写作'), PencilSimple],
    ['reading', t('阅读'), BookOpen],
    ['projects', t('项目与同步'), FolderOpen],
    ['agent', 'Agent', Sparkle],
    ['memory', t('AI 记忆'), Brain],
    ['about', t('关于与更新'), Info],
  ] as const;
  const title = categories.find(([id]) => id === section)![1];
  function navigate(next: Section) {
    if (installing) return;
    scrolls.current.set(section, content.current?.scrollTop || 0);
    if (!advanced(next)) parent.current = next;
    setSection(next);
  }
  function close() {
    if (!installing) advanced(section) ? navigate(parent.current) : onClose();
  }
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = scrolls.current.get(section) || 0;
  }, [section]);
  const toggle = (
    key:
      | 'autoSave'
      | 'reviewExternal'
      | 'focus'
      | 'typewriter'
      | 'spellcheck'
      | 'lineNumbers'
      | 'remoteImages',
    label: string,
    description: string,
  ) => (
    <label className="toggle-row settings-toggle" key={key}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={prefs[key]}
        onChange={(event) => setPrefs((p) => ({ ...p, [key]: event.target.checked }))}
      />
    </label>
  );
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      onError(error);
    }
  };
  return (
    <Modal
      title={t('设置')}
      className="settings-dialog settings-columns"
      onClose={close}
      onBack={advanced(section) ? () => navigate(parent.current) : undefined}
      closeLabel={advanced(section) ? t('关闭并返回设置') : undefined}
    >
      <div className="settings-layout">
        <nav className="settings-sidebar" aria-label={t('设置分类')}>
          {categories.map(([id, label, Icon]) => (
            <button
              key={id}
              data-settings-section={id}
              disabled={installing}
              aria-current={section === id ? 'page' : undefined}
              className={section === id ? 'selected' : ''}
              onClick={() => navigate(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-content" ref={content} data-settings-page={section}>
          <h3 className="settings-section-title">{title}</h3>
          {section === 'appearance' && (
            <div className="settings-body">
              <div className="theme-options">
                {(['light', 'sepia', 'dark'] as const).map((theme, i) => (
                  <button
                    key={theme}
                    className={(prefs.theme === theme ? 'selected ' : '') + 'theme-' + theme}
                    onClick={() => setPrefs((p) => ({ ...p, theme }))}
                  >
                    {i === 0 ? <Sun /> : i === 1 ? <Leaf /> : <Moon />}
                    {[t('纸白'), t('暖纸'), t('夜色')][i]}
                    {prefs.theme === theme && <Check size={14} />}
                  </button>
                ))}
              </div>
              <label className="setting-row">
                <span>{t('正文字体')}</span>
                <select
                  value={prefs.font}
                  onChange={(event) =>
                    setPrefs((p) => ({ ...p, font: event.target.value as Prefs['font'] }))
                  }
                >
                  <option value="sans">{t('系统无衬线')}</option>
                  <option value="serif">{t('衬线 / 宋体')}</option>
                </select>
              </label>
              <label className="setting-row">
                <span>{t('文字大小')}</span>
                <input
                  aria-label={t('文字大小')}
                  type="range"
                  min="14"
                  max="24"
                  value={prefs.fontSize}
                  onChange={(event) =>
                    setPrefs((p) => ({ ...p, fontSize: Number(event.target.value) }))
                  }
                />
                <output>{prefs.fontSize}</output>
              </label>
              <label className="setting-row">
                <span>{t('正文宽度')}</span>
                <input
                  aria-label={t('正文宽度')}
                  type="range"
                  min="600"
                  max="1000"
                  step="20"
                  value={prefs.width}
                  onChange={(event) =>
                    setPrefs((p) => ({ ...p, width: Number(event.target.value) }))
                  }
                />
                <output>{prefs.width}</output>
              </label>
            </div>
          )}
          {section === 'writing' && (
            <div className="settings-body">
              {toggle('autoSave', t('自动保存'), t('停止输入 1.5 秒后保存；冲突时暂停。'))}
              {toggle(
                'reviewExternal',
                t('所有外部修改先审阅'),
                t('关闭时，未编辑的文件自动同步。'),
              )}
              {toggle('focus', t('专注模式'), t('淡化当前编辑段落以外的内容。'))}
              {toggle('typewriter', t('打字机模式'), t('输入时让光标保持在屏幕中部。'))}
              {toggle('spellcheck', t('拼写检查'), t('使用系统拼写检查。'))}
              {toggle('lineNumbers', t('源码行号'), t('在源码模式显示行号与折叠标记。'))}
            </div>
          )}
          {section === 'reading' && (
            <div className="settings-body">
              <label className="setting-row">
                <span>{t('默认复制格式')}</span>
                <select
                  aria-label={t('默认复制格式')}
                  value={prefs.readingCopy}
                  onChange={(event) =>
                    setPrefs((p) => ({
                      ...p,
                      readingCopy: event.target.value as Prefs['readingCopy'],
                    }))
                  }
                >
                  <option value="rich">{t('带格式文本')}</option>
                  <option value="source">{t('Markdown 源码')}</option>
                </select>
              </label>
              <p className="settings-description">
                {t('用于阅读模式的 ⌘C。右键菜单始终提供两种格式。')}
              </p>
              {toggle('remoteImages', t('加载网络图片'), t('开启后，图片来源网站会收到加载请求。'))}
            </div>
          )}
          {section === 'projects' && (
            <div className="settings-body">
              {projectData && <ProjectSettings data={projectData} onChange={setProjectData} />}
              <button className="full" onClick={onGuide}>
                {t('重新查看引导')}
              </button>
            </div>
          )}
          {section === 'agent' && <AgentSettings />}
          {section === 'memory' && <MemorySettings workspace={root} />}
          {section === 'about' && (
            <>
              <div className="settings-body settings-about">
                <strong>Folio {updateState?.currentVersion || '…'}</strong>
                <p className="settings-description">
                  {t('文档以纯文本保存，历史与恢复草稿保存在应用数据目录。')}
                </p>
                <div className="settings-diagnostics-actions">
                  <button
                    onClick={() =>
                      void run(async () => {
                        if (await bridge.exportDiagnostics()) onNotice(t('诊断信息已导出。'));
                      })
                    }
                  >
                    {t('导出诊断信息')}
                  </button>
                  <button
                    onClick={() =>
                      void run(async () => {
                        await bridge.copyText(await bridge.diagnosticsSnapshot());
                        onNotice(t('诊断信息已复制。'));
                      })
                    }
                  >
                    {t('复制诊断信息')}
                  </button>
                </div>
              </div>
              <UpdatePanel status={updateState} installing={installing} onInstall={onInstall} />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
