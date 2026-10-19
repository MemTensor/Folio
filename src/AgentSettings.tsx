import { useEffect, useRef, useState } from 'react';
import { Sparkle, Key, CheckCircle } from '@phosphor-icons/react';
import { bridge } from './bridge';
import { t, errorMessage } from './i18n';
import type { AgentConnection, AgentSettingsTarget } from './types';
import { receiveAgentConnection } from './agent-connection.mjs';
import { problemSettingsTarget, settingsReturnReady } from './agent-settings-navigation.mjs';

export function AgentSettings({
  target,
  returnTo = 'settings',
  onComplete,
}: {
  target?: AgentSettingsTarget;
  returnTo?: 'document' | 'settings';
  onComplete?: () => void;
}) {
  const [configuration, setConfiguration] = useState<Awaited<
    ReturnType<typeof bridge.agentConfiguration>
  > | null>(null);
  const [provider, setProvider] = useState<'chatgpt' | 'api'>('chatgpt');
  const [connection, setConnection] = useState<AgentConnection>({ phase: 'idle', models: [] });
  const [baseURL, setBaseURL] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [hintModel, setHintModel] = useState('');
  const [imageInput, setImageInput] = useState(false);
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const current = useRef(true);
  const holder = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const returnIntent = useRef<'chatgpt' | 'api' | null>(null);
  const revision = useRef(-1);
  function updateConnection(value: AgentConnection) {
    if (!current.current) return;
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
      returnIntent.current = null;
      if (current.current) {
        const message = errorMessage(e);
        setError(t(message));
        const field = problemSettingsTarget(message)?.field;
        if (field)
          requestAnimationFrame(() =>
            holder.current
              ?.querySelector<HTMLInputElement>(`[data-agent-setting="${field}"]`)
              ?.focus(),
          );
      }
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
        setProvider(target?.provider || value.provider);
        setBaseURL(value.baseURL);
        setModel(value.model);
        setHintModel(value.hintModel);
        setImageInput(value.imageInput);
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
      returnIntent.current = null;
      off();
      void bridge.agentRelease(lease).catch(() => {});
    };
  }, []);
  const apiSaved =
    configuration?.provider === 'api' &&
    configuration.baseURL === baseURL.trim().replace(/\/+$/, '') &&
    configuration.model === model.trim() &&
    configuration.hintModel === hintModel.trim() &&
    configuration.imageInput === imageInput &&
    !key;
  useEffect(() => {
    if (!configuration || focused.current || !target) return;
    focused.current = true;
    const frame = requestAnimationFrame(() => {
      const field =
        target.provider === 'api'
          ? target.field ||
            (!configuration.model ? 'baseURL' : !configuration.hasKey ? 'key' : 'model')
          : 'connect';
      const element = holder.current?.querySelector<HTMLElement>(`[data-agent-setting="${field}"]`);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [configuration, target]);
  useEffect(() => {
    if (!current.current) return;
    if (['error', 'missing', 'idle'].includes(connection.phase) && !busy)
      returnIntent.current = null;
    if (
      onComplete &&
      settingsReturnReady(returnIntent.current, provider, connection, apiSaved, busy)
    ) {
      returnIntent.current = null;
      onComplete();
    }
  }, [provider, connection, apiSaved, busy, onComplete]);
  const returnLabel = returnTo === 'document' ? t('返回文档') : t('返回设置');
  return (
    <div className="agent-settings" ref={holder}>
      <p className="agent-settings-intro">
        {t('选择文档助手的接入方式。文档与改动审阅使用同一个面板。')}
      </p>
      <div className="agent-provider-options" role="group" aria-label={t('Agent 接入方式')}>
        <button
          aria-pressed={provider === 'chatgpt'}
          disabled={busy || !configuration}
          onClick={() => {
            returnIntent.current = null;
            setProvider('chatgpt');
          }}
        >
          <Sparkle size={19} />
          <span>
            ChatGPT<small>{t('使用订阅登录')}</small>
          </span>
        </button>
        <button
          aria-pressed={provider === 'api'}
          disabled={busy || !configuration}
          onClick={() => {
            returnIntent.current = null;
            setProvider('api');
          }}
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
              data-agent-setting="connect"
              className="primary"
              disabled={busy || !bridge.desktop}
              onClick={() =>
                void run(async () => {
                  returnIntent.current = 'chatgpt';
                  if (configuration?.provider !== 'chatgpt')
                    setConfiguration(await bridge.agentConfigure({ provider: 'chatgpt' }));
                  let value = await bridge.agentConnect();
                  if (value.phase === 'login') value = await bridge.agentLogin();
                  updateConnection(value);
                })
              }
            >
              {connection.provider !== 'api' && connection.phase === 'ready'
                ? onComplete
                  ? returnLabel
                  : t('重新检查连接')
                : connection.waiting && connection.loginURL
                  ? t('打开登录页')
                  : onComplete
                    ? returnTo === 'document'
                      ? t('连接并返回文档')
                      : t('连接并返回设置')
                    : t('登录或连接 ChatGPT')}
            </button>
            {connection.provider !== 'api' && connection.waiting && (
              <>
                {connection.loginURL && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await bridge.copyText(connection.loginURL!);
                        setMessage(t('已复制登录链接。'));
                      })
                    }
                  >
                    {t('复制登录链接')}
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      returnIntent.current = null;
                      updateConnection(await bridge.agentCancelLogin());
                    })
                  }
                >
                  {t('取消登录')}
                </button>
              </>
            )}
          </div>
        </section>
      ) : (
        <section className="agent-api-settings">
          <p>{t('连接支持 Chat Completions 的服务，使用该服务的 API 额度。')}</p>
          <label>
            {t('API 基础地址')}
            <input
              data-agent-setting="baseURL"
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
              data-agent-setting="key"
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
              data-agent-setting="model"
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
          <label className="agent-image-input">
            <input
              type="checkbox"
              checked={imageInput}
              disabled={busy}
              onChange={(e) => setImageInput(e.target.checked)}
            />
            {t('此模型支持图片输入，可按需查看文档渲染')}
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
                  returnIntent.current = 'api';
                  const value = await bridge.agentConfigure({
                    provider: 'api',
                    baseURL,
                    model,
                    hintModel,
                    imageInput,
                    ...(key.trim() ? { apiKey: key.trim() } : {}),
                  });
                  setKey('');
                  setConfiguration(value);
                  setBaseURL(value.baseURL);
                  setModel(value.model);
                  setHintModel(value.hintModel);
                  setImageInput(value.imageInput);
                  setMessage(t('API 设置已保存。'));
                  updateConnection(await bridge.agentStatus());
                })
              }
            >
              {onComplete
                ? returnTo === 'document'
                  ? t('保存并返回文档')
                  : t('保存并返回设置')
                : t('保存并连接')}
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
            onClick={() =>
              void run(async () => {
                returnIntent.current = null;
                updateConnection(await bridge.agentDisconnect());
              })
            }
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
      {bridge.desktop && (
        <div className="agent-settings-disconnect agent-settings-diagnostics">
          <span>{t('诊断信息仅含运行事件，日志最多约 1 MB；不包含正文、对话或凭据。')}</span>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (await bridge.exportDiagnostics()) setMessage(t('诊断信息已导出。'));
              })
            }
          >
            {t('导出诊断信息')}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await bridge.copyText(await bridge.diagnosticsSnapshot());
                setMessage(t('诊断信息已复制。'));
              })
            }
          >
            {t('复制诊断信息')}
          </button>
        </div>
      )}
    </div>
  );
}
