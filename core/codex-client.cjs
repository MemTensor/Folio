const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const MAX_FRAME = 2 * 1024 * 1024;
const failure = (message, code = 'AGENT_CONNECTION') => Object.assign(Error(message), { code });
async function findCodex() {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  const directories = [
    ...new Set([
      ...(process.env.PATH || '').split(path.delimiter),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(os.homedir(), '.local/bin'),
      path.join(os.homedir(), '.npm-global/bin'),
    ]),
  ].filter((entry) => path.isAbsolute(entry));
  for (const directory of directories)
    for (const name of names) {
      const file = path.join(directory, name);
      try {
        await fs.access(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  throw failure('尚未找到 Codex，请先安装 Codex CLI，然后重新连接。', 'AGENT_MISSING');
}

/** Official app-server JSONL transport, started only on explicit connection. */
class CodexClient extends EventEmitter {
  constructor({ home, cwd, version, executable, spawnProcess = spawn, timeout = 30000 }) {
    super();
    Object.assign(this, { home, cwd, version, executable, spawnProcess, timeout });
    this.pending = new Map();
    this.counter = 0;
    this.buffer = '';
    this.child = null;
    this.starting = null;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.launch().catch((error) => {
      this.stop(error);
      this.starting = null;
      throw error;
    });
    return this.starting;
  }
  async launch() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.cwd, { recursive: true, mode: 0o700 });
    let executable = this.executable || (await findCodex());
    // npm installs a JS launcher. Use its bundled native binary on macOS so
    // the restricted runtime need not read a separate Node installation.
    if (process.platform === 'darwin') {
      try {
        const real = await fs.realpath(executable);
        if (path.basename(real) === 'codex.js') {
          const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
          const native = path.resolve(path.dirname(real), '../vendor', triple, 'codex/codex');
          await fs.access(native, fs.constants.X_OK);
          executable = native;
        }
      } catch {}
    }
    // Isolated config/auth prevents importing other harnesses' plugins, hooks,
    // project instructions, or an inherited API key with a different bill.
    const env = { CODEX_HOME: this.home };
    for (const key of [
      'HOME',
      'PATH',
      'TMPDIR',
      'TMP',
      'TEMP',
      'LANG',
      'LC_ALL',
      'TZ',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ])
      if (typeof process.env[key] === 'string') env[key] = process.env[key];
    const config = {
      model_provider: 'openai',
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      mcp_servers: {},
      default_permissions: 'folio-documents',
      'permissions.folio-documents.filesystem': {
        ':root': 'deny',
        ':minimal': 'read',
        [this.cwd]: 'read',
        [executable]: 'read',
      },
      'permissions.folio-documents.network': { enabled: false },
      'features.shell_tool': false,
      'features.unified_exec': false,
      'features.code_mode': false,
      'features.code_mode_host': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
      'features.browser_use': false,
      'features.computer_use': false,
      'features.image_generation': false,
      'features.multi_agent': false,
      'features.skip_host_skill_discovery': true,
    };
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(config)) {
      // -c values are TOML, not JSON. Quoted inline-table keys preserve paths
      // containing spaces or dots and cannot accidentally select another scope.
      const encoded =
        value && typeof value === 'object' && !Array.isArray(value)
          ? '{' +
            Object.entries(value)
              .map(([name, entry]) => JSON.stringify(name) + '=' + JSON.stringify(entry))
              .join(',') +
            '}'
          : JSON.stringify(value);
      args.push('-c', key + '=' + encoded);
    }
    const child = this.spawnProcess(executable, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child === child) this.read(chunk);
    });
    child.stdin.on('error', () => {
      if (this.child === child) this.stop(failure('Codex 连接已断开，请重新连接。'));
    });
    // stderr may include credentials, file contents, or internal diagnostics.
    child.stderr.resume();
    child.on('error', () => {
      if (this.child === child) this.stop(failure('Codex 未能启动，请检查安装后重新连接。'));
    });
    child.on('exit', () => {
      if (this.child === child) this.stop(failure('Codex 连接已断开，请重新连接。'));
    });
    await this.request('initialize', {
      clientInfo: { name: 'folio', title: 'Folio', version: this.version },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    const effective = await this.request('config/read', { includeLayers: false });
    const profile = effective.config?.permissions?.['folio-documents'];
    const available = await this.request('permissionProfile/list', { cwd: this.cwd });
    if (
      profile?.filesystem?.[':root'] !== 'deny' ||
      profile?.filesystem?.[this.cwd] !== 'read' ||
      profile?.network?.enabled !== false ||
      !available.data?.some((entry) => entry.id === 'folio-documents' && entry.allowed)
    )
      throw failure(
        'Codex 文档权限配置不可用，请更新 Codex CLI 或检查本机权限设置。',
        'AGENT_PROTOCOL',
      );
  }
  write(frame) {
    if (!this.child || this.child.killed) throw failure('Codex 连接已断开，请重新连接。');
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  request(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('Codex 响应超时，请重新连接后重试。'));
      }, this.timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  read(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const at = this.buffer.indexOf('\n');
      if (at > MAX_FRAME) return this.stop(failure('Codex 返回内容过大，请缩小文档范围后重试。'));
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return this.stop(failure('Codex 通信格式不兼容，请更新 Codex CLI 后重试。'));
      }
      if (frame.method && frame.id !== undefined) {
        if (frame.method === 'item/tool/call' && this.toolHandler) {
          const child = this.child;
          void Promise.resolve()
            .then(() => this.toolHandler(frame.params))
            .catch(() => ({
              success: false,
              contentItems: [{ type: 'inputText', text: 'Document access unavailable.' }],
            }))
            .then((result) => {
              if (this.child === child) this.write({ id: frame.id, result });
            })
            .catch(() => {});
          continue;
        }
        // The document assistant never authorizes shell commands or writes.
        this.write({
          id: frame.id,
          error: { code: -32601, message: 'Folio document assistant does not permit tools.' },
        });
      } else if (frame.id !== undefined) {
        const call = this.pending.get(frame.id);
        if (!call) continue;
        clearTimeout(call.timer);
        this.pending.delete(frame.id);
        if (frame.error)
          call.reject(
            [-32600, -32601].includes(frame.error.code)
              ? failure('Codex 工具协议不兼容，请更新 Codex CLI 后重试。', 'AGENT_PROTOCOL')
              : failure('Codex 未能完成请求，请检查登录状态后重试。'),
          );
        else call.resolve(frame.result);
      } else if (typeof frame.method === 'string')
        this.emit('notification', frame.method, frame.params || {});
    }
    if (this.buffer.length > MAX_FRAME)
      this.stop(failure('Codex 返回内容过大，请缩小文档范围后重试。'));
  }
  stop(error = failure('Codex 连接已断开，请重新连接。')) {
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.buffer = '';
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    if (child && !child.killed) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500);
      timer.unref?.();
    }
    this.emit('disconnected', error);
  }
  async close() {
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.stop();
    await exited;
  }
}
module.exports = { CodexClient, findCodex };
