export const SHELF_PROJECT_LIMIT = 6;
export const RECENT_DOCUMENT_LIMIT = 8;

const normalizedRoot = (root) =>
  String(root || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');

/** Hide generated task folders from the default shelf, without scanning them. */
export function isTemporaryProject(project) {
  const root = normalizedRoot(project.root);
  return (
    /^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/i.test(root) ||
    /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}(?:\/|$)/i.test(root) ||
    /\/(?:\.codex|\.claude)\/worktrees(?:\/|$)/i.test(root)
  );
}

const isArchivePath = (value) =>
  normalizedRoot(value)
    .split('/')
    .some((part) =>
      /(?:代码镜像|code[-_ ]?mirror|(?:^|[-_ ])backups?(?:$|[-_ ])|备份)/i.test(part),
    );

/** @param {import('./types').ProjectOverview['projects'][number]} project */
export function projectTitle(project, documentLabel = '文档') {
  const parts = normalizedRoot(project.root).split('/').filter(Boolean),
    last = parts.at(-1) || project.name;
  if (/^(?:docs?|notes?|文档|笔记)$/i.test(last) && parts.length > 1)
    return parts.at(-2) + ' · ' + documentLabel;
  return project.name || last;
}

/**
 * @param {import('./types').ProjectOverview['projects']} projects
 * @param {string[]} [pinnedProjects]
 */
export function selectProjectShelf(projects, pinnedProjects = [], limit = SHELF_PROJECT_LIMIT) {
  const pinned = new Map(pinnedProjects.map((id, index) => [id, index]));
  return projects
    .filter(
      (project) =>
        project.available !== false &&
        (pinned.has(project.id) || (project.registered && !isTemporaryProject(project))),
    )
    .slice()
    .sort((a, b) => {
      const aPin = pinned.get(a.id),
        bPin = pinned.get(b.id);
      if (aPin !== undefined || bPin !== undefined) {
        if (aPin === undefined) return 1;
        if (bPin === undefined) return -1;
        return aPin - bPin;
      }
      return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(0, Math.min(SHELF_PROJECT_LIMIT, limit)));
}

/**
 * @param {import('./types').ProjectOverview['projects']} projects
 * @param {{query?:string,pinnedProjects?:string[],includeTemporary?:boolean}} [options]
 */
export function discoverableProjects(
  projects,
  { query = '', pinnedProjects = [], includeTemporary = false } = {},
) {
  const term = query.trim().toLocaleLowerCase(),
    pinned = new Set(pinnedProjects);
  return projects
    .filter(
      (project) =>
        project.available !== false &&
        (includeTemporary || pinned.has(project.id) || !isTemporaryProject(project)) &&
        (!term || (project.name + ' ' + project.root).toLocaleLowerCase().includes(term)),
    )
    .slice()
    .sort(
      (a, b) =>
        Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
        Number(b.registered) - Number(a.registered) ||
        (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * @param {NonNullable<import('./types').ProjectOverview['recentDocuments']>} documents
 * @param {import('./types').ProjectOverview['projects']} [projects]
 * @param {string[]} [pinnedProjects]
 */
export function recentShelfDocuments(documents, projects = [], pinnedProjects = []) {
  const seen = new Set(),
    pinned = new Set(pinnedProjects),
    owns = (project, file) => file.startsWith(normalizedRoot(project.root) + '/');
  return [...documents]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .filter((document) => {
      if (
        !Number.isFinite(document.lastOpenedAt) ||
        document.lastOpenedAt <= 0 ||
        !Number.isFinite(new Date(document.lastOpenedAt).getTime())
      )
        return false;
      const file = normalizedRoot(document.path),
        directory = file.slice(0, file.lastIndexOf('/'));
      if (isArchivePath(directory)) return false;
      if (projects.some((project) => project.available === false && owns(project, file)))
        return false;
      if (
        isTemporaryProject({ root: directory }) &&
        !projects.some(
          (project) => pinned.has(project.id) && project.available !== false && owns(project, file),
        )
      )
        return false;
      if (seen.has(document.path)) return false;
      seen.add(document.path);
      return true;
    })
    .slice(0, RECENT_DOCUMENT_LIMIT);
}
