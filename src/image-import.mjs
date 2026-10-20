const STORAGE_KEY = 'folio-image-import-recovery';
const MAX_IMAGES = 50;
/** @typedef {{name:string,relative:string}} ImportedImage */
/** @typedef {{path:string,items:ImportedImage[]}} ImageRecovery */
/** Collect successful copies even when a later file fails or navigation changes.
 * @param {File[]} files
 * @param {{isCurrent:()=>boolean, importFile:(file:File)=>Promise<string>}} options
 */
export async function collectImageImports(files, { isCurrent, importFile }) {
  if (files.length > MAX_IMAGES) throw Error('一次最多导入 50 张图片。');
  const items = /** @type {ImportedImage[]} */ ([]);
  const failures = /** @type {{name:string,message:string}[]} */ ([]);
  for (const file of files) {
    if (!isCurrent()) return { items, failures, interrupted: true };
    if (file.size > 21 * 1024 * 1024) {
      failures.push({ name: file.name, message: '图片过大。' });
      continue;
    }
    if (!file.type.startsWith('image/')) {
      failures.push({ name: file.name, message: '不支持此图片格式。' });
      continue;
    }
    try {
      const relative = await importFile(file);
      if (relative) items.push({ name: file.name.slice(0, 300), relative });
    } catch (error) {
      failures.push({
        name: file.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isCurrent()) return { items, failures, interrupted: true };
  }
  return { items, failures, interrupted: false };
}
/** @param {ImportedImage[]} items */
export function imageReferences(items) {
  return items
    .map(({ name, relative }) => {
      const alt = name
        .replace(/\.[^.]+$/, '')
        .replace(/[\r\n]/g, ' ')
        .replace(/[\\[\]]/g, '\\$&');
      return `![${alt}](${relative})\n`;
    })
    .join('');
}
/** @param {string} content @param {ImportedImage[]} items */
export function appendImageReferences(content, items) {
  const missing = items.filter((item) => !content.includes(imageReferences([item]).trim()));
  if (!missing.length) return content;
  return (
    content +
    (content && !content.endsWith('\n\n') ? (content.endsWith('\n') ? '\n' : '\n\n') : '') +
    imageReferences(missing)
  );
}
/** @param {Pick<Storage,'getItem'>} storage @returns {ImageRecovery|null} */
export function readImageRecovery(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 65536) return null;
    const value = JSON.parse(raw);
    if (
      typeof value?.path !== 'string' ||
      !value.path.startsWith('/') ||
      value.path.length > 4096 ||
      !Array.isArray(value.items) ||
      !value.items.length ||
      value.items.length > MAX_IMAGES
    )
      return null;
    if (
      value.items.some(
        (item) =>
          typeof item?.name !== 'string' ||
          item.name.length > 300 ||
          typeof item.relative !== 'string' ||
          !/^assets\/[^/\\\0\r\n]+\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(item.relative) ||
          item.relative.includes('..') ||
          item.relative.length > 1000,
      )
    )
      return null;
    return {
      path: value.path,
      items: value.items.map(({ name, relative }) => ({ name, relative })),
    };
  } catch {
    return null;
  }
}
/** @param {Pick<Storage,'setItem'|'removeItem'>} storage @param {ImageRecovery|null} value */
export function writeImageRecovery(storage, value) {
  try {
    if (value) {
      const raw = JSON.stringify(value);
      if (raw.length > 65536) return false;
      storage.setItem(STORAGE_KEY, raw);
    } else storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
