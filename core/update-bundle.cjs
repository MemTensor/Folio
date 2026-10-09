const { promises: fs, constants } = require('./update-fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
function stop(signal) {
  if (signal?.aborted) throw Object.assign(Error('更新准备已取消。'), { code: 'UPDATE_CANCELED' });
}
async function sha256File(file, signal) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true }),
      digest = crypto.createHash('sha256'),
      buffer = Buffer.alloc(1024 * 1024);
    if (!before.isFile()) throw Error('安装包中需要普通文件。');
    let position = 0;
    while (true) {
      stop(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw Error('应用文件在校验期间发生变化。');
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}
async function machoArchitectures(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const read = async (offset, length) => {
      if (offset < 0 || offset + length > stat.size) throw Error('Mach-O 文件已截断。');
      const buffer = Buffer.alloc(length),
        { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw Error('Mach-O 文件已截断。');
      return buffer;
    };
    const cpu = (value) => (value === 0x0100000c ? 'arm64' : value === 0x01000007 ? 'x64' : null);
    const thin = async (offset, size) => {
      if (size < 32) throw Error('Mach-O 主程序头无效。');
      const header = await read(offset, 32),
        magic = header.readUInt32BE(0);
      const field =
        magic === 0xcffaedfe
          ? (at) => header.readUInt32LE(at)
          : magic === 0xfeedfacf
            ? (at) => header.readUInt32BE(at)
            : null;
      if (!field || field(12) !== 2) throw Error('安装包主程序不是 Mach-O 可执行文件。');
      return cpu(field(4));
    };
    const header = await read(0, 8),
      magic = header.readUInt32BE(0);
    if ([0xcffaedfe, 0xfeedfacf].includes(magic)) return [await thin(0, stat.size)].filter(Boolean);
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
      throw Error('安装包主程序格式无效。');
    const little = [0xbebafeca, 0xbfbafeca].includes(magic),
      wide = [0xcafebabf, 0xbfbafeca].includes(magic),
      count = little ? header.readUInt32LE(4) : header.readUInt32BE(4),
      width = wide ? 32 : 20;
    if (count < 1 || count > 32) throw Error('Mach-O 架构数量无效。');
    const table = await read(8, count * width),
      result = [];
    for (let i = 0; i < count; i++) {
      const at = i * width,
        u32 = (offset) => (little ? table.readUInt32LE(offset) : table.readUInt32BE(offset)),
        u64 = (offset) =>
          Number(little ? table.readBigUInt64LE(offset) : table.readBigUInt64BE(offset));
      const offset = wide ? u64(at + 8) : u32(at + 8),
        size = wide ? u64(at + 16) : u32(at + 12);
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        offset < 8 + count * width ||
        offset + size > stat.size
      )
        throw Error('Mach-O 架构范围无效。');
      const architecture = await thin(offset, size);
      if (architecture !== cpu(u32(at))) throw Error('Mach-O 架构信息不一致。');
      if (architecture) result.push(architecture);
    }
    return result;
  } finally {
    await handle.close();
  }
}
async function bundleManifest(bundle, signal) {
  const entries = [];
  let bytes = 0;
  async function visit(relative) {
    stop(signal);
    const file = path.join(bundle, relative),
      stat = await fs.lstat(file);
    if (entries.length >= 20000) throw Error('应用包文件数量超出限制。');
    const base = { path: relative, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink())
      entries.push({ ...base, type: 'symlink', target: await fs.readlink(file) });
    else if (stat.isDirectory()) {
      entries.push({ ...base, type: 'directory' });
      for (const name of (await fs.readdir(file)).sort())
        await visit(relative ? relative + '/' + name : name);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 2 * 1024 ** 3) throw Error('应用包大小超出限制。');
      entries.push({
        ...base,
        type: 'file',
        size: stat.size,
        sha256: await sha256File(file, signal),
      });
    } else throw Error('应用包文件类型无效。');
  }
  await visit('');
  return { version: 1, entries };
}
async function verifyManifest(bundle, manifestPath, expectedHash, signal) {
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw Error('应用校验清单无效。');
  const bytes = await fs.readFile(manifestPath);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw Error('应用校验清单已变化。');
  const expected = JSON.parse(bytes);
  if (JSON.stringify(expected) !== JSON.stringify(await bundleManifest(bundle, signal)))
    throw Error('应用包在准备后发生变化，请重新下载。');
}
module.exports = {
  sha256File,
  machoArchitectures,
  bundleManifest,
  verifyManifest,
  MAX_MANIFEST_BYTES,
};
