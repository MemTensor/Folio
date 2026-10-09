const { REPOSITORY, RELEASE_PAGE } = require('./repository.cjs');
class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function versionParts(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number),
    pre = match[4]?.split('.') || [];
  if (
    core.some((n) => !Number.isSafeInteger(n)) ||
    pre.some((s) => /^\d+$/.test(s) && s.length > 1 && s[0] === '0')
  )
    return null;
  return { core, pre };
}
function compareVersions(a, b) {
  const x = versionParts(a),
    y = versionParts(b);
  if (!x || !y) throw new UpdateError('INVALID_VERSION', '版本信息无效。');
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length)
    return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i],
      r = y.pre[i];
    if (l === undefined || r === undefined) return l === r ? 0 : l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l),
      rn = /^\d+$/.test(r);
    if (ln && rn) {
      const lb = BigInt(l),
        rb = BigInt(r);
      return lb > rb ? 1 : -1;
    }
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}
function releaseCandidate(releases, currentVersion, arch) {
  const current = versionParts(currentVersion);
  if (!current) throw new UpdateError('INVALID_VERSION', '当前应用版本无效。');
  if (!['arm64', 'x64'].includes(arch))
    throw new UpdateError('UNSUPPORTED', '此架构暂不支持应用内更新。');
  const candidates = [];
  let newer = false;
  for (const release of releases) {
    if (
      release?.draft ||
      typeof release?.tag_name !== 'string' ||
      !release.tag_name.startsWith('v')
    )
      continue;
    const version = release.tag_name.slice(1),
      parsed = versionParts(version);
    if (!parsed) continue;
    if (Boolean(release.prerelease) !== Boolean(parsed.pre.length)) continue;
    if (!current.pre.length && parsed.pre.length) continue;
    if (compareVersions(version, currentVersion) <= 0) continue;
    newer = true;
    const name = `Folio-${version}-${arch}-mac.zip`,
      assets = Array.isArray(release.assets) ? release.assets : [];
    const zip = assets.filter((a) => a.name === name),
      sums = assets.filter((a) => a.name === 'SHA256SUMS.txt');
    const valid = (a) =>
      a &&
      Number.isSafeInteger(a.id) &&
      a.id > 0 &&
      a.state === 'uploaded' &&
      Number.isSafeInteger(a.size) &&
      a.size > 0;
    if (
      zip.length !== 1 ||
      sums.length !== 1 ||
      !valid(zip[0]) ||
      !valid(sums[0]) ||
      zip[0].size > 1024 ** 3 ||
      sums[0].size > 65536
    )
      continue;
    const digest = zip[0].digest;
    if (digest && !/^sha256:[a-f0-9]{64}$/i.test(digest)) continue;
    candidates.push({
      version,
      tag: release.tag_name,
      notes: String(release.body || '').slice(0, 20000),
      publishedAt: release.published_at || '',
      asset: {
        id: zip[0].id,
        name,
        size: zip[0].size,
        digest: digest?.slice(7).toLowerCase() || null,
      },
      checksum: {
        id: sums[0].id,
        size: sums[0].size,
        digest: /^sha256:[a-f0-9]{64}$/i.test(sums[0].digest || '')
          ? sums[0].digest.slice(7).toLowerCase()
          : null,
      },
    });
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates.length && newer)
    throw new UpdateError(
      'NO_COMPATIBLE_ASSET',
      '已有新版本，但适合此设备的完整安装包尚未就绪，请稍后重试。',
    );
  return candidates[0] || null;
}
function checksumFor(content, filename) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65536)
    throw new UpdateError('BAD_CHECKSUM', '更新校验文件无效。');
  const matches = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) [ *]([^\r\n]+)$/i.exec(line);
    if (!match) throw new UpdateError('BAD_CHECKSUM', '更新校验文件格式无效。');
    if (match[2] === filename) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) throw new UpdateError('BAD_CHECKSUM', '更新包缺少唯一的校验记录。');
  return matches[0];
}
module.exports = {
  REPOSITORY,
  RELEASE_PAGE,
  UpdateError,
  versionParts,
  compareVersions,
  releaseCandidate,
  checksumFor,
};
