import { useState } from 'react';
import { Modal } from './App';
import { t } from './i18n';

export function CloseSessionDialog({
  ask,
  unsaved,
  count,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  ask: boolean;
  unsaved: boolean;
  count: number;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (save: boolean, restore: boolean, remember: boolean) => void;
}) {
  const [restore, setRestore] = useState(true);
  const [remember, setRemember] = useState(false);
  return (
    <Modal
      title={t('关闭 Folio')}
      className="close-session-dialog"
      onClose={() => !busy && onCancel()}
    >
      {ask && (
        <fieldset className="close-session-options" disabled={busy}>
          <legend>{t('下次启动时，恢复这 {count} 个标签吗？', { count })}</legend>
          <label>
            <input
              type="radio"
              name="restore-tabs"
              checked={restore}
              onChange={() => setRestore(true)}
            />
            <span>
              {t('恢复这些标签')}
              <small>{t('保留标签顺序，并回到当前文档。')}</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="restore-tabs"
              checked={!restore}
              onChange={() => setRestore(false)}
            />
            <span>
              {t('关闭全部标签')}
              <small>{t('文档和恢复草稿仍保留在本机。')}</small>
            </span>
          </label>
          <label className="close-session-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t('记住这次选择，不再询问')}
          </label>
        </fieldset>
      )}
      {unsaved && (
        <p className="panel-intro">
          {t('还有未保存或待审阅的内容。你可以保存所有文档，或保留恢复草稿后关闭。')}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={onCancel}>
          {t('继续编辑')}
        </button>
        <span className="spacer" />
        {unsaved && (
          <button disabled={busy} onClick={() => onConfirm(false, restore, remember)}>
            {t('保留草稿并关闭')}
          </button>
        )}
        <button
          className="primary"
          disabled={busy}
          onClick={() => onConfirm(unsaved, restore, remember)}
        >
          {busy ? t('正在关闭…') : unsaved ? t('保存并关闭') : t('关闭 Folio')}
        </button>
      </div>
    </Modal>
  );
}
