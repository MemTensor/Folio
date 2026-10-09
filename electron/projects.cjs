const fs = require('node:fs/promises');
const path = require('node:path');
const { ProjectCatalog } = require('../core/project-catalog.cjs');
const { ProjectSync } = require('../core/project-sync.cjs');
const {
  readRecoverableJSON,
  writeRecoverableJSON,
  withLock,
  digest,
} = require('../core/state.cjs');
const defaults = {
  onboarded: false,
  homeOnLaunch: true,
  discoverProjects: false,
  language: 'zh-CN',
  pinnedProjects: [],
};
const valid = (p) =>
  p &&
  typeof p.onboarded === 'boolean' &&
  typeof p.homeOnLaunch === 'boolean' &&
  typeof p.discoverProjects === 'boolean' &&
  ['zh-CN', 'en'].includes(p.language) &&
  (p.pinnedProjects === undefined ||
    (Array.isArray(p.pinnedProjects) &&
      p.pinnedProjects.length <= 32 &&
      p.pinnedProjects.every((id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))));
function createProjectServices({
  dataDir,
  library,
  openRoot,
  gate,
  onChange = () => {},
  onLanguage = () => {},
  catalogOptions = {},
  syncOptions = {},
}) {
  const file = path.join(dataDir, 'experience.json');
  const catalog = new ProjectCatalog(dataDir, catalogOptions);
  const sync = new ProjectSync(dataDir, syncOptions);
  let preferences = { ...defaults },
    timer,
    closed = false,
    resync = false,
    syncing = null;
  const operations = new Set();
  const knownProjects = new Map();
  function track(operation) {
    if (closed) return Promise.reject(Error('Folio 正在退出。'));
    const task = Promise.resolve()
      .then(operation)
      .finally(() => operations.delete(task));
    operations.add(task);
    return task;
  }
  async function init() {
    preferences = await readRecoverableJSON(file, {
      fallback: { ...defaults },
      validate: valid,
      label: '项目设置',
      allowReset: true,
    });
    preferences = { ...defaults, ...preferences };
    await watch();
    await sync.watch(await projects(), schedule).catch(() => {});
  }
  async function watch() {
    await catalog.close();
    if (preferences.discoverProjects)
      await catalog.watch(async () => {
        const result = await catalog.snapshot({ refresh: true, registered: await projects() });
        for (const project of result.projects) knownProjects.set(project.id, project);
        onChange();
      });
  }
  async function projects() {
    return (await library.state()).projects;
  }
  function syncView(status, registered) {
    const last = status.lastRun;
    return {
      ...status,
      lastSyncedAt: last?.finishedAt || last?.time || null,
      conflicts: (last?.conflicts || []).map((c) => ({
        ...c,
        id: digest(c.projectId + '\0' + c.path).slice(0, 24),
        projectName: registered.find((p) => p.id === c.projectId)?.name || '',
      })),
      message:
        status.message || (last?.limited ? '此次同步达到扫描上限，可缩小项目范围后重试。' : null),
    };
  }
  async function overview(options = {}) {
    if (
      !options ||
      typeof options !== 'object' ||
      (options.refresh !== undefined && typeof options.refresh !== 'boolean') ||
      (options.discover !== undefined && typeof options.discover !== 'boolean')
    )
      throw Error('项目参数无效。');
    const db = await library.state();
    const syncStatus = await sync.status().catch((error) => ({
      enabled: false,
      available: false,
      projectIds: [],
      message: error.message,
    }));
    const preferred = new Set([
      ...(preferences.pinnedProjects || []),
      ...(syncStatus.projectIds || []),
    ]);
    const registered = db.projects
      .slice()
      .sort(
        (a, b) =>
          Number(preferred.has(b.id)) - Number(preferred.has(a.id)) ||
          (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0),
      )
      .slice(0, 200);
    const displayName = (p) =>
      /^(docs?|notes?|documents?|文档|笔记)$/i.test(p.name)
        ? path.basename(path.dirname(p.root)) +
          ' · ' +
          (preferences.language === 'en' ? 'Documents' : '文档')
        : p.name;
    const recentDocuments = Object.entries(db.opened || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 300)
      .flatMap(([file, time]) => {
        const owner = db.projects
          .filter((p) => file.startsWith(p.root + path.sep))
          .sort((a, b) => b.root.length - a.root.length)[0];
        if (!owner) return [];
        return [
          {
            path: file,
            name: path.basename(file),
            projectName: displayName(owner),
            relativePath: path.relative(owner.root, file),
            lastOpenedAt: time,
          },
        ];
      });
    const data =
      preferences.discoverProjects && options.discover
        ? await catalog.snapshot({ refresh: options.refresh === true, registered })
        : {
            projects: await Promise.all(
              registered.map(async (p) => ({
                ...p,
                sources: ['folio'],
                available: await fs
                  .stat(p.root)
                  .then((s) => s.isDirectory())
                  .catch(() => false),
              })),
            ),
            refreshedAt: null,
            limited: false,
          };
    if (options.discover) knownProjects.clear();
    for (const project of data.projects) knownProjects.set(project.id, project);
    const cloudProjects = syncStatus.enabled
      ? await sync
          .listCloudProjects()
          .then((r) => r.projects)
          .catch(() => [])
      : [];
    return {
      ...data,
      preferences: { ...preferences },
      recentDocuments,
      projects: data.projects.map((p) => ({
        ...p,
        lastOpenedAt: registered.find((r) => r.id === p.id)?.lastOpenedAt || 0,
        displayName: displayName(p),
        registered: registered.some((r) => r.id === p.id),
        sources: p.sources.map(
          (s) => ({ codex: 'Codex', claude: 'Claude Code', folio: 'Folio' })[s] || s,
        ),
      })),
      sync: { ...syncView(syncStatus, registered), cloudProjects },
    };
  }
  async function configure(patch) {
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (k) =>
          ![
            'onboarded',
            'homeOnLaunch',
            'discoverProjects',
            'language',
            'pinnedProjects',
            'syncEnabled',
            'syncProjectIds',
          ].includes(k),
      )
    )
      throw Error('项目设置无效。');
    for (const k of ['onboarded', 'homeOnLaunch', 'discoverProjects', 'syncEnabled'])
      if (k in patch && typeof patch[k] !== 'boolean') throw Error('项目设置无效。');
    if ('language' in patch && !['zh-CN', 'en'].includes(patch.language))
      throw Error('语言设置无效。');
    if ('pinnedProjects' in patch) {
      if (
        !Array.isArray(patch.pinnedProjects) ||
        patch.pinnedProjects.length > 32 ||
        patch.pinnedProjects.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
      )
        throw Error('置顶项目设置无效。');
      const registered = await projects();
      const additions = [];
      for (const id of patch.pinnedProjects) {
        if (registered.some((p) => p.id === id) || (preferences.pinnedProjects || []).includes(id))
          continue;
        const candidate = preferences.discoverProjects ? knownProjects.get(id) : null;
        if (!candidate?.available) throw Error('请先在项目列表中选择有效项目。');
        additions.push(candidate);
      }
      for (const candidate of additions) await library.register(candidate.root);
      patch = { ...patch, pinnedProjects: [...new Set(patch.pinnedProjects)] };
    }
    if ('syncProjectIds' in patch) {
      const all = await projects();
      if (
        !Array.isArray(patch.syncProjectIds) ||
        patch.syncProjectIds.length > 200 ||
        patch.syncProjectIds.some((id) => !all.some((p) => p.id === id))
      )
        throw Error('请先打开要同步的项目。');
    }
    await withLock(dataDir, 'experience-settings', async () => {
      const next = { ...preferences };
      for (const k of Object.keys(defaults)) if (k in patch) next[k] = patch[k];
      if ('syncEnabled' in patch || 'syncProjectIds' in patch) {
        const current = await sync.status();
        await sync.configure({
          enabled: patch.syncEnabled ?? current.enabled,
          projectIds: patch.syncProjectIds ?? current.projectIds,
        });
      }
      await writeRecoverableJSON(file, next, { validate: valid, label: '项目设置' });
      preferences = next;
    });
    if ('discoverProjects' in patch) await watch();
    if (patch.language) onLanguage(patch.language);
    if ('syncEnabled' in patch || 'syncProjectIds' in patch) {
      await sync.watch(await projects(), schedule);
      schedule();
    }
    return overview();
  }
  async function open(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
      throw Error('项目不可用，请使用文件选择窗口重新打开。');
    // Resolve the selected card without statting every unrelated project/cloud
    // folder again. openRoot validates only this chosen path before admission.
    const registered = (await projects()).find((project) => project.id === id);
    const project = registered || (preferences.discoverProjects ? knownProjects.get(id) : null);
    if (!project) throw Error('项目不可用，请使用文件选择窗口重新打开。');
    return { ...(await openRoot(project.root)), autoOpen: false };
  }
  function runSync() {
    if (closed) return Promise.resolve();
    if (syncing) {
      resync = true;
      return syncing;
    }
    resync = false;
    syncing = track(async () => {
      const finish = gate.enter('project-sync');
      try {
        const result = await sync.sync({ projects: await projects() });
        if (!closed) await sync.watch(await projects(), schedule);
        onChange();
        return result;
      } finally {
        finish();
      }
    }).finally(() => {
      syncing = null;
      if (resync && !closed) schedule();
    });
    return syncing;
  }
  function schedule() {
    if (closed) return;
    resync = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void sync
        .status()
        .then((s) => {
          if (s.enabled && !s.running && !gate.ticket) return runSync();
        })
        .catch(() => {});
    }, 2000);
    timer.unref?.();
  }
  async function resolve({ id, choice }) {
    if (typeof id !== 'string' || !['local', 'cloud'].includes(choice))
      throw Error('同步选择无效。');
    const data = await overview(),
      conflict = data.sync.conflicts.find((c) => c.id === id),
      project = (await projects()).find((p) => p.id === conflict?.projectId);
    if (!conflict || !project) throw Error('同步状态已改变，请刷新后重试。');
    await sync.resolve({
      project,
      path: conflict.path,
      choice: choice === 'local' ? 'keep-local' : 'use-cloud',
      localHash: conflict.localHash,
      cloudHash: conflict.cloudHash,
    });
    return runSync();
  }
  async function bind({ projectId, cloudId }) {
    if (!(await projects()).some((p) => p.id === projectId)) throw Error('请先打开要同步的项目。');
    if (
      cloudId !== null &&
      !(await sync.listCloudProjects()).projects.some((p) => p.id === cloudId)
    )
      throw Error('iCloud 项目不可用。');
    await sync.bindCloudProject(projectId, cloudId);
    await sync.watch(await projects(), schedule);
    schedule();
    return overview();
  }
  return {
    bind: (input) => track(() => bind(input)),
    init,
    overview,
    configure: (input) => track(() => configure(input)),
    open,
    runSync,
    resolve: (input) => track(() => resolve(input)),
    schedule,
    getPreferences: () => ({ ...preferences }),
    async close() {
      closed = true;
      clearTimeout(timer);
      sync.stop();
      await sync.close();
      await Promise.allSettled([...operations]);
      await catalog.close();
    },
  };
}
module.exports = { createProjectServices };
