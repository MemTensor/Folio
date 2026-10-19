const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { UpdateError, releaseCandidate, checksumFor } = require('./update-release.cjs');
const { GitHubUpdateSource } = require('./update-source.cjs');
const { updateErrorPresentation } = require('./update-messages.cjs');
const hashFile = async (file, signal) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    if (signal?.aborted) throw new UpdateError('CANCELED', '已取消更新下载。');
    hash.update(chunk);
  }
  return hash.digest('hex');
};
const publicError = (error) => updateErrorPresentation(error).status;
class UpdateService {
  constructor({
    currentVersion,
    platform = process.platform,
    arch = process.arch,
    supported = true,
    dataDir,
    source = new GitHubUpdateSource(),
    installer,
    onChange = () => {},
  }) {
    this.currentVersion = currentVersion;
    this.platform = platform;
    this.arch = arch;
    this.dataDir = dataDir;
    this.source = source;
    this.installer = installer;
    this.onChange = onChange;
    this.state = {
      phase: 'idle',
      currentVersion,
      supported: supported && platform === 'darwin' && ['arm64', 'x64'].includes(arch),
    };
    this.candidate = null;
    this.downloaded = null;
    this.controller = null;
    this.ticket = null;
    this.prepared = null;
    this.initialized = null;
  }
  emit(patch) {
    // A message and its values travel together, so a new message never keeps the
    // numbers or version of the one it replaced.
    if ('message' in patch && !('messageVars' in patch))
      patch = { ...patch, messageVars: undefined };
    this.state = { ...this.state, ...patch };
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  snapshot() {
    return structuredClone(this.state);
  }
  async initialize() {
    if (!this.initialized)
      this.initialized = (async () => {
        const dir = path.join(this.dataDir, 'updates', 'downloads');
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        for (const entry of await fs.readdir(dir, { withFileTypes: true }))
          if (entry.isDirectory() && /^download-[A-Za-z0-9-]+$/.test(entry.name))
            await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
        let result;
        try {
          result = await this.installer?.readResult();
        } catch {
          this.emit({ message: '上次更新记录暂不可用，仍可检查新版本。' });
        }
        if (result?.status === 'rolled-back')
          this.emit({ message: '上次更新未能启动，已恢复旧版本。' });
        else if (result?.status === 'failed')
          this.emit({ message: '上次更新未完成，原应用和恢复草稿已保留。' });
        else if (result?.status === 'awaiting-confirmation')
          this.emit({
            message: '上次更新尚未完成启动确认，旧版本备份仍保留。请正常退出并重新打开应用。',
          });
        else if (result?.status === 'confirmed' && result.version === this.currentVersion)
          this.emit({
            message: '已更新到 {version}。',
            messageVars: { version: this.currentVersion },
          });
      })().catch((error) => {
        this.initialized = null;
        throw error;
      });
    return this.initialized;
  }
  async status() {
    try {
      await this.initialize();
      return this.snapshot();
    } catch (error) {
      return this.emit({ phase: 'error', ...publicError(error) });
    }
  }
  async check() {
    try {
      await this.initialize();
    } catch (error) {
      return this.emit({ phase: 'error', ...publicError(error) });
    }
    if (this.controller || this.ticket) return this.snapshot();
    if (this.platform !== 'darwin')
      return this.emit({
        phase: 'error',
        errorCode: 'UNSUPPORTED',
        message: '当前应用内更新仅支持 macOS 桌面版。',
      });
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.emit({ phase: 'checking', message: undefined, errorCode: undefined, progress: undefined });
    try {
      const releases = await this.source.listReleases({ signal });
      if (signal.aborted) throw new UpdateError('CANCELED', '已取消检查。');
      const candidate = releaseCandidate(releases, this.currentVersion, this.arch);
      this.candidate = candidate;
      this.downloaded = null;
      return this.emit({
        phase: candidate ? 'available' : 'current',
        available: candidate
          ? {
              version: candidate.version,
              notes: candidate.notes,
              publishedAt: candidate.publishedAt,
              size: candidate.asset.size,
            }
          : undefined,
        message: candidate ? '发现新版本。' : '当前没有更高的已发布版本。',
      });
    } catch (error) {
      return this.emit(
        error.code === 'CANCELED'
          ? { phase: 'idle', message: '已取消检查。' }
          : { phase: 'error', ...publicError(error) },
      );
    } finally {
      this.controller = null;
    }
  }
  async download() {
    try {
      await this.initialize();
    } catch (error) {
      return this.emit({ phase: 'error', ...publicError(error) });
    }
    if (this.controller || this.ticket) return this.snapshot();
    if (!this.state.supported)
      throw new UpdateError('UNSUPPORTED', '请在已安装的 Folio 桌面应用中下载和安装更新。');
    if (!this.candidate) throw new UpdateError('NO_UPDATE', '请先检查更新。');
    this.controller = new AbortController();
    const signal = this.controller.signal,
      candidate = this.candidate;
    let dir;
    this.emit({
      phase: 'downloading',
      message: '正在下载更新…',
      errorCode: undefined,
      progress: { received: 0, total: candidate.asset.size, percent: 0 },
    });
    try {
      dir = await fs.mkdtemp(path.join(this.dataDir, 'updates', 'downloads', 'download-'));
      const checksums = await this.source.asset(candidate.checksum, { signal });
      if (checksums.length !== candidate.checksum.size)
        throw new UpdateError('BAD_CHECKSUM', '校验文件下载不完整，请重试。');
      if (
        candidate.checksum.digest &&
        crypto.createHash('sha256').update(checksums).digest('hex') !== candidate.checksum.digest
      )
        throw new UpdateError('BAD_CHECKSUM', '校验文件与发布记录不一致。');
      const sha256 = checksumFor(checksums.toString('utf8'), candidate.asset.name);
      if (candidate.asset.digest && sha256 !== candidate.asset.digest)
        throw new UpdateError('BAD_CHECKSUM', '安装包的发布校验记录不一致。');
      const archivePath = path.join(dir, candidate.asset.name);
      let reported = 0;
      await this.source.asset(candidate.asset, {
        signal,
        destination: archivePath,
        onProgress: (received) => {
          if (Date.now() - reported < 150 && received !== candidate.asset.size) return;
          reported = Date.now();
          this.emit({
            progress: {
              received,
              total: candidate.asset.size,
              percent: Math.min(100, Math.floor((received / candidate.asset.size) * 100)),
            },
          });
        },
      });
      if (signal.aborted) throw new UpdateError('CANCELED', '已取消更新下载。');
      this.emit({ message: '正在校验安装包…' });
      const stat = await fs.stat(archivePath);
      if (stat.size !== candidate.asset.size || (await hashFile(archivePath, signal)) !== sha256)
        throw new UpdateError('BAD_CHECKSUM', '安装包校验失败，原应用保持不变，请重新下载。');
      if (signal.aborted) throw new UpdateError('CANCELED', '已取消更新下载。');
      this.downloaded = {
        archivePath,
        version: candidate.version,
        sha256,
        size: candidate.asset.size,
      };
      return this.emit({
        phase: 'ready',
        message: '更新已下载并通过校验，可以重新打开应用以完成安装。',
        progress: { received: stat.size, total: stat.size, percent: 100 },
      });
    } catch (error) {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return this.emit(
        error.code === 'CANCELED'
          ? { phase: 'available', message: '下载已取消。', progress: undefined }
          : { phase: 'error', ...publicError(error) },
      );
    } finally {
      this.controller = null;
    }
  }
  cancel() {
    if (this.ticket) throw new UpdateError('BUSY', '正在准备安装，请稍候。');
    this.controller?.abort();
  }
  beginInstall() {
    if (
      this.state.phase !== 'ready' ||
      !this.downloaded ||
      !this.state.supported ||
      this.ticket ||
      this.controller
    )
      throw new UpdateError('NOT_READY', '请先完成更新下载。');
    const requestId = crypto.randomUUID();
    this.ticket = { requestId, expires: Date.now() + 180000, consumed: false };
    this.emit({
      phase: 'preparing',
      message: '正在保留恢复草稿并准备安装…',
      errorCode: undefined,
    });
    return { requestId };
  }
  expireInstall(requestId) {
    // The gate may time out while the renderer is retaining drafts. There is no
    // installer work to abort before commit; clear synchronously so a new
    // request cannot race cleanup from the old request.
    if (this.ticket?.requestId !== requestId || this.ticket.consumed) return false;
    this.ticket = null;
    this.emit({
      phase: this.downloaded ? 'ready' : 'idle',
      message: '更新准备已超时，请重试。',
    });
    return true;
  }
  assertTicket(requestId) {
    if (
      !this.ticket ||
      this.ticket.requestId !== requestId ||
      (!this.ticket.consumed && Date.now() > this.ticket.expires)
    )
      throw new UpdateError('STALE_REQUEST', '更新确认已失效，请重新操作。');
  }
  async commitInstall({ requestId, parentPid, guard = () => true }) {
    this.assertTicket(requestId);
    if (this.ticket.consumed) throw new UpdateError('STALE_REQUEST', '此更新确认已使用。');
    this.ticket.consumed = true;
    this.controller = new AbortController();
    const check = () => {
      this.assertTicket(requestId);
      if (this.controller.signal.aborted || !guard())
        throw new UpdateError(
          'DOCUMENT_CHANGED',
          '文档在更新准备期间发生变化，请先检查内容后重试。',
        );
    };
    try {
      check();
      this.prepared = await this.installer.prepare({
        ...this.downloaded,
        signal: this.controller.signal,
        onProgress: () => this.emit({ message: '正在准备安装包，请稍候…' }),
      });
      check();
      const result = await this.installer.launch(this.prepared, { requestId, parentPid });
      check();
      this.emit({ phase: 'installing', message: '草稿已保留，正在重新打开 Folio…' });
      return result;
    } catch (error) {
      if (this.prepared) await this.installer.abort(this.prepared).catch(() => {});
      this.prepared = null;
      this.ticket = null;
      const { status, retryInstall } = updateErrorPresentation(error);
      this.emit({ phase: retryInstall && this.downloaded ? 'ready' : 'error', ...status });
      // IPC rejections are displayed separately from update-state. Give both
      // surfaces the same public wording, retaining diagnostics only in cause.
      throw Object.assign(new Error(status.message, { cause: error }), { code: error.code });
    } finally {
      this.controller = null;
    }
  }
  async abortInstall(requestId) {
    if (this.ticket?.requestId !== requestId) return;
    this.controller?.abort();
    if (this.prepared) await this.installer.abort(this.prepared);
    this.prepared = null;
    this.ticket = null;
    this.emit({ phase: this.downloaded ? 'ready' : 'idle', message: '安装已取消，文档保持原样。' });
  }
  invalidate() {
    if (this.ticket && this.state.phase !== 'installing') this.controller?.abort();
  }
  async bootReady() {
    await this.initialize();
    try {
      await this.installer?.acknowledgeStartup(this.currentVersion);
    } catch (error) {
      this.emit({ message: '启动确认暂未完成，旧版本备份已保留。' });
      throw error;
    }
  }
}
module.exports = { UpdateService, hashFile };
