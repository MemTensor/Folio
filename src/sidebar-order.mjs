/** @typedef {'name-asc'|'name-desc'|'modified-desc'|'modified-asc'} FileSortMode */
/** @type {ReadonlyArray<{value:FileSortMode,label:string}>} */
export const FILE_SORT_OPTIONS = [
  { value: 'name-asc', label: '名称升序' },
  { value: 'name-desc', label: '名称降序' },
  { value: 'modified-desc', label: '最近修改在前' },
  { value: 'modified-asc', label: '最早修改在前' },
];
export const FILE_SORT_KEY = 'folio-file-sort';
const collators = new Map();
/** Sorting follows the interface language, not the language of the first build. */
function namesFor(locale) {
  const tag = locale === 'en' ? 'en' : 'zh-CN';
  if (!collators.has(tag))
    collators.set(tag, new Intl.Collator(tag, { numeric: true, sensitivity: 'base' }));
  return collators.get(tag);
}

/** @param {unknown} value @returns {FileSortMode} */
export function fileSortMode(value) {
  return FILE_SORT_OPTIONS.find((option) => option.value === value)?.value || 'name-asc';
}

/** @param {{getItem:(key:string)=>string|null}} storage @returns {FileSortMode} */
export function loadFileSort(storage) {
  try {
    return fileSortMode(storage.getItem(FILE_SORT_KEY));
  } catch {
    return 'name-asc';
  }
}

/** @param {{setItem:(key:string,value:string)=>void}} storage @param {FileSortMode} value */
export function saveFileSort(storage, value) {
  try {
    storage.setItem(FILE_SORT_KEY, fileSortMode(value));
    return true;
  } catch {
    return false;
  }
}

/** @param {import('./types').TreeNode[]} nodes @param {FileSortMode} mode @returns {import('./types').TreeNode[]} */
export function sortFileTree(nodes, mode, locale = 'zh-CN') {
  const order = fileSortMode(mode);
  const names = namesFor(locale);
  return nodes
    .map((node) =>
      node.children
        ? { ...node, children: sortFileTree(node.children, order, locale) }
        : { ...node },
    )
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      if (order.startsWith('modified-')) {
        const aKnown = typeof a.mtime === 'number' && Number.isFinite(a.mtime);
        const bKnown = typeof b.mtime === 'number' && Number.isFinite(b.mtime);
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        if (aKnown && bKnown && a.mtime !== b.mtime)
          return order === 'modified-desc' ? b.mtime - a.mtime : a.mtime - b.mtime;
      }
      const nameOrder = names.compare(a.name, b.name) || a.name.localeCompare(b.name, 'en');
      if (nameOrder) return order === 'name-desc' ? -nameOrder : nameOrder;
      // Two nodes can share a name; `path` is the tiebreaker and may be absent.
      return String(a.path || '').localeCompare(String(b.path || ''), 'en');
    });
}
