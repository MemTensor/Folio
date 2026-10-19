const { UUID } = require('./identifiers.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJSON, writeJSON, withLock, digest } = require('./state.cjs');
const { DingTalkClient, DingTalkError } = require('./dingtalk-cli.cjs');
const { documentProjection, matchesProjection } = require('./dingtalk-document.cjs');

function confirm(value) {
  if (value !== true)
    throw new DingTalkError('请先确认文档、账号和本次操作。', 'CONFIRMATION_REQUIRED');
}
function nodeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw new DingTalkError('请输入有效的钉钉文档 ID。', 'USAGE');
  return value;
}
function recipient(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n]/.test(value))
    throw new DingTalkError('请填写接收人姓名。', 'USAGE');
  return value.trim();
}
function excerpt(jsonml) {
  const lines = [];
  const visit = (node) => {
    if (!Array.isArray(node)) return;
    if (node[0] === 'img') {
      lines.push('[图片]');
      return;
    }
    if (node[0] === 'code') lines.push(node[1]?.code || '');
    for (const child of node.slice(2)) {
      if (typeof child === 'string') lines.push(child);
      else visit(child);
    }
  };
  visit(jsonml);
  return lines.join('\n').slice(0, 6000);
}
function safeBeforeWrite(error) {
  return (
    error.details?.executionStarted === false ||
    ['DWS_UNAVAILABLE', 'DWS_CONFLICT'].includes(error.code)
  );
}

class DingTalkSync {
  constructor(dataDir, { client = new DingTalkClient() } = {}) {
    this.dataDir = dataDir;
    this.client = client;
  }
  bindingFile(id) {
    if (typeof id !== 'string' || !UUID.test(id))
      throw new DingTalkError('文档身份无效，请重新打开项目。', 'CONFIG');
    return path.join(this.dataDir, 'dingtalk', 'documents', id + '.json');
  }
  planFile(id) {
    if (typeof id !== 'string' || !UUID.test(id))
      throw new DingTalkError('同步计划无效。', 'USAGE');
    return path.join(this.dataDir, 'dingtalk', 'plans', id + '.json');
  }
  visible(binding) {
    const fields = [
      'documentId',
      'path',
      'root',
      'profile',
      'account',
      'nodeId',
      'url',
      'name',
      'state',
      'planId',
      'sourceRevision',
      'packageHash',
      'startedAt',
      'syncedAt',
      'remoteRevision',
      'reason',
      'stage',
      'runtimeVerification',
      'requiresReview',
      'recoveryId',
    ];
    return Object.fromEntries(
      fields.filter((key) => Object.hasOwn(binding, key)).map((key) => [key, binding[key]]),
    );
  }
  async info(knowledge, p) {
    const { file, document } = await knowledge.inspect(p);
    let connection;
    try {
      connection = await this.client.profiles();
    } catch (error) {
      connection = { profiles: [], currentProfile: null, error: error.message };
    }
    const binding = await readJSON(this.bindingFile(document.id));
    return {
      path: file.path,
      name: path.basename(file.path),
      ...connection,
      binding: binding ? this.visible(binding) : null,
    };
  }
  async pruneExpiredPlans() {
    const directory = path.join(this.dataDir, 'dingtalk', 'plans');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let scanned = 0,
      removed = 0;
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (++scanned > 2048 || removed >= 32) break;
      if (!entry.isFile() || !entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0, -5)))
        continue;
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
      if (process.getuid && stat.uid !== process.getuid()) continue;
      await fs.unlink(file).catch(() => {});
      removed++;
    }
    return removed;
  }
  async plan(knowledge, p, { profile, diagrams = [], expectedRevision } = {}) {
    const { file, document } = await knowledge.inspect(p);
    if (expectedRevision !== undefined && expectedRevision !== file.hash)
      throw new DingTalkError('文档已变化，请重新生成预览。', 'CONFLICT');
    if (!Array.isArray(diagrams) || (diagrams.length && !expectedRevision))
      throw new DingTalkError('图表预览必须绑定文档版本，请重新生成预览。', 'DWS_STALE_PLAN');
    const binding = await readJSON(this.bindingFile(document.id));
    const accounts = await this.client.profiles();
    profile = binding?.profile || profile || accounts.currentProfile;
    const account = accounts.profiles.find((a) => a.profile === profile);
    if (!account) throw new DingTalkError('请选择并登录一个明确的钉钉账号。', 'DWS_PROFILE');
    if (binding && binding.state !== 'synced')
      throw new DingTalkError('上次操作尚未确认，请先检查同步结果。', 'DWS_UNKNOWN', {
        nodeId: binding.nodeId,
      });
    const projection = await documentProjection(file, knowledge.store, { diagrams });
    let remote = null;
    if (binding) {
      remote = await this.client.fetch(binding.nodeId, profile);
      if (remote.revision !== binding.remoteRevision)
        throw new DingTalkError(
          '钉钉文档已被修改。请先查看云端版本，Folio 不会覆盖这些修改。',
          'DWS_CONFLICT',
          { url: remote.url },
        );
    }
    const plan = {
      id: crypto.randomUUID(),
      documentId: document.id,
      path: file.path,
      root: knowledge.store.root,
      profile,
      account: account.corpName + ' · ' + account.userName,
      name: path.basename(file.path).replace(/\.[^.]+$/, ''),
      sourceRevision: file.hash,
      packageHash: projection.packageHash,
      assets: projection.assets,
      stats: projection.stats,
      warnings: projection.warnings,
      jsonml: projection.jsonml,
      action: binding
        ? binding.packageHash === projection.packageHash
          ? 'current'
          : 'update'
        : 'create',
      bindingPlanId: binding?.planId || null,
      nodeId: binding?.nodeId || null,
      url: remote?.url || binding?.url || null,
      expectedRevision: remote?.revision ?? null,
      createdAt: Date.now(),
      ...(binding?.requiresReview
        ? {
            remotePreview: excerpt(remote.jsonml),
            localPreview: excerpt(projection.jsonml),
            requiresReview: true,
          }
        : {}),
    };
    await this.pruneExpiredPlans();
    await writeJSON(this.planFile(plan.id), plan);
    const { jsonml, assets, ...visible } = plan;
    return visible;
  }
  async execute(knowledge, id, { confirmed = false, expectedPath } = {}) {
    confirm(confirmed);
    const plan = await readJSON(this.planFile(id));
    if (!plan || plan.root !== knowledge.store.root || Date.now() - plan.createdAt > 10 * 60 * 1000)
      throw new DingTalkError('同步预览已过期，请重新检查。', 'DWS_STALE_PLAN');
    if (expectedPath && (await knowledge.store.safe(expectedPath)) !== plan.path)
      throw new DingTalkError('发布预览属于另一份文档。', 'CONFLICT');
    return withLock(this.dataDir, 'dingtalk:' + plan.documentId, async () => {
      const current = await knowledge.inspect(plan.path);
      if (current.document.id !== plan.documentId || current.file.hash !== plan.sourceRevision)
        throw new DingTalkError('本地文档已变化，请重新检查后再发布。', 'CONFLICT');
      for (const asset of plan.assets) {
        const safe = await knowledge.store.safe(asset.path);
        if (digest(await fs.readFile(safe)) !== asset.hash)
          throw new DingTalkError('本地图片已变化，请重新生成预览。', 'CONFLICT');
      }
      const file = this.bindingFile(plan.documentId),
        binding = await readJSON(file);
      if (binding?.state === 'synced' && binding.planId === id)
        return { ...this.visible(binding), replayed: true };
      if (binding && binding.state !== 'synced')
        throw new DingTalkError('上次提交结果尚未确认，请先检查结果。', 'DWS_UNKNOWN');
      if ((binding?.planId || null) !== plan.bindingPlanId)
        throw new DingTalkError('同步状态已变化，请重新生成预览。', 'CONFLICT');
      if (
        (binding?.nodeId || null) !== plan.nodeId ||
        (binding?.profile && binding.profile !== plan.profile)
      )
        throw new DingTalkError('同步目标已变化，请重新检查。', 'CONFLICT');
      if (plan.nodeId) {
        const remote = await this.client.fetch(plan.nodeId, plan.profile);
        if (remote.revision !== plan.expectedRevision)
          throw new DingTalkError('钉钉出现新的修改，已停止同步。', 'DWS_CONFLICT');
      }
      if (plan.action === 'current') return { ...this.visible(binding), unchanged: true };
      const record = {
        documentId: plan.documentId,
        path: plan.path,
        root: plan.root,
        profile: plan.profile,
        account: plan.account,
        nodeId: plan.nodeId,
        url: plan.url,
        name: plan.name,
        state: 'sending',
        planId: id,
        sourceRevision: plan.sourceRevision,
        packageHash: plan.packageHash,
        jsonml: plan.jsonml,
        startedAt: Date.now(),
      };
      await writeJSON(file, record);
      // A readback error says nothing about whether the preceding write succeeded.
      let writeAccepted = false,
        writeNotStarted = false;
      try {
        try {
          const result = plan.nodeId
            ? await this.client.overwrite(
                plan.nodeId,
                plan.profile,
                JSON.stringify(plan.jsonml),
                plan.expectedRevision,
              )
            : await this.client.create(plan.name, plan.profile, JSON.stringify(plan.jsonml));
          record.nodeId = result.nodeId;
          writeAccepted = true;
        } catch (error) {
          if (error.details?.nodeId) record.nodeId = error.details.nodeId;
          if (error.details?.reason !== 'doc_write_verification_failed' || !record.nodeId) {
            if (safeBeforeWrite(error) && !error.details?.nodeId) {
              if (binding) await writeJSON(file, binding);
              else await fs.unlink(file);
              writeNotStarted = true;
              throw error;
            }
            throw error;
          }
          writeAccepted = true;
          record.runtimeVerification = 'readback-required';
        }
        record.stage = 'readback';
        await writeJSON(file, record);
        const remote = await this.client.fetch(record.nodeId, record.profile);
        if (!matchesProjection(plan.jsonml, remote.jsonml))
          throw new DingTalkError('钉钉返回内容与发布内容不一致，请先检查文档。', 'DWS_UNKNOWN');
        Object.assign(record, {
          state: 'synced',
          name: remote.name || record.name,
          url: remote.url,
          remoteRevision: remote.revision,
          syncedAt: Date.now(),
        });
        await writeJSON(file, record);
        return this.visible(record);
      } catch (error) {
        if (!writeNotStarted) {
          record.state = 'uncertain';
          record.reason = error.code || 'DWS_ERROR';
          record.stage = writeAccepted ? 'readback' : 'write';
          await writeJSON(file, record);
        }
        throw new DingTalkError(error.message, error.code || 'DWS_UNKNOWN', {
          ...error.details,
          nodeId: record.nodeId,
          url: record.url,
        });
      }
    });
  }
  async reconcile(knowledge, p) {
    const { document } = await knowledge.inspect(p),
      file = this.bindingFile(document.id);
    return withLock(this.dataDir, 'dingtalk:' + document.id, async () => {
      const binding = await readJSON(file);
      if (!binding?.nodeId)
        throw new DingTalkError(
          '没有可核对的文档 ID。请关联已创建的钉钉文档，或核实未创建后结束这次操作。',
          'DWS_UNKNOWN',
        );
      const remote = await this.client.fetch(binding.nodeId, binding.profile);
      if (!matchesProjection(binding.jsonml, remote.jsonml))
        throw new DingTalkError(
          '云端内容与提交内容不同，请查看差异并选择如何继续。',
          'DWS_CONFLICT',
          { url: remote.url },
        );
      Object.assign(binding, {
        state: 'synced',
        url: remote.url,
        remoteRevision: remote.revision,
        syncedAt: Date.now(),
      });
      await writeJSON(file, binding);
      return this.visible(binding);
    });
  }
  async recoveryInfo(knowledge, p, { nodeId: candidate } = {}) {
    const { document } = await knowledge.inspect(p),
      binding = await readJSON(this.bindingFile(document.id));
    if (!binding) throw new DingTalkError('当前文档没有需要恢复的关联。', 'USAGE');
    const target = candidate || binding.nodeId;
    if (!target) return { binding: this.visible(binding), remote: null };
    if (binding.nodeId && candidate && candidate !== binding.nodeId)
      throw new DingTalkError('请核对当前已关联的钉钉文档。', 'CONFLICT');
    const remote = await this.client.fetch(nodeId(target), binding.profile);
    return {
      binding: this.visible(binding),
      remote: { ...remote, jsonml: undefined, preview: excerpt(remote.jsonml) },
      submittedPreview: excerpt(binding.jsonml),
      matchesSubmitted: matchesProjection(binding.jsonml, remote.jsonml),
    };
  }
  async recover(
    knowledge,
    p,
    { action, expectedPlanId, nodeId: candidate, expectedRevision, confirmed = false } = {},
  ) {
    confirm(confirmed);
    if (!['attach', 'adopt-remote', 'detach', 'confirm-not-created'].includes(action))
      throw new DingTalkError('恢复操作无效。', 'USAGE');
    const { document } = await knowledge.inspect(p),
      file = this.bindingFile(document.id);
    return withLock(this.dataDir, 'dingtalk:' + document.id, async () => {
      const binding = await readJSON(file);
      if (!binding || !expectedPlanId || binding.planId !== expectedPlanId)
        throw new DingTalkError('同步状态已变化，请重新检查。', 'CONFLICT');
      if (
        action === 'confirm-not-created' &&
        (binding.nodeId || !['uncertain', 'sending'].includes(binding.state))
      )
        throw new DingTalkError('只能在未取得文档 ID 且已核实未创建时使用此操作。', 'USAGE');
      if (action === 'detach' && !binding.nodeId)
        throw new DingTalkError('请先核实上次是否创建了文档。', 'DWS_UNKNOWN');
      let remote;
      if (action === 'attach' || action === 'adopt-remote') {
        if (action === 'attach' && binding.nodeId && candidate !== binding.nodeId)
          throw new DingTalkError('已有文档关联，不能更换为另一篇文档。', 'CONFLICT');
        if (action === 'adopt-remote' && !binding.nodeId)
          throw new DingTalkError('请先关联并核实已创建的文档。', 'USAGE');
        remote = await this.client.fetch(nodeId(binding.nodeId || candidate), binding.profile);
        if (!Number.isSafeInteger(expectedRevision) || remote.revision !== expectedRevision)
          throw new DingTalkError('钉钉版本已变化，请重新检查。', 'DWS_CONFLICT');
        if (action === 'attach' && !matchesProjection(binding.jsonml, remote.jsonml))
          throw new DingTalkError('这篇钉钉文档与上次提交内容不同，尚未建立关联。', 'DWS_CONFLICT');
      }
      const recoveryId = crypto.randomUUID();
      await writeJSON(path.join(this.dataDir, 'dingtalk', 'recoveries', recoveryId + '.json'), {
        id: recoveryId,
        action,
        binding,
        remoteRevision: remote?.revision,
        at: Date.now(),
      });
      if (action === 'detach' || action === 'confirm-not-created') {
        await fs.unlink(file);
        return {
          state: 'detached',
          recoveryId,
          remotePreserved: Boolean(binding.nodeId),
          nodeId: binding.nodeId,
          url: binding.url,
        };
      }
      Object.assign(binding, {
        nodeId: remote.nodeId,
        name: remote.name || binding.name,
        url: remote.url,
        remoteRevision: remote.revision,
        state: 'synced',
        syncedAt: Date.now(),
        planId: crypto.randomUUID(),
        recoveryId,
      });
      if (action === 'adopt-remote') {
        binding.jsonml = remote.jsonml;
        binding.packageHash = null;
        binding.requiresReview = true;
      }
      await writeJSON(file, binding);
      return this.visible(binding);
    });
  }
  async shareContext(knowledge, p, to) {
    to = recipient(to);
    const { document } = await knowledge.inspect(p),
      binding = await readJSON(this.bindingFile(document.id));
    if (binding?.state !== 'synced' || !binding.url)
      throw new DingTalkError('请先成功发布文档。', 'DWS_UNKNOWN');
    const key = digest(document.id + '\n' + binding.packageHash + '\n' + to);
    return { to, binding, key, file: path.join(this.dataDir, 'dingtalk', 'shares', key + '.json') };
  }
  async shareStatus(knowledge, p, to) {
    const context = await this.shareContext(knowledge, p, to);
    return { packageHash: context.binding.packageHash, record: await readJSON(context.file) };
  }
  async resolveShare(knowledge, p, { to, expectedPackageHash, outcome, confirmed = false } = {}) {
    confirm(confirmed);
    if (!['sent', 'not-sent'].includes(outcome))
      throw new DingTalkError('请选择已送达或确认均未送达。', 'USAGE');
    const context = await this.shareContext(knowledge, p, to);
    if (!expectedPackageHash || expectedPackageHash !== context.binding.packageHash)
      throw new DingTalkError('文档版本已变化，请重新核对发送记录。', 'CONFLICT');
    return withLock(this.dataDir, 'dingtalk-share:' + context.key, async () => {
      const record = await readJSON(context.file);
      if (!record || !['sending', 'uncertain'].includes(record.state))
        throw new DingTalkError('当前没有待确认的发送记录。', 'USAGE');
      record.resolutions = [
        ...(record.resolutions || []),
        { outcome, at: Date.now(), evidence: 'operator-confirmed' },
      ];
      record.state = outcome === 'sent' ? 'sent' : 'retryable';
      await writeJSON(context.file, record);
      return record;
    });
  }
  async share(knowledge, p, { to, confirmed = false } = {}) {
    confirm(confirmed);
    const { binding, key, file, to: normalized } = await this.shareContext(knowledge, p, to);
    if (binding.requiresReview)
      throw new DingTalkError('请先完成本地与钉钉版本的审阅。', 'DWS_CONFLICT');
    return withLock(this.dataDir, 'dingtalk-share:' + key, async () => {
      const prior = await readJSON(file);
      if (prior?.state === 'sent') return { ...prior, replayed: true };
      if (prior && prior.state !== 'retryable')
        throw new DingTalkError('上次发送尚未确认，请先在钉钉中核对。', 'DWS_UNKNOWN');
      const record = {
        state: 'sending',
        to: normalized,
        nodeId: binding.nodeId,
        createdAt: Date.now(),
        resolutions: prior?.resolutions || [],
      };
      await writeJSON(file, record);
      try {
        const receipt = await this.client.share(binding.url, binding.profile, normalized);
        Object.assign(record, receipt, { state: 'sent' });
        await writeJSON(file, record);
        return record;
      } catch (error) {
        record.state = 'uncertain';
        await writeJSON(file, record);
        throw error;
      }
    });
  }
}
module.exports = { DingTalkSync };
