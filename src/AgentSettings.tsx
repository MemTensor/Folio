import { useEffect, useRef, useState } from 'react';
import { Sparkle, Key, CheckCircle } from '@phosphor-icons/react';
import { bridge } from './bridge';
import { t, errorMessage } from './i18n';
import type { AgentConnection } from './types';
import { receiveAgentConnection } from './agent-connection.mjs';

export function AgentSettings() {
  const [configuration, setConfiguration] = useState<Awaited<
    ReturnType<typeof bridge.agentConfiguration>
  > | null>(null);
  const [provider, setProvider] = useState<'chatgpt' | 'api'>('chatgpt');
  const [connection, setConnection] = useState<AgentConnection>({ phase: 'idle', models: [] });
  const [baseURL, setBaseURL] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [hintModel, setHintModel] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const current = useRef(true);
  const revision = useRef(-1);
  function updateConnection(value: AgentConnection) {
    if ((value.revision || 0) >= revision.current) {
      revision.current = value.revision || 0;
      receiveAgentConnection(value);
      setConnection(value);
    }
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
    } catch (e) {
      if (current.current) setError(t(errorMessage(e)));
    } finally {
      if (current.current) setBusy(false);
    }
  }
  useEffect(() => {
    current.current = true;
    const lease = crypto.randomUUID();
    const off = bridge.onAgent((event) => {
      if (current.current && event.type === 'connection') updateConnection(event.connection);
    });
    void bridge
      .agentConfiguration()
      .then((value) => {
        if (!current.current) return;
        setConfiguration(value);
        setProvider(value.provider);
        setBaseURL(value.baseURL);
        setModel(value.model);
        setHintModel(value.hintModel);
      })
      .catch((e) => {
        if (current.current) setError(t(errorMessage(e)));
      });
    void bridge
      .agentAcquire(lease)
      .then((value) => {
        if (current.current) updateConnection(value);
      })
      .catch((e) => {
        if (current.current) setError(t(errorMessage(e)));
      });
    return () => {
      current.current = false;
      off();
      void bridge.agentRelease(lease).catch(() => {});
    };
  }, []);
  const apiSaved =
    configuration?.provider === 'api' &&
    configuration.baseURL === baseURL.trim().replace(/\/+$/, '') &&
    configuration.model === model.trim() &&
    !key;
  return (
    <div className="agent-settings">
      <p className="agent-settings-intro">
        {t('选择文档助手的接入方式。文档与改动审阅使用同一个面板。')}
      </p>
      <div className="agent-provider-options" role="group" aria-label={t('Agent 接入方式')}>
        <button
          aria-pressed={provider === 'chatgpt'}
          disabled={busy || !configuration}
          onClick={() => setProvider('chatgpt')}
        >
          <Sparkle size={19} />
          <span>
            ChatGPT<small>{t('使用订阅登录')}</small>
          </span>
        </button>
        <button
          aria-pressed={provider === 'api'}
          disabled={busy || !configuration}
          onClick={() => setProvider('api')}
        >
          <Key size={19} />
          <span>
            {t('兼容 API')}
            <small>{t('OpenAI 兼容格式')}</small>
          </span>
        </button>
      </div>
      {!bridge.desktop && (
        <p className="knowledge-error">
          {t('请在 Folio 桌面应用中配置。浏览器演示不会接收 API Key。')}
        </p>
      )}
      {provider === 'chatgpt' ? (
        <section className="agent-subscription-settings">
          <h3>{t('ChatGPT 订阅')}</h3>
          <p>{t('在官方页面登录，使用账号提供的 Codex 额度。')}</p>
          {connection.provider !== 'api' && connection.phase === 'ready' && (
            <div className="agent-settings-connected">
              <CheckCircle size={16} />
              {connection.account?.email || t('已连接')}
            </div>
          )}
          {connection.provider !== 'api' && connection.message && (
            <p role="status">{t(connection.message)}</p>
          )}
          <div className="agent-settings-actions">
            <button
              className="primary"
              disabled={busy || !bridge.desktop}
              onClick={() =>
                void run(async () => {
                  if (configuration?.provider !== 'chatgpt')
                    setConfiguration(await bridge.agentConfigure({ provider: 'chatgpt' }));
                  let value = await bridge.agentConnect();
                  if (value.phase === 'login') value = await bridge.agentLogin();
                  updateConnection(value);
                })
              }
            >
              {connection.provider !== 'api' && connection.phase === 'ready'
                ? t('重新检查连接')
                : t('登录或连接 ChatGPT')}
            </button>
            {connection.provider !== 'api' && connection.waiting && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => updateConnection(await bridge.agentCancelLogin()))
                }
              >
                {t('取消登录')}
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="agent-api-settings">
          <p>{t('连接支持 Chat Completions 的服务，使用该服务的 API 额度。')}</p>
          <label>
            {t('API 基础地址')}
            <input
              aria-label={t('API 基础地址')}
              value={baseURL}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label>
            API Key
            <input
              aria-label="Agent API Key"
              type="password"
              value={key}
              disabled={busy || !bridge.desktop}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                configuration?.hasKey
                  ? t('已保存，留空保持现有 Key')
                  : t('输入 API Key；本机服务可留空')
              }
            />
          </label>
          <label>
            {t('模型名称')}
            <input
              aria-label={t('模型名称')}
              list="agent-api-models"
              value={model}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('填写服务提供的模型 ID')}
            />
            <datalist id="agent-api-models">
              {models.map((id) => (
                <option value={id} key={id} />
              ))}
            </datalist>
          </label>
          <details className="agent-hint-options">
            <summary>{t('文档建议模型')}</summary>
            <label>
              {t('轻量模型名称')}
              <input
                aria-label={t('轻量模型名称')}
                list="agent-api-models"
                value={hintModel}
                disabled={busy}
                onChange={(e) => setHintModel(e.target.value)}
                placeholder="gpt-6-luna"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="agent-settings-footnote">
              {t('建议使用轻量模型生成；留空时不会调用更贵的模型。')}
            </p>
          </details>
          <div className="agent-settings-actions">
            <button
              className="primary"
              disabled={busy || !bridge.desktop || !baseURL.trim() || !model.trim()}
              onClick={() =>
                void run(async () => {
                  const value = await bridge.agentConfigure({
                    provider: 'api',
                    baseURL,
                    model,
                    hintModel,
                    ...(key.trim() ? { apiKey: key.trim() } : {}),
                  });
                  setKey('');
                  setConfiguration(value);
                  setBaseURL(value.baseURL);
                  setModel(value.model);
                  setMessage(t('API 设置已保存。'));
                })
              }
            >
              {t('保存并连接')}
            </button>
            <button
              disabled={busy || !apiSaved || !bridge.desktop}
              onClick={() =>
                void run(async () => {
                  const result = await bridge.agentTestAPI();
                  setModels(result.models);
                  setMessage(t('服务检测成功，可从模型列表中选择。'));
                })
              }
            >
              {t('检测服务')}
            </button>
          </div>
          <p className="agent-settings-footnote">
            {t('API Key 通过系统安全存储加密。更换服务地址时需重新填写对应的 Key。')}
          </p>
        </section>
      )}
      {connection.phase !== 'idle' && (
        <div className="agent-settings-disconnect">
          <span>{t('断开后暂停自动恢复，登录信息仍保留。')}</span>
          <button
            disabled={busy || !bridge.desktop}
            onClick={() => void run(async () => updateConnection(await bridge.agentDisconnect()))}
          >
            {t('断开连接')}
          </button>
        </div>
      )}
      {provider === 'api' && connection.provider === 'api' && connection.message && (
        <p className="knowledge-error" role="status">
          {t(connection.message)}
        </p>
      )}
      {error && (
        <p className="knowledge-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="knowledge-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
