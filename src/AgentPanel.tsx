import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  agentConnection,
  watchAgentConnection,
  receiveAgentConnection,
} from './agent-connection.mjs';
import {
  Sparkle,
  X,
  ArrowUp,
  Stop,
  Plus,
  PencilSimple,
  Check,
  CaretDown,
  ArrowCounterClockwise,
  FileText,
  TextAlignLeft,
  ArrowsClockwise,
} from '@phosphor-icons/react';
import { bridge } from './bridge';
import { t, errorMessage, getLocale } from './i18n';
import { renderMarkdown, renderDiagrams } from './markdown';
import DOMPurify from 'dompurify';
import type { AgentConnection, AgentMessage, AgentSession, AgentHintResult } from './types';
import { applyAgentEdits } from '../core/agent-edit.mjs';
import { previewBudget } from './preview-budget.mjs';
import './agent.css';

export interface AgentContext {
  path: string;
  content: string;
  selection: { from: number; to: number } | null;
}
interface Props {
  root: string;
  document: { path: string; content: string; revision: number } | null;
  capture: () => AgentContext | null;
  onApply: (message: AgentMessage) => Promise<void>;
  onUndo: (message: AgentMessage) => Promise<void>;
  onClose: () => void;
  onSettings: () => void;
  onOpenReference: (path: string) => void;
  disabled: boolean;
}
const nameOf = (path: string) => path.split('/').pop() || path;
const planName = (plan?: string) => {
  const known: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    promax: 'Pro Max',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    edu_plus: 'Edu Plus',
    edu_pro: 'Edu Pro',
  };
  if (plan?.startsWith('self_serve_business')) return 'Business';
  if (plan?.startsWith('enterprise') || plan === 'ent26') return 'Enterprise';
  return plan ? known[plan] || '' : '';
};

const Reply = memo(function Reply({ text, complete }: { text: string; complete: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const allowed = previewBudget(text).allowed;
  useEffect(() => {
    if (complete && allowed && holder.current)
      void renderDiagrams(holder.current, true).catch(() => {});
  }, [text, complete, allowed]);
  const html = useMemo(
    () =>
      allowed
        ? DOMPurify.sanitize(renderMarkdown(text), {
            FORBID_TAGS: ['img', 'iframe', 'audio', 'video', 'source'],
          })
        : '',
    [text, allowed],
  );
  if (!allowed) return <pre className="agent-plain-reply">{text}</pre>;
  return (
    <div
      ref={holder}
      className="agent-reply markdown-body"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a')) event.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export function AgentPanel({
  root,
  document: doc,
  capture,
  onApply,
  onUndo,
  onClose,
  onSettings,
  onOpenReference,
  disabled,
}: Props) {
  const connection = useSyncExternalStore(watchAgentConnection, agentConnection);
  const setConnection = receiveAgentConnection;
  const [session, setSession] = useState<AgentSession>({ root, messages: [], running: false });
  const [sessionReady, setSessionReady] = useState(false);
  const [hints, setHints] = useState<AgentHintResult | null>(null);
  const [hintRefresh, setHintRefresh] = useState(0);
  const forceHint = useRef(false);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem('folio-agent-model') || '';
    } catch {
      return '';
    }
  });
  const [efforts, setEfforts] = useState<Record<string, string>>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('folio-agent-efforts') || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  });
  const [context, setContext] = useState<AgentContext | null>(() => capture());
  const [scope, setScope] = useState<'document' | 'selection'>(() =>
    context?.selection ? 'selection' : 'document',
  );
  const [references, setReferences] = useState<{ path: string; name: string }[]>([]);
  const [picker, setPicker] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [candidates, setCandidates] = useState<
    { path: string; name: string; relativePath: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chosenEdits, setChosenEdits] = useState<Record<string, string[]>>({});
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const generation = useRef(0);
  const [localOutcomes, setLocalOutcomes] = useState<
    Record<string, 'accepted' | 'dismissed' | 'undone'>
  >({});

  useEffect(() => {
    let current = true;
    const lease = crypto.randomUUID();
    const id = ++generation.current;
    setSession({ root, messages: [], running: false });
    setSessionReady(false);
    setReferences([]);
    setInput('');
    setProblem('');
    setPicker(false);
    setLocalOutcomes({});
    void bridge
      .agentSession(root)
      .then((value) => {
        if (current && generation.current === id) {
          setSession(value);
          setSessionReady(true);
        }
      })
      .catch((error) => {
        if (current) setProblem(t(errorMessage(error)));
      });
    const off = bridge.onAgent((event) => {
      if (!current) return;
      if (event.type === 'connection') setConnection(event.connection);
      else if (event.type === 'session' && event.session.root === root) setSession(event.session);
      else if (event.type === 'progress' && event.root === root)
        setSession((old) => ({
          ...old,
          messages: old.messages.map((m) => (m.id === event.id ? { ...m, text: event.text } : m)),
        }));
    });
    void bridge
      .agentAcquire(lease)
      .then((value) => {
        if (current) setConnection(value);
      })
      .catch((error) => {
        if (current) setProblem(t(errorMessage(error)));
      });
    return () => {
      current = false;
      off();
      ++generation.current;
      void bridge.agentRelease(lease).catch(() => {});
    };
  }, [root]);
  useEffect(() => {
    const selected = capture();
    setContext(selected);
    setScope(selected?.selection ? 'selection' : 'document');
  }, [doc?.path]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [session]);
  useEffect(() => {
    const field = composer.current;
    if (field) {
      field.style.height = 'auto';
      field.style.height = Math.min(field.scrollHeight, 164) + 'px';
    }
  }, [input]);
  useEffect(() => {
    if (!picker) return;
    let current = true;
    const timer = setTimeout(() => {
      void bridge
        .documents(root, { query: referenceQuery, limit: 20, sort: 'modified-desc' })
        .then((value) => {
          if (current) setCandidates(value.documents);
        })
        .catch((error) => {
          if (current) setProblem(t(errorMessage(error)));
        });
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [picker, referenceQuery, root]);

  const ready = connection.phase === 'ready';
  const selectedModel =
    connection.models.find((m) => m.id === model)?.id ||
    connection.models.find((m) => m.isDefault)?.id ||
    connection.models[0]?.id ||
    '';
  const reconnecting = connection.phase === 'connecting';
  const availableEfforts =
    connection.models.find((item) => item.id === selectedModel)?.supportedEfforts || [];
  const effortKey = (connection.provider || 'chatgpt') + ':' + selectedModel;
  const selectedEffort = availableEfforts.includes(efforts[effortKey]) ? efforts[effortKey] : '';
  const established =
    (!!connection.account || session.messages.length > 0) &&
    (ready || reconnecting || connection.phase === 'error' || connection.phase === 'idle');
  const staleSelection =
    scope === 'selection' &&
    (!context?.selection || context.path !== doc?.path || context.content !== doc?.content);
  const canRun =
    (ready || (reconnecting && !!connection.account)) &&
    !!doc &&
    !session.running &&
    !busy &&
    !disabled &&
    !staleSelection;
  const canSend = canRun && !!input.trim();
  const hintSource = useRef({ doc, scope, context, staleSelection });
  hintSource.current = { doc, scope, context, staleSelection };
  useEffect(() => {
    if (!sessionReady || session.messages.length || !doc || !ready || staleSelection) return;
    const requestId = crypto.randomUUID();
    let current = true;
    setHints(null);
    const update = (value: AgentHintResult) => {
      if (!current || value.requestId !== requestId) return;
      setHints((old) =>
        old?.requestId === requestId && old.phase === 'ready' && value.phase === 'generating'
          ? old
          : value,
      );
    };
    const off = bridge.onAgent((event) => {
      if (event.type === 'hints') update(event.result);
    });
    const timer = setTimeout(() => {
      const source = hintSource.current;
      if (!source.doc || source.staleSelection) return;
      const content =
        source.scope === 'selection' && source.context?.selection
          ? source.context.content.slice(source.context.selection.from, source.context.selection.to)
          : source.doc.content;
      void bridge
        .agentHints({
          force: forceHint.current,
          requestId,
          path: source.doc.path,
          content,
          scope: source.scope,
          language: getLocale(),
        })
        .then(update)
        .catch(() => {
          if (current)
            setHints({
              requestId,
              key: '',
              path: source.doc!.path,
              phase: 'unavailable',
              hints: [],
              summary: '',
              message: '文档建议暂不可用，可以直接输入你的问题。',
            });
        });
      forceHint.current = false;
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
      off();
    };
  }, [
    sessionReady,
    session.messages.length === 0,
    doc?.path,
    ready,
    scope,
    staleSelection,
    hintRefresh,
  ]);
  async function operation<T>(fn: () => Promise<T>) {
    const id = generation.current;
    setBusy(true);
    setProblem('');
    try {
      return await fn();
    } catch (error) {
      if (generation.current === id) setProblem(t(errorMessage(error)));
    } finally {
      if (generation.current === id) setBusy(false);
    }
  }
  async function send(instruction?: string) {
    if (!canRun || !doc) return;
    const id = generation.current;
    const prompt = (instruction ?? input).trim();
    if (!prompt) return;
    follow.current = true;
    await operation(async () => {
      const value = await bridge.agentSend({
        path: doc.path,
        content: doc.content,
        selection: scope === 'selection' ? context!.selection : null,
        instruction: prompt,
        mode: 'auto',
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
        revision: doc.revision,
        references: references.map((r) => r.path),
        language: getLocale(),
      });
      if (generation.current === id) {
        setSession(value);
        setInput('');
      }
    });
  }
  const chooseSuggestion = (prompt: string) => {
    setInput(prompt);
    composer.current?.focus();
  };
  async function resolve(message: AgentMessage, outcome: 'accepted' | 'dismissed' | 'undone') {
    await operation(async () => {
      const ids = chosenEdits[message.id] || message.edits?.map((e) => e.id);
      if (outcome === 'accepted')
        await onApply({ ...message, edits: message.edits?.filter((e) => ids?.includes(e.id)) });
      if (outcome === 'undone') await onUndo(message);
      // An accepted edit is never offered twice if writing the conversation fails.
      setLocalOutcomes((old) => ({ ...old, [message.id]: outcome }));
      await bridge.agentResolve(
        root,
        message.id,
        outcome,
        outcome === 'accepted' ? ids : undefined,
      );
    });
  }
  return (
    <aside
      className="folio-agent"
      aria-label={t('Agent 文档助手')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (picker) setPicker(false);
          else onClose();
        }
      }}
    >
      <div className="agent-heading">
        <div>
          <h2>Agent</h2>
          <button
            className="agent-provider-button"
            aria-label={t('Agent 设置')}
            title={[
              connection.provider === 'api' ? t('兼容 API') : 'ChatGPT',
              connection.provider === 'api' ? '' : planName(connection.account?.plan),
              connection.account?.email,
              established
                ? reconnecting
                  ? t('正在恢复连接…')
                  : ready
                    ? t('已连接')
                    : t('连接暂不可用')
                : t('Agent 设置'),
            ]
              .filter(Boolean)
              .join(' · ')}
            onClick={onSettings}
          >
            <span>{connection.provider === 'api' ? t('兼容 API') : 'ChatGPT'}</span>
            <span className={'agent-dot ' + (ready ? 'ready' : '')} aria-hidden="true" />
          </button>
        </div>
        <div className="agent-heading-actions">
          <button
            className="icon-button"
            title={t('开始新对话')}
            aria-label={t('开始新对话')}
            disabled={session.running || busy || disabled || !session.messages.length}
            onClick={() =>
              void operation(async () => {
                const value = await bridge.agentClear(root);
                setSession(value);
                setLocalOutcomes({});
                setExpanded(null);
              })
            }
          >
            <Plus size={17} />
          </button>
          <button
            className="icon-button"
            title={t('关闭 Agent 面板')}
            aria-label={t('关闭 Agent 面板')}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
      </div>
      {!established && (
        <section className="agent-connect-card">
          <div className="agent-connect-icon">
            <Sparkle size={22} />
          </div>
          <h3>{t('让想法继续往前')}</h3>
          <p>
            {connection.provider === 'api'
              ? t('使用已配置的 API，与文档继续对话。')
              : t('用你的 ChatGPT 订阅，在文档旁提问、推敲和修改。')}
          </p>
          {connection.message && (
            <p className="agent-connect-message" role="status">
              {t(connection.message)}
            </p>
          )}
          {!bridge.desktop ? (
            <p>{t('请在 Folio 桌面应用中连接 Agent。')}</p>
          ) : (
            <button
              className="primary"
              disabled={busy || connection.phase === 'connecting'}
              onClick={() =>
                void operation(async () => {
                  const value =
                    connection.phase === 'login'
                      ? await bridge.agentLogin()
                      : await bridge.agentConnect();
                  if (value.phase === 'login' && !value.waiting && connection.phase !== 'login') {
                    setConnection(await bridge.agentLogin());
                    return;
                  }
                  setConnection(value);
                })
              }
            >
              {connection.phase === 'connecting'
                ? t('正在连接…')
                : connection.phase === 'login'
                  ? connection.waiting
                    ? t('重新打开登录')
                    : t('登录 ChatGPT')
                  : connection.phase === 'missing' || connection.phase === 'error'
                    ? t('重新连接')
                    : connection.provider === 'api'
                      ? t('连接 API')
                      : t('连接 Codex')}
            </button>
          )}
          <button className="agent-quiet" onClick={onSettings}>
            {t('使用兼容 API')}
          </button>
          {connection.waiting && (
            <button
              className="agent-quiet"
              disabled={busy}
              onClick={() =>
                void operation(async () => setConnection(await bridge.agentCancelLogin()))
              }
            >
              {t('取消登录')}
            </button>
          )}
          {connection.phase === 'missing' && (
            <button
              className="agent-quiet"
              onClick={() =>
                void bridge
                  .openLink('https://learn.chatgpt.com/docs/cli', doc?.path || '')
                  .catch((error) => setProblem(t(errorMessage(error))))
              }
            >
              {t('查看安装方法')}
            </button>
          )}
        </section>
      )}
      {established && connection.phase === 'error' && connection.message && (
        <p className="agent-connection-note" role="status">
          {t(connection.message)}
        </p>
      )}
      <div
        className="agent-conversation"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 70;
        }}
      >
        {!session.messages.length && (
          <div className="agent-empty">
            <span className="agent-empty-eyebrow">{t('围绕这份文档')}</span>
            <h3>{t('从一句问题开始')}</h3>
            <p>{hints?.summary || t('选中文字，或把当前文档交给 Agent。')}</p>
            <div className="agent-starters">
              {hints?.hints.map((hint) => (
                <button key={hint.label} onClick={() => chooseSuggestion(hint.prompt)}>
                  {hint.mode === 'edit' ? <PencilSimple size={16} /> : <Sparkle size={16} />}
                  {hint.label}
                </button>
              ))}
              {ready && (!hints || hints.phase === 'generating') && (
                <div className="agent-hint-loading" role="status">
                  {t('正在根据文档生成建议…')}
                </div>
              )}
            </div>
            {hints?.message && <p className="agent-hint-note">{t(hints.message)}</p>}
            {ready && (
              <div className="agent-hint-footer">
                <span>
                  {hints?.phase === 'ready'
                    ? t('由 {model} 生成', {
                        model: hints.model === 'gpt-6-luna' ? 'GPT-6 Luna' : hints.model || '',
                      })
                    : ''}
                </span>
                <button
                  aria-label={t('更新文档建议')}
                  title={t('更新文档建议')}
                  disabled={hints?.phase === 'generating'}
                  onClick={() => {
                    forceHint.current = true;
                    setHintRefresh((v) => v + 1);
                  }}
                >
                  <ArrowsClockwise size={13} />
                </button>
              </div>
            )}
          </div>
        )}
        {session.messages.map((message, messageIndex) => {
          const outcome = localOutcomes[message.id] || message.outcome;
          const original = session.messages
            .slice(0, messageIndex)
            .reverse()
            .find((item) => item.role === 'user' && item.path === message.path);
          const proposalStale = message.path !== doc?.path || message.base !== doc?.content;
          return (
            <article key={message.id} className={'agent-message ' + message.role}>
              <div className="agent-message-label">
                {message.role === 'user' ? (
                  t('你')
                ) : (
                  <>
                    <Sparkle size={13} />
                    {message.provider === 'api' ? message.model || t('API 助手') : 'Codex'}
                  </>
                )}
                {message.role === 'user' && (
                  <span title={message.path}>
                    {message.context === 'selection' ? t('选区') : nameOf(message.path)}
                  </span>
                )}
              </div>
              {message.role === 'user' ? (
                <p className="agent-user-text">{message.text}</p>
              ) : (
                <Reply text={message.text} complete={message.status === 'completed'} />
              )}
              {message.status === 'running' && (
                <div className="agent-thinking" role="status">
                  <span />
                  <span />
                  <span />
                  <small>{message.repairing ? t('正在整理修改…') : t('正在思考…')}</small>
                </div>
              )}
              {!!message.sources?.length && (
                <details className="agent-sources">
                  <summary>
                    {t('参考了 {count} 份项目文档', {
                      count: new Set(message.sources.map((source) => source.path)).size,
                    })}
                  </summary>
                  {message.sources.map((source) => (
                    <button
                      key={source.path + ':' + source.line + ':' + (source.kind || '')}
                      onClick={() => onOpenReference(source.path)}
                      title={
                        source.kind === 'preview'
                          ? source.name + ' · ' + t('可见画面')
                          : source.name + ':' + source.line + '–' + source.endLine
                      }
                    >
                      {source.name}
                      <span>
                        {source.kind === 'preview'
                          ? t('可见画面')
                          : source.line + '–' + source.endLine}
                      </span>
                    </button>
                  ))}
                </details>
              )}
              {message.error && (
                <p className="agent-inline-error" role="alert">
                  {t(message.error)}
                </p>
              )}
              {message.status === 'interrupted' && (
                <p className="agent-status-note">
                  {message.stopReason === 'user'
                    ? t('回复已停止')
                    : ['shutdown', 'restart'].includes(message.stopReason || '')
                      ? t('上次回复因应用退出而中断，指令已保留。')
                      : t('上次回复未完成，指令已保留。')}
                </p>
              )}
              {['error', 'interrupted'].includes(message.status || '') &&
                original &&
                message.path === doc?.path && (
                  <button
                    className="agent-retry"
                    disabled={
                      !canRun || (original.context === 'selection' && scope !== 'selection')
                    }
                    onClick={() => void send(original.text)}
                  >
                    {t('重试')}
                  </button>
                )}
              {!!message.edits?.length && (
                <section className="agent-proposal">
                  <button
                    className="agent-proposal-toggle"
                    aria-expanded={expanded === message.id}
                    onClick={() => setExpanded(expanded === message.id ? null : message.id)}
                  >
                    <PencilSimple size={16} />
                    <strong>{t('{count} 处修改建议', { count: message.edits.length })}</strong>
                    <CaretDown size={14} />
                  </button>
                  <span className="agent-proposal-file" title={message.path}>
                    <FileText size={12} />
                    {nameOf(message.path)}
                  </span>
                  {expanded === message.id && (
                    <div className="agent-edit-list">
                      {message.edits.map((edit) => (
                        <div key={edit.id} className="agent-edit">
                          <h4>
                            {!outcome && (
                              <input
                                type="checkbox"
                                aria-label={t('接受这处修改')}
                                checked={(
                                  chosenEdits[message.id] || message.edits!.map((e) => e.id)
                                ).includes(edit.id)}
                                onChange={(event) =>
                                  setChosenEdits((old) => {
                                    const current =
                                      old[message.id] || message.edits!.map((e) => e.id);
                                    return {
                                      ...old,
                                      [message.id]: event.target.checked
                                        ? [...current, edit.id]
                                        : current.filter((id) => id !== edit.id),
                                    };
                                  })
                                }
                              />
                            )}
                            {edit.title}
                          </h4>
                          <div className="agent-diff-label">{t('原文')}</div>
                          <pre className="agent-diff-before">{edit.before || t('空文档')}</pre>
                          <div className="agent-diff-label">{t('建议')}</div>
                          <pre className="agent-diff-after">{edit.after || t('删除此段')}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                  {outcome ? (
                    <div className="agent-proposal-outcome">
                      <Check size={14} />
                      {outcome === 'accepted'
                        ? t('已应用到文档')
                        : outcome === 'undone'
                          ? t('已撤销修改')
                          : t('已忽略建议')}
                      {outcome === 'accepted' && (
                        <button
                          disabled={
                            busy ||
                            disabled ||
                            message.path !== doc?.path ||
                            message.base === undefined ||
                            applyAgentEdits(message.base, message.edits) !== doc?.content
                          }
                          onClick={() => void resolve(message, 'undone')}
                        >
                          <ArrowCounterClockwise size={12} />
                          {t('撤销修改')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {proposalStale && (
                        <p className="agent-status-note">
                          {message.path !== doc?.path
                            ? t('打开对应文档后可审阅修改。')
                            : t('文档已变化，请重新生成修改建议。')}
                        </p>
                      )}
                      <div className="agent-proposal-actions">
                        <button
                          disabled={busy || disabled}
                          onClick={() => void resolve(message, 'dismissed')}
                        >
                          {t('忽略')}
                        </button>
                        <button
                          className="primary"
                          disabled={
                            proposalStale ||
                            busy ||
                            disabled ||
                            chosenEdits[message.id]?.length === 0
                          }
                          onClick={() => {
                            if (expanded !== message.id) setExpanded(message.id);
                            else void resolve(message, 'accepted');
                          }}
                        >
                          {expanded === message.id ? t('接受修改') : t('查看修改')}
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}
            </article>
          );
        })}
      </div>
      <div className="agent-compose-area">
        {problem && (
          <div className="agent-inline-error" role="alert">
            {problem}
            <button aria-label={t('关闭提示')} onClick={() => setProblem('')}>
              <X size={13} />
            </button>
          </div>
        )}
        {staleSelection && (
          <p className="agent-status-note">
            {t('选区已变化，请重新选择文字。')}
            <button
              onClick={() => {
                setContext(capture());
              }}
            >
              {t('重新获取选区')}
            </button>
          </p>
        )}
        <div className="agent-context-bar">
          <button
            aria-pressed={scope === 'document'}
            title={doc?.path}
            onClick={() => setScope('document')}
          >
            <FileText size={13} />
            <span>{doc ? nameOf(doc.path) : t('请先打开文档')}</span>
          </button>
          <button
            aria-pressed={scope === 'selection'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const next = capture();
              if (next?.selection) {
                setContext(next);
                setScope('selection');
              } else setProblem(t('请先在文档中选择文字。'));
            }}
          >
            <TextAlignLeft size={13} />
            {t('选区')}
          </button>
        </div>
        {scope === 'selection' && context?.selection && (
          <div className="agent-selection-excerpt">
            {context.content.slice(context.selection.from, context.selection.to).slice(0, 220)}
          </div>
        )}
        {!!references.length && (
          <div className="agent-reference-chips">
            {references.map((reference) => (
              <span key={reference.path} title={reference.path}>
                {reference.name}
                <button
                  aria-label={t('移除参考文档')}
                  onClick={() =>
                    setReferences((items) => items.filter((r) => r.path !== reference.path))
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="agent-composer">
          <textarea
            ref={composer}
            aria-label={t('给 Agent 的指令')}
            placeholder={t('提问，或告诉 Agent 你想怎样修改…')}
            value={input}
            disabled={disabled}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
          />
          <div className="agent-compose-tools">
            <button
              className="icon-button agent-attach"
              aria-label={t('添加参考文档')}
              title={t('添加参考文档')}
              disabled={references.length >= 3 || disabled}
              onClick={() => setPicker(!picker)}
            >
              <Plus size={17} />
            </button>
            <span className="spacer" />
            {session.running ? (
              <button
                className="agent-send"
                aria-label={t('停止回复')}
                title={t('停止回复')}
                onClick={() => void operation(() => bridge.agentCancel(root))}
              >
                <Stop size={15} weight="fill" />
              </button>
            ) : (
              <button
                className="agent-send"
                aria-label={t('发送给 Agent')}
                title={t('发送给 Agent')}
                disabled={!canSend}
                onClick={() => void send()}
              >
                <ArrowUp size={18} weight="bold" />
              </button>
            )}
          </div>
        </div>
        {picker && (
          <div className="agent-reference-picker">
            <div>
              <input
                autoFocus
                aria-label={t('查找参考文档')}
                placeholder={t('查找参考文档')}
                value={referenceQuery}
                onChange={(event) => setReferenceQuery(event.target.value)}
              />
              <button aria-label={t('关闭')} onClick={() => setPicker(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="agent-reference-options">
              {candidates
                .filter(
                  (r) => r.path !== doc?.path && !references.some((ref) => ref.path === r.path),
                )
                .map((candidate) => (
                  <button
                    key={candidate.path}
                    onClick={() => {
                      setReferences((items) => [
                        ...items,
                        { path: candidate.path, name: candidate.name },
                      ]);
                      setPicker(false);
                      setReferenceQuery('');
                    }}
                  >
                    <FileText size={14} />
                    <span>
                      {candidate.name}
                      <small>{candidate.relativePath}</small>
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}
        <div className="agent-compose-footer">
          <select
            aria-label={t('Agent 模型')}
            value={selectedModel}
            disabled={!ready || session.running}
            onChange={(event) => {
              setModel(event.target.value);
              try {
                localStorage.setItem('folio-agent-model', event.target.value);
              } catch {}
            }}
          >
            {!connection.models.length && <option value="">Codex</option>}
            {connection.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {!!availableEfforts.length && (
            <select
              className="agent-effort"
              aria-label={t('思考强度')}
              title={t('思考强度')}
              value={selectedEffort}
              disabled={!ready || session.running}
              onChange={(event) => {
                const next = { ...efforts, [effortKey]: event.target.value };
                setEfforts(next);
                try {
                  localStorage.setItem('folio-agent-efforts', JSON.stringify(next));
                } catch {}
              }}
            >
              <option value="">{t('默认强度')}</option>
              {availableEfforts.map((value) => (
                <option key={value} value={value}>
                  {t(
                    (
                      {
                        none: '不推理',
                        minimal: '极低',
                        low: '低',
                        medium: '中',
                        high: '高',
                        xhigh: '很高',
                        max: '最高',
                        ultra: '极高',
                      } as Record<string, string>
                    )[value] || value,
                  )}
                </option>
              ))}
            </select>
          )}
          <span>{t('修改先审阅，再应用')}</span>
        </div>
      </div>
    </aside>
  );
}
