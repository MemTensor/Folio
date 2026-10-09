const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const failure = (message) => Object.assign(Error(message), { code: 'AGENT_MISSING' });

async function executableFile(file) {
  try {
    await fs.access(file, fs.constants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function findCodex({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  const directories = [
    ...new Set([
      ...(env.PATH || '').split(path.delimiter),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      ...['.local/bin', '.npm-global/bin', '.volta/bin', '.bun/bin'].map((name) =>
        path.join(home, name),
      ),
    ]),
  ].filter((directory) => path.isAbsolute(directory));
  // Read only known Node installation roots, once per connection. Never scan
  // the home directory or source a login shell with arbitrary startup hooks.
  for (const root of [
    path.join(home, '.nvm/versions/node'),
    path.join(home, '.local/share/fnm/node-versions'),
  ]) {
    try {
      const versions = (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^v?\d+\.\d+\.\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
        .slice(0, 20);
      for (const version of versions)
        directories.push(
          path.join(root, version, root.includes('/fnm/') ? 'installation/bin' : 'bin'),
        );
    } catch {}
  }
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const directory of directories)
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await executableFile(candidate)) return candidate;
    }
  throw failure('尚未找到 Codex，请先安装 Codex CLI，然后重新连接。');
}

async function resolveCodexRuntime(
  file,
  { platform = process.platform, arch = process.arch } = {},
) {
  const real = await fs.realpath(file).catch(() => file);
  if (platform === 'darwin' && /\.app\/Contents\/MacOS\//.test(real))
    throw failure('找到的是桌面应用入口，请安装 Codex CLI 后重新连接。');
  if (platform !== 'darwin' || !/^codex\.m?js$/.test(path.basename(real)))
    return {
      executable: real,
      source: 'native',
      version: /\/Caskroom\/codex\/(\d+\.\d+\.\d+)\//.exec(real)?.[1],
    };
  const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const packageName = '@openai/codex-darwin-' + arch;
  const roots = [];
  try {
    const metadata = createRequire(real).resolve(packageName + '/package.json');
    roots.push({ root: path.join(path.dirname(metadata), 'vendor'), source: 'npm-platform' });
  } catch {}
  roots.push({ root: path.resolve(path.dirname(real), '../vendor'), source: 'npm-legacy' });
  for (const { root, source } of roots)
    for (const directory of ['bin', 'codex']) {
      const native = path.join(root, triple, directory, 'codex');
      if (await executableFile(native)) {
        let version;
        try {
          const metadata = JSON.parse(
            await fs.readFile(path.resolve(path.dirname(real), '../package.json'), 'utf8'),
          );
          if (
            metadata.name === '@openai/codex' &&
            /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(metadata.version)
          )
            version = metadata.version;
        } catch {}
        return { executable: await fs.realpath(native), source, version };
      }
    }
  throw failure('Codex 安装缺少当前 Mac 的原生程序，请重新安装 Codex CLI 后连接。');
}

function runtimePATH(executable, env = process.env) {
  return [
    ...new Set([
      path.dirname(executable),
      ...(env.PATH || '').split(path.delimiter),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]),
  ]
    .filter((directory) => path.isAbsolute(directory))
    .join(path.delimiter);
}
module.exports = { findCodex, resolveCodexRuntime, runtimePATH };
