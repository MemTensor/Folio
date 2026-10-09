import { t, localeTag, errorMessage } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';
import type { UpdateState } from './types';

const size = (bytes?: number) =>
  bytes === undefined
    ? ''
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`;
export function UpdatePanel({
  status,
  installing,
  onInstall,
}: {
  status: UpdateState | null;
  installing: boolean;
  onInstall: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [canceling, setCanceling] = useState(false);
  const checked = useRef(false);
  async function run(operation: () => Promise<unknown>) {
    if (busy || installing) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancelDownload() {
    if (canceling || installing) return;
    setCanceling(true);
    setError('');
    try {
      await bridge.cancelUpdate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCanceling(false);
    }
  }
  useEffect(() => {
    if (checked.current || !status) return;
    checked.current = true;
    if (
      status.supported &&
      !['downloading', 'ready', 'preparing', 'installing', 'checking'].includes(status.phase)
    )
      void run(() => bridge.checkUpdates());
  }, [status]);
  if (!status)
    return (
      <p className="panel-intro" role="status">
        {t('正在读取当前版本…')}
      </p>
    );
  const locked = installing || status.phase === 'preparing' || status.phase === 'installing';
  const phase = status.phase,
    available = status.available;
  const titles = {
    idle: t('检查新版本'),
    checking: t('正在检查更新…'),
    current: t('已是最新版本'),
    available: t('有新版本可用'),
    downloading: t('正在下载更新…'),
    ready: t('更新已准备好'),
    preparing: t('正在保留你的文档…'),
    installing: t('正在重启并更新…'),
    error: t('暂时无法完成更新'),
  };
  const percent = Math.max(0, Math.min(100, status.progress?.percent || 0));
  return (
    <div className="update-panel">
      <p className="panel-intro">
        {t('当前版本')} <strong>Folio {status.currentVersion || '—'}</strong>
      </p>
      <h3>{status.supported ? titles[phase] : t('请在桌面应用中检查更新')}</h3>
      {status.message && (
        <p className="panel-intro" role={phase === 'error' ? 'alert' : undefined}>
          {t(status.message, status.messageVars)}
        </p>
      )}
      {available && (
        <p className="panel-intro">
          Folio {available.version}
          {available.size ? ` · ${size(available.size)}` : ''}
          {available.publishedAt && Number.isFinite(Date.parse(available.publishedAt))
            ? ` · ${new Date(available.publishedAt).toLocaleDateString(localeTag())}`
            : ''}
        </p>
      )}
      {phase === 'downloading' && (
        <div role="status">
          <progress
            aria-label={t('更新下载进度')}
            max={100}
            value={status.progress?.total ? percent : undefined}
            style={{ width: '100%' }}
          />
          <p className="panel-intro">
            {size(status.progress?.received)}
            {status.progress?.total
              ? ` / ${size(status.progress.total)} · ${Math.round(percent)}%`
              : ''}{' '}
            {t('· 下载期间可以继续写作。')}
          </p>
        </div>
      )}
      {available?.notes && (
        <details>
          <summary>{t('版本说明')}</summary>
          <div
            className="panel-intro"
            style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}
          >
            {available.notes}
          </div>
        </details>
      )}
      {phase === 'ready' && (
        <p className="panel-intro">
          {t('未保存内容与待审阅修改会保留为恢复草稿，更新后可以继续处理。')}
        </p>
      )}
      {error && (
        <p className="knowledge-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="modal-actions">
        {status.supported && (
          <button disabled={busy || locked} onClick={() => void run(() => bridge.openUpdatePage())}>
            {t('查看发布页面')}
          </button>
        )}
        <span className="spacer" />
        {status.supported && phase === 'downloading' ? (
          <button disabled={canceling || locked} onClick={() => void cancelDownload()}>
            {canceling ? t('正在取消…') : t('取消下载')}
          </button>
        ) : null}
        {status.supported && available && ['available', 'error'].includes(phase) ? (
          <button
            className="primary"
            disabled={busy || locked}
            onClick={() => void run(() => bridge.downloadUpdate())}
          >
            {t('下载更新')}
          </button>
        ) : null}
        {status.supported && phase === 'ready' ? (
          <button className="primary" disabled={busy || locked} onClick={() => void run(onInstall)}>
            {t('保留草稿并重启更新')}
          </button>
        ) : null}
        {status.supported && ['idle', 'current', 'error'].includes(phase) ? (
          <button
            className={available ? '' : 'primary'}
            disabled={busy || locked}
            onClick={() => void run(() => bridge.checkUpdates())}
          >
            {t('检查更新')}
          </button>
        ) : null}
        {locked && <span role="status">{t('请等待更新完成…')}</span>}
      </div>
    </div>
  );
}
