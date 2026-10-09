import { t } from './i18n';
import { useEffect, useState } from 'react';
import { bridge } from './bridge';
import { exportHTML } from './export';
import { parser } from './markdown';

type DiagramImage = { source: string; png: string };
async function diagramImages(content: string, path: string): Promise<DiagramImage[]> {
  const sources = parser
    .parse(content, {})
    .filter(
      (token) =>
        token.type === 'fence' &&
        parser.utils.unescapeAll(token.info).trim().split(/\s+/)[0] === 'mermaid',
    )
    .map((token) => token.content);
  if (!sources.length) return [];
  const { diagrams } = await exportHTML(content, path);
  if (diagrams.length !== sources.length)
    throw Error(t('图表数量与源码不一致，请检查文档后重试。'));
  return Promise.all(
    diagrams.map(
      (svg, index) =>
        new Promise<DiagramImage>((resolve, reject) => {
          const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
          const box = (parsed.getAttribute('viewBox') || '0 0 800 500').split(/[ ,]+/).map(Number);
          if (
            box.length !== 4 ||
            box.some((n) => !Number.isFinite(n)) ||
            box[2] <= 0 ||
            box[3] <= 0
          ) {
            reject(Error(t('图表尺寸无效。')));
            return;
          }
          const width = Math.max(1, Math.min(1800, box[2] * 2));
          const height = Math.max(1, Math.min(6000, (width * box[3]) / box[2]));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const img = new Image();
          img.onload = () => {
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(Error(t('无法生成图表图片。')));
              return;
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            resolve({ source: sources[index], png: canvas.toDataURL('image/png') });
          };
          img.onerror = () => reject(Error(t('图表转换失败，请检查 Mermaid 源码。')));
          parsed.setAttribute('width', String(width));
          parsed.setAttribute('height', String(height));
          img.src =
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent(new XMLSerializer().serializeToString(parsed));
        }),
    ),
  );
}

export function DingTalkPanel({ path }: { path: string }) {
  const [status, setStatus] = useState<any>(null),
    [profile, setProfile] = useState('');
  const [plan, setPlan] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [reload, setReload] = useState(0);
  const [recipient, setRecipient] = useState(''),
    [share, setShare] = useState<any>(null);
  const [candidate, setCandidate] = useState(''),
    [inspection, setInspection] = useState<any>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const binding = status?.binding,
    url = binding?.url || inspection?.remote?.url || plan?.url;
  const pendingShare = ['sending', 'uncertain'].includes(share?.record?.state);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setProfile('');
    setPlan(null);
    setInspection(null);
    setAcknowledged(false);
    setShare(null);
    bridge
      .dingtalkInfo(path)
      .then((s) => {
        if (active) {
          setStatus(s);
          setProfile(s.binding?.profile || s.currentProfile || '');
          if (s.error) setError(s.error);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [path]);
  useEffect(() => {
    if (!profile) return;
    let active = true;
    setBusy(true);
    setPlan(null);
    setError('');
    bridge
      .read(path)
      .then(async (file) => {
        if (!file.hash) throw Error(t('请先保存文档，再生成发布预览。'));
        return bridge.dingtalkPlan(path, {
          profile,
          expectedRevision: file.hash,
          diagrams: await diagramImages(file.content, path),
        });
      })
      .then((p) => {
        if (active) setPlan(p);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [path, profile, reload]);
  useEffect(() => {
    let active = true;
    setShare(null);
    if (!recipient.trim() || binding?.state !== 'synced') return;
    const timer = setTimeout(() => {
      bridge
        .dingtalkShareStatus(path, recipient)
        .then((value) => {
          if (active) setShare(value);
        })
        .catch(() => {});
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path, recipient, binding?.state, binding?.packageHash]);

  async function refreshStatus() {
    const next = await bridge.dingtalkInfo(path);
    setStatus(next);
    return next;
  }
  async function publish() {
    if (!plan || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await bridge.dingtalkExecute(path, plan.id);
      setStatus((s: any) => ({ ...s, binding: result }));
      setInspection(null);
      setMessage(result.unchanged ? t('钉钉文档已是最新。') : t('已发布为钉钉在线文档。'));
      setPlan((p: any) => ({ ...p, action: 'current', requiresReview: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refreshStatus().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    setBusy(true);
    setError('');
    try {
      const result = await bridge.dingtalkReconcile(path);
      setStatus((s: any) => ({ ...s, binding: result }));
      setMessage(t('已确认上次发布内容。'));
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspectRecovery() {
    setBusy(true);
    setError('');
    setAcknowledged(false);
    setInspection(null);
    try {
      setInspection(
        await bridge.dingtalkRecoveryInfo(
          path,
          candidate.trim() ? { nodeId: candidate.trim() } : {},
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function recover(action: 'attach' | 'adopt-remote' | 'detach' | 'confirm-not-created') {
    if (!acknowledged || !binding || busy) return;
    setBusy(true);
    setError('');
    try {
      await bridge.dingtalkRecover(path, {
        action,
        expectedPlanId: inspection?.binding?.planId || binding.planId,
        nodeId: inspection?.remote?.nodeId,
        expectedRevision: inspection?.remote?.revision,
        confirmed: true,
      });
      const next = await refreshStatus();
      setInspection(null);
      setAcknowledged(false);
      setCandidate('');
      setMessage(
        action === 'adopt-remote'
          ? t('已保留云端内容。下次发布前请审阅两个版本，确认更新后才会写入钉钉。')
          : next.binding
            ? t('已恢复文档关联。')
            : t('已结束这次关联；钉钉现有内容保持原样。'),
      );
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function sendLink() {
    setBusy(true);
    setError('');
    try {
      const result = await bridge.dingtalkShare(path, recipient);
      setMessage(
        result.replayed
          ? t('该版本的链接已发送给这些接收人。')
          : t('已向 {0} 位同事发送链接。', { '0': result.sent }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setShare(await bridge.dingtalkShareStatus(path, recipient).catch(() => null));
      setBusy(false);
    }
  }
  async function resolveShare(outcome: 'sent' | 'not-sent') {
    if (!share) return;
    setBusy(true);
    setError('');
    try {
      await bridge.dingtalkShareResolve(path, {
        to: recipient,
        expectedPackageHash: share.packageHash,
        outcome,
        confirmed: true,
      });
      setShare(await bridge.dingtalkShareStatus(path, recipient));
      setMessage(
        outcome === 'sent' ? t('已记录送达结果。') : t('已记录为全部未送达，可以重新确认。'),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dingtalk-panel">
      <p className="knowledge-error">
        {t('实验性功能：公式和 Mermaid 图表以图片呈现，正文与表格可以编辑。发布后请检查云端内容。')}
      </p>
      <p className="dingtalk-intro">
        {t('把当前文档发布到钉钉，与同事直接阅读和编辑。再次发布会更新同一篇在线文档。')}
      </p>
      <div className="dingtalk-file">{path.split('/').pop()}</div>
      <label>
        {t('钉钉账号')}
        <select
          aria-label={t('钉钉账号')}
          value={profile}
          disabled={!!binding || busy}
          onChange={(e) => setProfile(e.target.value)}
        >
          <option value="">{t('选择已登录的账号')}</option>
          {status?.profiles?.map((a: any) => (
            <option key={a.profile} value={a.profile}>
              {a.corpName} · {a.userName}
            </option>
          ))}
        </select>
      </label>
      {!status?.profiles?.length && status && (
        <p className="dingtalk-note">
          {t('使用本机 dws 登录后，重新打开此面板。')}
          <code>dws auth login --recommend</code>
        </p>
      )}
      <div className="dingtalk-target">
        <span>{binding ? t('对应文档') : t('首次发布位置')}</span>
        <strong>{binding?.name || t('我的文档')}</strong>
      </div>
      {busy && (
        <p className="dingtalk-note" role="status">
          {t('正在处理文档…')}
        </p>
      )}
      {plan && !busy && (
        <div className="dingtalk-preview">
          <strong>
            {plan.action === 'current'
              ? t('文档已同步')
              : plan.action === 'update'
                ? t('更新现有钉钉文档')
                : t('创建钉钉在线文档')}
          </strong>
          <p>
            {t('{formulas} 个公式 · {tables} 个表格 · {images} 张图片', plan.stats)}{' '}
            {plan.stats.diagrams ? t('（含 {0} 个图表）', { '0': plan.stats.diagrams }) : ''}
          </p>
          <p>
            {t(
              '正文和表格可在钉钉编辑，公式与 Mermaid 图表以图片呈现。本地 Markdown 和 LaTeX 源码保留。',
            )}
          </p>
          {plan.warnings.map((w: string) => (
            <p key={w}>{t(w)}</p>
          ))}
          {plan.requiresReview && (
            <section aria-label={t('发布前版本审阅')}>
              <p>{t('确认更新会将下面的云端版本替换为本地版本。请先保留需要的云端修改。')}</p>
              <h4>{t('钉钉当前内容（文字节选）')}</h4>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                {plan.remotePreview}
              </pre>
              <h4>{t('本次发布内容（文字节选）')}</h4>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                {plan.localPreview}
              </pre>
            </section>
          )}
        </div>
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
      <div className="dingtalk-actions">
        <button disabled={busy || !profile} onClick={() => setReload((n) => n + 1)}>
          {t('重新检查')}
        </button>
        {binding && binding.state !== 'synced' ? (
          <button disabled={busy} onClick={() => void reconcile()}>
            {t('检查上次结果')}
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !plan || plan.action === 'current'}
            onClick={() => void publish()}
          >
            {plan?.action === 'update' ? t('确认更新到钉钉') : t('发布到钉钉')}
          </button>
        )}
      </div>
      {url && (
        <div className="dingtalk-links">
          <button onClick={() => void bridge.openLink(url, path)}>{t('在钉钉打开')}</button>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(url).then(() => setMessage(t('文档链接已复制。')))
            }
          >
            {t('复制链接')}
          </button>
        </div>
      )}
      {binding && (
        <details className="dingtalk-recovery">
          <summary>{t('同步问题处理')}</summary>
          {!binding.nodeId && (
            <label>
              {t('已创建的钉钉文档 ID')}
              <input
                value={candidate}
                onChange={(e) => {
                  setCandidate(e.target.value);
                  setInspection(null);
                  setAcknowledged(false);
                }}
                placeholder={t('在钉钉核实文档后填写')}
              />
            </label>
          )}
          <button disabled={busy} onClick={() => void inspectRecovery()}>
            {t('读取云端版本')}
          </button>
          {inspection?.remote && (
            <section>
              <p>
                {inspection.remote.name} ·{' '}
                {t('版本 {revision}', { revision: inspection.remote.revision })}
              </p>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
                {inspection.remote.preview}
              </pre>
              <p>
                {inspection.matchesSubmitted
                  ? t('内容与上次提交一致。')
                  : t('云端内容与上次提交不同；采用此版本后仍需单独确认下一次更新。')}
              </p>
            </section>
          )}
          <p>
            {t(
              '解除关联会保留云端文档，下一次发布将创建新文档。尚未取得文档 ID 时，请先确认是否已创建，避免重复发布。',
            )}
          </p>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            {t('我已在钉钉核对上述结果')}
          </label>
          {inspection?.matchesSubmitted && (
            <button disabled={busy || !acknowledged} onClick={() => void recover('attach')}>
              {t('确认关联这篇文档')}
            </button>
          )}
          {binding.nodeId && inspection?.remote && !inspection.matchesSubmitted && (
            <button disabled={busy || !acknowledged} onClick={() => void recover('adopt-remote')}>
              {t('采用云端当前版本作为同步起点')}
            </button>
          )}
          {binding.nodeId ? (
            <button disabled={busy || !acknowledged} onClick={() => void recover('detach')}>
              {t('保留云端文档并解除关联')}
            </button>
          ) : (
            <button
              disabled={busy || !acknowledged || !!inspection?.remote}
              onClick={() => void recover('confirm-not-created')}
            >
              {t('确认未创建，允许重新发布')}
            </button>
          )}
        </details>
      )}
      {url && binding?.state === 'synced' && (
        <details className="dingtalk-send">
          <summary>{t('发送链接给同事')}</summary>
          <label>
            {t('接收人姓名')}
            <input
              aria-label={t('钉钉接收人')}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={t('多个姓名用逗号分隔')}
            />
          </label>
          <p>{t('此按钮发送文档链接。访问权限请在钉钉中设置。')}</p>
          <button
            disabled={
              busy ||
              !recipient.trim() ||
              pendingShare ||
              share?.record?.state === 'sent' ||
              binding.requiresReview
            }
            onClick={() => void sendLink()}
          >
            {t('确认发送链接')}
          </button>
          {pendingShare && (
            <section>
              <p>
                {t(
                  '上次发送结果尚未确认。请在钉钉逐一核对接收人；部分送达时先手动补发缺失接收人，再确认全部送达。',
                )}
              </p>
              <button disabled={busy} onClick={() => void resolveShare('sent')}>
                {t('已核实全部送达')}
              </button>
              <button disabled={busy} onClick={() => void resolveShare('not-sent')}>
                {t('已核实均未送达')}
              </button>
            </section>
          )}
        </details>
      )}
      <p className="dingtalk-note">
        {t('发布将正文和图片上传至所选钉钉账号。云端出现独立修改时暂停同步，先保留同事的内容。')}
      </p>
    </div>
  );
}
