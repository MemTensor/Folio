const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { spawn } = require('node:child_process');

class DingTalkError extends Error {
  constructor(message, code = 'DINGTALK_ERROR', details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const redact = (text) =>
  String(text)
    .replace(/(?:gh[pousr]_|github_pat_|mpg-|sk-)[A-Za-z0-9_-]{16,}/g, '[已隐藏]')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|appSecret|clientSecret)\s*[=:]\s*)[^\s,}"']+/gi,
      '$1[已隐藏]',
    );
async function findDws() {
  const candidates = [
    process.env.FOLIO_DWS_BIN,
    '/opt/homebrew/bin/dws',
    '/usr/local/bin/dws',
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.join(p, 'dws')),
  ].filter(Boolean);
  for (const candidate of candidates)
    try {
      await fs.access(candidate, require('node:fs').constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  return null;
}
async function invokeDws(binary, args, { input, timeout = 45000 } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-dingtalk-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: [path.dirname(binary), process.env.PATH || '', '/usr/bin', '/bin'].join(
            path.delimiter,
          ),
        },
      });
      const stdout = [],
        stderr = [];
      let bytes = 0,
        timedOut = false,
        overflow = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);
      const read = (stream, part) => {
        bytes += part.length;
        if (bytes > 24 * 1024 * 1024) {
          overflow = true;
          child.kill('SIGKILL');
          return;
        }
        if (stream === 'out') stdout.push(part);
        else stderr.push(part);
      };
      child.stdout.on('data', (part) => read('out', part));
      child.stderr.on('data', (part) => read('err', part));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new DingTalkError(redact(error.message), 'DWS_UNAVAILABLE'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut || overflow)
          return reject(
            new DingTalkError(
              timedOut ? '钉钉操作超时，请先检查结果。' : '钉钉返回内容过大，请先检查结果。',
              'DWS_UNKNOWN',
            ),
          );
        let result, error;
        try {
          result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        } catch {}
        try {
          error = JSON.parse(Buffer.concat(stderr).toString('utf8'))?.error;
        } catch {}
        if (code !== 0 || result?.error || result?.success === false) {
          error = error || result?.error;
          const category = error?.category;
          return reject(
            new DingTalkError(
              redact(error?.message || '钉钉 CLI 未能完成操作。'),
              category === 'auth'
                ? 'DWS_AUTH'
                : category === 'validation'
                  ? 'DWS_VALIDATION'
                  : 'DWS_ERROR',
              {
                reason: error?.reason,
                category,
                exitCode: code,
                nodeId: error?.details?.data?.nodeId,
                executionStarted: error?.execution_started,
                status: error?.details?.status,
              },
            ),
          );
        }
        if (!result || typeof result !== 'object')
          return reject(new DingTalkError('钉钉未返回可确认的结果。', 'DWS_UNKNOWN'));
        resolve(result);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input === undefined ? '' : input);
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
class DingTalkClient {
  constructor({ runner = invokeDws, binary } = {}) {
    this.runner = runner;
    this.binary = binary;
  }
  async run(args, { profile, input, timeout } = {}) {
    const binary = this.binary || (await findDws());
    if (!binary)
      throw new DingTalkError('请先安装钉钉 CLI（dws），并在本机完成登录。', 'DWS_UNAVAILABLE');
    if (
      profile &&
      (typeof profile !== 'string' || !profile.includes(':') || /[\r\n,]/.test(profile))
    )
      throw new DingTalkError('请选择一个明确的钉钉账号。', 'DWS_PROFILE');
    return this.runner(
      binary,
      [...args, '--format', 'json', ...(profile ? ['--profile', profile] : [])],
      { input, timeout },
    );
  }
  async profiles() {
    const data = await this.run(['profile', 'list']);
    if (!Array.isArray(data.profiles))
      throw new DingTalkError('钉钉未返回账号列表。', 'DWS_PROFILE');
    const profiles = data.profiles
      .filter((p) => typeof p.profile === 'string' && p.profile.includes(':'))
      .map((p) => ({
        profile: p.profile,
        corpName: p.corpName || '',
        userName: p.userName || '',
        isCurrent: p.isCurrent === true,
        isOrgCurrent: p.isOrgCurrent === true,
        status: p.status || 'unknown',
      }));
    const current = profiles.find((p) => p.profile === data.currentProfile && p.isOrgCurrent);
    return { profiles, currentProfile: current?.profile || null };
  }
  async fetch(node, profile) {
    const receipt = await this.run(
        ['doc', '+fetch', '--node', node, '--scope', 'full', '--detail', 'full'],
        { profile },
      ),
      data = receipt.content;
    if (
      receipt.status !== 'success' ||
      receipt.complete !== true ||
      !data ||
      data.nodeId !== node ||
      data.success === false
    )
      throw new DingTalkError('无法完整读取钉钉在线文档。', 'DWS_UNKNOWN');
    let jsonml;
    try {
      jsonml = typeof data.jsonml === 'string' ? JSON.parse(data.jsonml) : data.jsonml;
    } catch {}
    const revision = Number(data.revision);
    if (
      !Array.isArray(jsonml) ||
      jsonml[0] !== 'root' ||
      data.revision === undefined ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      throw new DingTalkError('钉钉未返回完整正文和有效版本号。', 'DWS_UNKNOWN');
    return { nodeId: node, jsonml, revision, name: data.title, url: safeDocUrl(data.docUrl) };
  }
  async create(name, profile, content) {
    return docReceipt(
      await this.run(
        ['doc', '+create', '--name', name, '--doc-format', 'jsonml', '--content', '-'],
        { profile, input: content },
      ),
    );
  }
  async overwrite(node, profile, content, revision) {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new DingTalkError('缺少钉钉版本号，已停止同步。', 'DWS_CONFLICT');
    return docReceipt(
      await this.run(
        [
          'doc',
          '+update',
          '--node',
          node,
          '--command',
          'overwrite',
          '--doc-format',
          'jsonml',
          '--content',
          '-',
          '--expected-revision',
          String(revision),
          '--yes',
        ],
        { profile, input: content },
      ),
      node,
    );
  }
  async share(url, profile, to) {
    if (
      !safeDocUrl(url) ||
      typeof to !== 'string' ||
      !to.trim() ||
      to.length > 200 ||
      /[\r\n]/.test(to)
    )
      throw new DingTalkError('请填写接收人姓名。', 'USAGE');
    const receipt = await this.run(['doc', '+share', '--url', url, '--to', to.trim(), '--yes'], {
        profile,
      }),
      d = receipt.data;
    if (
      receipt.ok !== true ||
      receipt.status !== 'success' ||
      !Number.isInteger(d?.requestedCount) ||
      d.requestedCount < 1 ||
      d.failedCount !== 0 ||
      d.succeededCount !== d.requestedCount ||
      !Array.isArray(d.recipients) ||
      d.recipients.length !== d.requestedCount ||
      d.recipients.some((r) => r.message !== 'success')
    )
      throw new DingTalkError('发送结果未全部确认，请先在钉钉中核对，勿重复发送。', 'DWS_UNKNOWN');
    return { sent: d.succeededCount, recipients: d.recipients.map((r) => r.name) };
  }
}
function safeDocUrl(candidate) {
  try {
    const u = new URL(candidate);
    if (
      u.protocol === 'https:' &&
      u.hostname === 'alidocs.dingtalk.com' &&
      !u.username &&
      !u.password
    )
      return u.href;
  } catch {}
  return null;
}
function docReceipt(receipt, node) {
  const id = receipt?.data?.nodeId;
  if (
    receipt?.status !== 'success' ||
    receipt?.complete !== true ||
    receipt?.data?.verified !== true ||
    typeof id !== 'string' ||
    (node && id !== node)
  )
    throw new DingTalkError('钉钉操作结果尚未完整确认，请先检查已有文档。', 'DWS_UNKNOWN', {
      nodeId: id,
      status: receipt?.status,
    });
  return { nodeId: id };
}
module.exports = { DingTalkClient, DingTalkError, invokeDws, findDws, safeDocUrl, docReceipt };
