import { t, errorMessage } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';

/** Connection setup only. Memory operations belong to the agent CLI/skill. */
export function MemorySettings({ workspace }: { workspace: string }) {
  const [status, setStatus] = useState<any>(null),
    [key, setKey] = useState(''),
    [changingKey, setChangingKey] = useState(false),
    [selected, setSelected] = useState(''),
    [name, setName] = useState(''),
    [existingId, setExistingId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const current = useRef(workspace);
  current.current = workspace;
  const refresh = async () => {
    const scope = workspace;
    const s = await bridge.cloudStatus(workspace);
    if (scope !== current.current) return;
    setStatus(s);
    setSelected(s.project?.knowledgebaseId || '');
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void perform(refresh);
  }, [workspace]);
  return (
    <div className="memory-settings">
      <p className="memory-description">
        {t(
          '配置一次后，已启用的 Codex／Claude Code skill 会在项目任务中使用记忆。你继续正常读写文件。',
        )}
      </p>
      {!bridge.desktop && (
        <p className="knowledge-error">
          {t('请在 Folio 桌面应用中配置。浏览器演示不会接收 API Key。')}
        </p>
      )}
      {error && (
        <p className="knowledge-error" role="alert">
          {t(error)}
        </p>
      )}
      {message && (
        <p className="knowledge-message" role="status">
          {t(message)}
        </p>
      )}
      <section>
        <h3>MemOS API Key</h3>
        {status?.configured && !changingKey ? (
          <div className="memory-configured">
            <span>{t('已配置')}</span>
            <button onClick={() => setChangingKey(true)}>{t('更换')}</button>
          </div>
        ) : (
          <>
            <input
              type="password"
              autoComplete="off"
              aria-label="MemOS API Key"
              placeholder={t('输入 API Key')}
              value={key}
              disabled={!bridge.desktop}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              disabled={!bridge.desktop || !key.trim() || busy}
              onClick={() =>
                void perform(async () => {
                  await bridge.cloudConfigure({ apiKey: key });
                  setKey('');
                  setChangingKey(false);
                  await refresh();
                  setMessage(t('API Key 已保存。'));
                })
              }
            >
              {t('保存 Key')}
            </button>
          </>
        )}
      </section>
      <section>
        <h3>{t('当前项目的知识库')}</h3>
        <div className="memory-workspace" title={workspace}>
          {workspace ? workspace.split('/').pop() : t('请先打开项目文件夹')}
        </div>
        <select
          aria-label={t('当前项目知识库')}
          value={selected}
          disabled={!bridge.desktop || busy || !workspace}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">{t('不使用云端记忆')}</option>
          {(status?.collections || []).map((c: any) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={
            !bridge.desktop ||
            busy ||
            !workspace ||
            selected === (status?.project?.knowledgebaseId || '')
          }
          onClick={() =>
            void perform(async () => {
              await bridge.cloudBindProject(selected || null, workspace);
              await refresh();
              setMessage(selected ? t('已为当前项目启用记忆。') : t('当前项目已停用云端记忆。'));
            })
          }
        >
          {t('保存项目设置')}
        </button>
        <details>
          <summary>{t('新建或使用已有知识库')}</summary>
          <label>
            {t('名称')}
            <input
              aria-label={t('知识库名称')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('例如：研究项目')}
            />
          </label>
          <label>
            {t('已有知识库 ID（新建时留空）')}
            <input
              aria-label={t('已有知识库 ID')}
              value={existingId}
              onChange={(e) => setExistingId(e.target.value)}
              placeholder={t('填写已有 ID，或留空新建')}
            />
          </label>
          <button
            disabled={!bridge.desktop || !status?.configured || !name.trim() || busy || !workspace}
            onClick={() =>
              void perform(async () => {
                const c = existingId.trim()
                  ? await bridge.cloudAttachCollection(existingId.trim(), name.trim())
                  : await bridge.cloudCreateCollection(name.trim());
                await bridge.cloudBindProject(c.id, workspace);
                setName('');
                setExistingId('');
                await refresh();
                setMessage(t('当前项目的知识库已设置。'));
              })
            }
          >
            {existingId.trim() ? t('使用已有知识库') : t('创建并用于当前项目')}
          </button>
        </details>
      </section>
      <p className="memory-footnote">
        {t('设置按项目保存。索引与检索由 Agent 处理；完整文档、公式和图表仍保存在本机。')}
      </p>
    </div>
  );
}
