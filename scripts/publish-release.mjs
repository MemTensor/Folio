import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import buildPaths from '../core/build-output.cjs';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import repository from '../core/repository.cjs';

export const { REPOSITORY } = repository;
const SHA = /^[a-f0-9]{40}$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const runFile = promisify(execFile);
function check(condition, message) {
  if (!condition) throw Error(message);
}
export function releaseVersion(value) {
  const match = typeof value === 'string' && value.length <= 128 && VERSION.exec(value);
  check(
    match &&
      match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) &&
      (!match[4] || match[4].split('.').every((part) => !/^0\d+$/.test(part))),
    '版本必须是规范的 major.minor.patch[-prerelease]，不含构建元数据。',
  );
  return { version: value, tag: 'v' + value, prerelease: Boolean(match[4]) };
}
export function releaseNotes(changelog, tag) {
  const rows = changelog.split(/\r?\n/),
    heading = /^##\s+(v[^\s（(]+)(?:\s|（|\(|$)/;
  const start = rows.findIndex((line) => heading.exec(line)?.[1] === tag);
  check(start >= 0, `CHANGELOG.md 中缺少 ${tag} 的说明。`);
  let end = start + 1;
  while (end < rows.length && !/^##\s/.test(rows[end])) end++;
  const content = rows
    .slice(start + 1, end)
    .join('\n')
    .trim();
  check(content.length > 0, '发布说明不能为空。');
  return `# Folio ${tag}\n\n${content}\n\n## 下载与安装\n\n下载 macOS Apple Silicon ZIP，解压后将 Folio.app 放入应用程序文件夹。SHA256SUMS.txt 用于核对安装包。\n\n当前安装包未进行 Developer ID 签名和公证。私有仓库下载需要有访问权限的 GitHub 账号。\n`;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function asset(file) {
  const stat = await fs.lstat(file);
  check(stat.isFile() && stat.size > 0, '发布资产必须为非空普通文件：' + path.basename(file));
  return { name: path.basename(file), path: file, size: stat.size, sha256: await hashFile(file) };
}
function commandEnvironment() {
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
  for (const key of [
    'GH_DEBUG',
    'DEBUG',
    'GH_FORCE_TTY',
    'GH_HOST',
    'GH_REPO',
    'GH_PAGER',
    'PAGER',
  ])
    delete env[key];
  return env;
}
const defaultCommand = (binary, args, options = {}) =>
  runFile(binary, args, { maxBuffer: 12 * 1024 * 1024, timeout: 120000, ...options });
async function inspectZip(zip, version, commit, command, cwd) {
  const listing = (await command('/usr/bin/unzip', ['-Z1', zip], { cwd })).stdout
    .toString()
    .split(/\r?\n/)
    .filter(Boolean);
  check(listing.length > 0 && listing.length <= 20000, 'ZIP 文件目录异常。');
  check(new Set(listing).size === listing.length, 'ZIP 包含重复路径。');
  check(
    listing.every(
      (name) =>
        name.startsWith('Folio.app/') &&
        !name.split('/').includes('..') &&
        !name.includes('\\') &&
        !/[\x00-\x1f\x7f]/.test(name),
    ),
    'ZIP 必须只包含 Folio.app 下的有效相对路径。',
  );
  for (const name of require('../core/bundle-contract.cjs').BUNDLE_FILES.map(
    (file) => 'Folio.app/' + file,
  ))
    check(listing.includes(name), '安装包缺少：' + name);
  const plist = (
    await command('/usr/bin/unzip', ['-p', zip, 'Folio.app/Contents/Info.plist'], {
      cwd,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.toString();
  const value = (key) => {
    const values = [
      ...plist.matchAll(new RegExp('<key>' + key + '</key>\\s*<string>([^<]*)</string>', 'g')),
    ];
    check(values.length === 1, '安装包 Info.plist 字段缺失或重复：' + key);
    return values[0][1];
  };
  check(value('CFBundleIdentifier') === 'io.folio.markdown', '安装包的 Bundle ID 不属于 Folio。');
  check(value('CFBundleExecutable') === 'Folio', '安装包可执行文件不匹配。');
  check(
    value('CFBundleShortVersionString') === version && value('CFBundleVersion') === version,
    '包内版本与 package.json 不一致。',
  );
  const binary = (
    await command('/usr/bin/unzip', ['-p', zip, 'Folio.app/Contents/MacOS/Folio'], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout;
  check(
    Buffer.isBuffer(binary) &&
      binary.length >= 12 &&
      binary.readUInt32LE(0) === 0xfeedfacf &&
      binary.readUInt32LE(4) === 0x0100000c,
    '安装包可执行文件必须为 macOS arm64 Mach-O。',
  );
  const buildInfo = JSON.parse(
    (
      await command(
        '/usr/bin/unzip',
        ['-p', zip, 'Folio.app/Contents/Resources/updater/build-info.json'],
        { cwd, maxBuffer: 65536 },
      )
    ).stdout.toString(),
  );
  check(
    buildInfo.version === version &&
      buildInfo.commit === commit &&
      buildInfo.dirty === false &&
      buildInfo.platform === 'darwin' &&
      buildInfo.arch === 'arm64',
    '安装包必须从当前干净提交构建，请重新编译 Release。',
  );
  await command('/usr/bin/unzip', ['-tq', zip], { cwd, timeout: 120000 });
}
export async function prepareRelease({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  commit,
  command = defaultCommand,
} = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  check(
    pkg.private === true && pkg.build?.appId === 'io.folio.markdown',
    '仅允许准备当前私有 Folio 项目。',
  );
  const version = releaseVersion(pkg.version),
    output = buildPaths.buildOutput(root, pkg);
  check(
    path.relative(root, output).split(path.sep)[0] !== '..' && output !== root,
    '构建产物目录必须位于仓库内。',
  );
  const head = (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout
    .toString()
    .trim();
  check(
    SHA.test(head) && (!commit || (SHA.test(commit) && commit === head)),
    '--commit 必须为当前已检出 HEAD 的完整提交 SHA。',
  );
  const archivePath = path.join(output, `Folio-${version.version}-arm64-mac.zip`);
  const archiveStat = await fs.lstat(archivePath);
  check(
    archiveStat.isFile() && archiveStat.size > 0 && archiveStat.size <= 1024 ** 3,
    'ZIP 缺失、不是普通文件或超过 1 GiB。',
  );
  await inspectZip(archivePath, version.version, head, command, root);
  const archive = await asset(archivePath);
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${archive.sha256}  ${archive.name}\n`, {
    mode: 0o600,
  });
  const notes = releaseNotes(
    await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    version.tag,
  );
  const notesPath = path.join(output, 'RELEASE_NOTES.md');
  await fs.writeFile(notesPath, notes, { mode: 0o600 });
  const manifest = {
    repository: REPOSITORY,
    ...version,
    commit: head,
    platform: 'darwin',
    arch: 'arm64',
    notesPath,
    notes,
    assets: [archive, await asset(path.join(output, 'SHA256SUMS.txt'))],
  };
  await fs.writeFile(
    path.join(output, 'release-plan.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600 },
  );
  return manifest;
}
function verifyAssets(release, assets, { complete = false } = {}) {
  check(Array.isArray(release.assets), 'GitHub 未返回有效资产列表。');
  check(
    release.assets.every((a) => assets.some((expected) => expected.name === a.name)),
    '此 Release 存在不属于当前发布计划的资产，请人工核对。',
  );
  for (const expected of assets) {
    const matches = release.assets.filter((a) => a.name === expected.name);
    check(
      matches.length <= 1 && (!complete || matches.length === 1),
      'Release 资产缺失或重名：' + expected.name,
    );
    if (matches.length)
      check(
        matches[0].state === 'uploaded' &&
          matches[0].size === expected.size &&
          matches[0].digest === 'sha256:' + expected.sha256,
        '已有 Release 资产与本地产物不一致，拒绝覆盖：' + expected.name,
      );
  }
}
export async function publishRelease(plan, { root, command = defaultCommand } = {}) {
  check(root && plan.repository === REPOSITORY && SHA.test(plan.commit), '发布计划无效。');
  const env = commandEnvironment(),
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-release-'));
  const gh = async (args) => command('gh', args, { cwd: temporary, env, timeout: 15 * 60 * 1000 });
  const api = async (endpoint, { body, optional = false } = {}) => {
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--method',
      body ? 'POST' : 'GET',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      endpoint,
    ];
    if (body) {
      const file = path.join(temporary, crypto.randomUUID() + '.json');
      await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 });
      args.push('--input', file);
    }
    try {
      return JSON.parse((await gh(args)).stdout.toString());
    } catch (error) {
      if (optional && /(?:HTTP 404|\(404\))/.test(error.stderr || '')) return null;
      throw error;
    }
  };
  const endpoint = (suffix) => `repos/${REPOSITORY}/${suffix}`;
  const tagCommit = async () => {
    let ref = await api(endpoint('git/ref/tags/' + plan.tag), { optional: true });
    if (!ref) return null;
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++)
      object = (await api(endpoint('git/tags/' + object.sha))).object;
    check(object?.type === 'commit' && SHA.test(object.sha), '无法确认发布 tag 的提交。');
    return object.sha;
  };
  const findRelease = async () => {
    for (let page = 1; page <= 10; page++) {
      const releases = await api(endpoint(`releases?per_page=100&page=${page}`));
      check(Array.isArray(releases), 'GitHub 未返回 Release 列表。');
      const matching = releases.filter((release) => release.tag_name === plan.tag);
      check(matching.length <= 1, '同 tag 出现多个 Release。');
      if (matching.length) return matching[0];
      if (releases.length < 100) return null;
    }
    throw Error('Release 列表超过检查范围，未执行发布。');
  };
  try {
    const clean = (
      await command('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root })
    ).stdout
      .toString()
      .trim();
    check(!clean, '发布需要干净工作区，请先提交所需源码。');
    const head = (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout
      .toString()
      .trim();
    check(head === plan.commit, 'HEAD 在准备后发生变化。');
    const repository = await api(`repos/${REPOSITORY}`);
    check(
      repository.full_name === REPOSITORY && repository.private === true,
      `目标仓库必须仍为 ${REPOSITORY} 私有仓库。`,
    );
    let branch;
    try {
      branch = (
        await command('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root })
      ).stdout
        .toString()
        .trim();
    } catch {
      branch = repository.default_branch;
    }
    check(
      typeof branch === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
        !branch.includes('..'),
      '请在明确的已推送分支或默认分支提交上发布。',
    );
    const remoteHead = await api(endpoint('git/ref/heads/' + branch));
    check(
      remoteHead.object?.type === 'commit' && remoteHead.object.sha === plan.commit,
      '远端分支 HEAD 与准备的提交不一致，请核对并推送源码。',
    );
    for (const expected of plan.assets) {
      const current = await asset(expected.path);
      check(
        current.sha256 === expected.sha256 && current.size === expected.size,
        '准备后的本地资产发生变化。',
      );
    }
    let tagged = await tagCommit();
    check(!tagged || tagged === plan.commit, '已有 tag 指向其他提交，拒绝移动 tag。');
    let release = await findRelease();
    if (release) {
      check(
        tagged === plan.commit && release.prerelease === plan.prerelease,
        '已有 Release 的提交或预发布标记不匹配。',
      );
      verifyAssets(release, plan.assets, { complete: !release.draft });
      if (!release.draft)
        return {
          state: 'already-published',
          tag: plan.tag,
          commit: plan.commit,
          url: release.html_url,
        };
    }
    if (!tagged) {
      await api(endpoint('git/refs'), { body: { ref: 'refs/tags/' + plan.tag, sha: plan.commit } });
      tagged = await tagCommit();
      check(tagged === plan.commit, '新建 tag 回读校验失败。');
    }
    if (!release) {
      const args = [
        'release',
        'create',
        plan.tag,
        '--repo',
        REPOSITORY,
        '--verify-tag',
        '--draft',
        '--title',
        'Folio ' + plan.tag,
        '--notes-file',
        plan.notesPath,
      ];
      if (plan.prerelease) args.push('--prerelease');
      await gh(args);
      // GitHub may accept creation before the draft appears in the list API.
      // Only repeat reads; never create a duplicate draft or overwrite assets.
      for (let attempt = 0; attempt < 5; attempt++) {
        release = await findRelease();
        if (release) break;
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
      check(
        release?.draft === true && release.prerelease === plan.prerelease,
        '草稿 Release 回读校验失败。',
      );
    }
    for (const expected of plan.assets) {
      if (!release.assets.some((a) => a.name === expected.name))
        await gh(['release', 'upload', plan.tag, expected.path, '--repo', REPOSITORY]);
    }
    release = await findRelease();
    check(
      release?.draft === true && (await tagCommit()) === plan.commit,
      'Release 或 tag 在上传期间变化，已停止发布。',
    );
    verifyAssets(release, plan.assets, { complete: true });
    const finalRepository = await api(`repos/${REPOSITORY}`);
    check(finalRepository.private === true, '仓库可见性已变化，已停止发布。');
    await gh([
      'release',
      'edit',
      plan.tag,
      '--repo',
      REPOSITORY,
      '--draft=false',
      '--prerelease=' + plan.prerelease,
      '--latest=' + !plan.prerelease,
      '--title',
      'Folio ' + plan.tag,
      '--notes-file',
      plan.notesPath,
    ]);
    const published = await findRelease();
    check(
      published?.draft === false && published.prerelease === plan.prerelease,
      '发布回读未确认；保留现有 Release，请重新检查。',
    );
    verifyAssets(published, plan.assets, { complete: true });
    return { state: 'published', tag: plan.tag, commit: plan.commit, url: published.html_url };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
export function parseArgs(args) {
  const options = { publish: false };
  let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--prepare', '--dry-run', '--publish'].includes(arg)) {
      check(!mode, '只能指定一种运行模式。');
      mode = arg;
      options.publish = arg === '--publish';
    } else if (arg === '--commit') {
      check(!options.commit && SHA.test(args[i + 1] || ''), '--commit 需要完整的小写 SHA。');
      options.commit = args[++i];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw Error('未知参数：' + arg);
  }
  return options;
}
export async function main(args = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(args),
    root = options.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (parsed.help)
    return {
      help: 'node scripts/publish-release.mjs [--prepare|--dry-run|--publish] [--commit FULL_SHA]\nDefault prepares local SHA256SUMS.txt, RELEASE_NOTES.md and release-plan.json only. --publish requires a clean, pushed HEAD and preserves private repository visibility.',
    };
  const plan = await prepareRelease({ ...options, root, commit: parsed.commit });
  return parsed.publish
    ? publishRelease(plan, { ...options, root })
    : {
        state: 'prepared',
        tag: plan.tag,
        commit: plan.commit,
        assets: plan.assets.map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 })),
        notesPath: plan.notesPath,
      };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      // Never forward gh's raw HTTP/debug output or inherited credential-bearing environment.
      console.error(
        JSON.stringify({
          ok: false,
          error: error.cmd?.startsWith('gh ')
            ? 'GitHub 操作失败，请检查登录、仓库权限和现有 Release；未自动覆盖资产。'
            : error.message,
        }),
      );
      process.exitCode = 1;
    });
}
