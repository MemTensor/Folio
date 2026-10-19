const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REPOSITORY, UpdateError } = require('./update-release.cjs');
const API = 'https://api.github.com/';
const abortError = () => new UpdateError('CANCELED', '已取消更新下载。');
async function findGh() {
  for (const candidate of [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.join(p, 'gh')),
  ])
    try {
      await fs.access(candidate, require('node:fs').constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  return null;
}
function sourceError(status) {
  if ([401, 403, 404].includes(status))
    return new UpdateError(
      'AUTH_REQUIRED',
      '暂时无法访问更新。私有测试版请先运行 gh auth login，并确认账号有仓库访问权限；若已登录，请稍后重试。',
    );
  return new UpdateError('NETWORK', '无法连接更新服务，请检查网络后重试。');
}
class GitHubUpdateSource {
  constructor({ fetchImpl = globalThis.fetch, ghBinary, spawnImpl = spawn } = {}) {
    this.fetch = fetchImpl;
    this.ghBinary = ghBinary;
    this.spawn = spawnImpl;
  }
  async binary() {
    if (this.ghBinary === undefined) this.ghBinary = await findGh();
    return this.ghBinary;
  }
  async request(
    endpoint,
    {
      signal,
      maxBytes = 4 * 1024 * 1024,
      timeout = 30000,
      destination,
      onProgress,
      binary = false,
    } = {},
  ) {
    if (!endpoint.startsWith(`repos/${REPOSITORY}/releases`) || endpoint.includes('..'))
      throw new UpdateError('BAD_SOURCE', '更新来源无效。');
    if (signal?.aborted) throw abortError();
    const gh = await this.binary();
    if (signal?.aborted) throw abortError();
    let handle;
    if (destination) handle = await fs.open(destination, 'wx', 0o600);
    let received = 0;
    const chunks = [];
    const consume = async (chunk) => {
      received += chunk.length;
      if (received > maxBytes) throw new UpdateError('TOO_LARGE', '更新文件超过允许大小。');
      if (handle) await handle.writeFile(chunk);
      else chunks.push(Buffer.from(chunk));
      onProgress?.(received);
    };
    try {
      if (gh) await this.fromGh(gh, endpoint, { signal, timeout, binary, consume });
      else await this.fromHttp(API + endpoint, { signal, timeout, binary, consume });
      if (handle) await handle.sync();
      return destination ? { bytes: received } : Buffer.concat(chunks);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error instanceof UpdateError) throw error;
      throw sourceError(0);
    } finally {
      await handle?.close();
    }
  }
  async fromGh(gh, endpoint, { signal, timeout, binary, consume }) {
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|TMP|TEMP|LANG|LC_.*|TZ|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|XDG_CONFIG_HOME|SSH_AUTH_SOCK)$/.test(
            key,
          ),
        ),
      ),
      GH_PROMPT_DISABLED: '1',
      GH_PAGER: 'cat',
      PAGER: 'cat',
      GH_HOST: 'github.com',
    };
    delete env.GH_DEBUG;
    delete env.DEBUG;
    delete env.GIT_TRACE;
    delete env.GIT_CURL_VERBOSE;
    const child = this.spawn(
      gh,
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        '-H',
        `Accept: ${binary ? 'application/octet-stream' : 'application/vnd.github+json'}`,
        endpoint,
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env },
    );
    let stderr = '',
      timedOut = false,
      childError = null;
    child.stderr.on('data', (part) => {
      if (stderr.length < 4096) stderr += part.toString().slice(0, 4096 - stderr.length);
    });
    const finish = new Promise((resolve) => {
      child.once('error', (error) => {
        childError = error;
        resolve(null);
      });
      child.once('close', (code) => resolve(code));
    });
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      for await (const chunk of child.stdout) {
        if (signal?.aborted) throw abortError();
        await consume(chunk);
      }
      const code = await finish;
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new UpdateError('TIMEOUT', '更新服务响应超时，请重试。');
      if (childError)
        throw new UpdateError('AUTH_REQUIRED', '无法运行 GitHub 登录工具，请检查 gh 安装后重试。');
      if (code !== 0)
        throw sourceError(/401|403|404|auth login|authentication/i.test(stderr) ? 403 : 0);
    } catch (e) {
      stop();
      await finish;
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }
  async fromHttp(url, { signal, timeout, binary, consume }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    if (signal?.aborted) abort();
    try {
      let response;
      for (let redirects = 0; redirects < 5; redirects++) {
        const parsed = new URL(url);
        if (
          parsed.protocol !== 'https:' ||
          (parsed.port && parsed.port !== '443') ||
          ![
            'api.github.com',
            'github.com',
            'release-assets.githubusercontent.com',
            'objects.githubusercontent.com',
          ].includes(parsed.hostname) ||
          parsed.username ||
          parsed.password
        )
          throw new UpdateError('BAD_SOURCE', '更新下载地址无效。');
        response = await this.fetch(url, {
          headers: {
            Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
            'User-Agent': 'Folio-Update',
          },
          redirect: 'manual',
          signal: controller.signal,
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw sourceError(0);
        url = new URL(location, url).href;
        response = null;
      }
      if (!response?.ok) throw sourceError(response?.status);
      if (!response.body) throw sourceError(0);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await consume(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (e) {
      if (signal?.aborted) throw abortError();
      if (controller.signal.aborted) throw new UpdateError('TIMEOUT', '更新服务响应超时，请重试。');
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async listReleases({ signal } = {}) {
    const items = [];
    for (let page = 1; page <= 40; page++) {
      const bytes = await this.request(`repos/${REPOSITORY}/releases?per_page=25&page=${page}`, {
        signal,
      });
      let rows;
      try {
        rows = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new UpdateError('BAD_RESPONSE', '更新服务返回了无法识别的信息。');
      }
      if (!Array.isArray(rows))
        throw new UpdateError('BAD_RESPONSE', '更新服务返回了无法识别的信息。');
      items.push(...rows);
      if (rows.length < 25) return items;
    }
    throw new UpdateError('INCOMPLETE', '版本记录较多，暂时无法完整核对，请打开发布页面查看。');
  }
  async asset(asset, options = {}) {
    if (!Number.isSafeInteger(asset.id) || asset.id < 1)
      throw new UpdateError('BAD_SOURCE', '更新资源无效。');
    return this.request(`repos/${REPOSITORY}/releases/assets/${asset.id}`, {
      ...options,
      binary: true,
      maxBytes: asset.size,
      timeout: options.destination ? 15 * 60 * 1000 : 30000,
    });
  }
}
module.exports = { GitHubUpdateSource };
