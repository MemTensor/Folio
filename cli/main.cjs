#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { FileStore } = require('../core/file-store.cjs');
const { KnowledgeStore, attribution } = require('../core/knowledge.cjs');
const { dataDirectory } = require('../core/state.cjs');
const { DocumentLibrary } = require('../core/library.cjs');
const { AgentTasks } = require('../core/agent-tasks.cjs');
const { DingTalkSync } = require('../core/dingtalk-sync.cjs');
const {
  MemosCloud,
  CloudError,
  publish,
  refreshPublication,
  resolvePublication,
  searchKnowledge,
} = require('../core/memos-cloud.cjs');
const packageInfo = require('../package.json');
const VERSION = packageInfo.version;
const HELP = `Folio ${VERSION} — an independent Markdown application and agent CLI

folio open [path]                         Open the desktop application
folio library add DIR                    Add one project to the document library
folio library remove PROJECT_ID          Remove registration and derived search data
folio library list --json                Recent documents across registered projects
folio library search QUERY --json       Explicit cross-project document search
  [--limit 100 --offset 0 --project-id ID]  Page through results or narrow scope
folio task begin QUERY --workspace DIR --json
folio task end --task-id ID --workspace DIR [--manifest FILE]
folio doctor [--json]                     Inspect local configuration; never prints keys
folio read FILE --workspace DIR --json    Read content, revision and document identity
folio search QUERY --workspace DIR --json Search local document contents
folio context QUERY --workspace DIR --max-chars 12000 --json
folio write FILE --input FILE|- --expect HASH|new --workspace DIR --actor NAME --origin TYPE
folio patch FILE --patch FILE --expect HASH --workspace DIR --actor NAME --origin TYPE
folio provenance FILE --workspace DIR --json
folio history FILE --workspace DIR --json
folio discover QUERY --collection ID --workspace DIR --json
folio resolve DOCUMENT_ID --workspace DIR --json
folio read --document-id DOCUMENT_ID --workspace DIR [--revision HASH] --json

folio memos status [--workspace DIR] --json
folio memos bind --workspace DIR --collection ID
folio memos unbind --workspace DIR
folio memos configure [--key-stdin | --key-file FILE] [--user-id ID] [--base-url URL]
folio memos collection-create NAME [--description TEXT]
folio memos collection-attach ID --name NAME
folio memos search QUERY --collection ID --json
folio memos plan FILE --collection ID --workspace DIR [--mode navigation|full] [--include-assets]
folio memos publish FILE --collection ID --workspace DIR --expect HASH [--mode navigation|full] [--include-assets]
folio memos publications --workspace DIR [--file FILE]
folio memos refresh PUBLICATION_ID --workspace DIR
folio memos resolve PUBLICATION_ID --workspace DIR --outcome attach|not-created --yes
  [--file-ids ID1,ID2 --note TEXT]

folio dingtalk status FILE --workspace DIR --json
folio dingtalk plan FILE --workspace DIR [--profile CORP:USER] [--diagram-file JSON --expect HASH]
folio dingtalk sync --plan PLAN_ID --workspace DIR --yes
folio dingtalk check FILE --workspace DIR --json
folio dingtalk recovery FILE --workspace DIR [--node-id ID] --json
folio dingtalk recover FILE --workspace DIR --action attach|adopt-remote|detach|confirm-not-created
  --expected-plan-id ID [--node-id ID --remote-revision N] --yes
folio dingtalk share-status FILE --workspace DIR --to NAME --json
folio dingtalk share-resolve FILE --workspace DIR --to NAME --outcome sent|not-sent
  --expected-package-hash HASH --yes

DingTalk sync requires explicit confirmation of the saved plan. Local dws login is used.
All commands accept --json. stdout contains one JSON object in JSON mode.
Text content goes through --input / stdin, never shell interpolation.
Patch file: [{"find":"exact unique old text","replace":"new text"}].
Origins: human, model, mixed, unknown. Actor/model/run-id are caller declarations.
Exit codes: 0 success, 2 usage, 3 revision conflict/busy, 4 configuration, 5 cloud,
6 uncertain remote result, 1 unexpected failure. GUI and harness are optional.
`;
function parse(args) {
  const flags = {},
    words = [];
  const bools = new Set([
    'json',
    'help',
    'version',
    'include-assets',
    'key-stdin',
    'clear-key',
    'yes',
  ]);
  const values = new Set([
    'workspace',
    'input',
    'expect',
    'actor',
    'origin',
    'run-id',
    'model',
    'patch',
    'max-chars',
    'collection',
    'description',
    'key-file',
    'user-id',
    'base-url',
    'name',
    'file',
    'mode',
    'summary',
    'when-to-read',
    'document-id',
    'revision',
    'task-id',
    'manifest',
    'limit',
    'offset',
    'project-id',
    'profile',
    'plan',
    'diagram-file',
    'node-id',
    'action',
    'expected-plan-id',
    'remote-revision',
    'to',
    'outcome',
    'expected-package-hash',
    'file-ids',
    'note',
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    if (a === '-v') {
      flags.version = true;
      continue;
    }
    if (a.startsWith('-') && !a.startsWith('--')) throw new CloudError('未知参数：' + a, 'USAGE');
    if (a === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      words.push(a);
      continue;
    }
    const key = a.slice(2);
    if (bools.has(key)) flags[key] = true;
    else if (values.has(key)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--'))
        throw new CloudError('参数缺少值：' + a, 'USAGE');
      flags[key] = args[++i];
    } else throw new CloudError('未知参数：' + a, 'USAGE');
  }
  return { flags, words };
}
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
async function stdin() {
  const chunks = [];
  let size = 0;
  for await (const data of process.stdin) {
    chunks.push(data);
    size += data.length;
    if (size > 16 * 1024 * 1024) throw new CloudError('输入超过 16 MB。', 'USAGE');
  }
  return decode(Buffer.concat(chunks));
}
const readInput = async (name) => (name === '-' ? stdin() : decode(await fs.readFile(name)));
async function appBundle() {
  const output = packageInfo.build?.directories?.output || 'release';
  const candidates = process.env.FOLIO_APP_BUNDLE
    ? [process.env.FOLIO_APP_BUNDLE]
    : [
        path.resolve(__dirname, '..', output, 'mac-' + process.arch, 'Folio.app'),
        '/Applications/Folio.app',
      ];
  for (const candidate of candidates)
    if (
      await fs
        .stat(path.join(candidate, 'Contents/MacOS/Folio'))
        .then((s) => s.isFile())
        .catch(() => false)
    )
      return candidate;
  throw new CloudError(
    '未找到 Folio 桌面应用，请安装到应用程序文件夹或设置 FOLIO_APP_BUNDLE。',
    'CONFIG',
  );
}
async function run(argv) {
  const { flags: f, words: w } = parse(argv);
  if (f.version) return { version: VERSION };
  if (f.help || w[0] === 'help' || !w.length) return { help: HELP };
  const command = w[0],
    cloud = new MemosCloud(dataDirectory());
  const commands = new Set([
    'open',
    'doctor',
    'library',
    'task',
    'read',
    'search',
    'context',
    'write',
    'patch',
    'provenance',
    'history',
    'resolve',
    'discover',
    'memos',
    'dingtalk',
  ]);
  if (!commands.has(command))
    throw new CloudError('未知命令：' + command + '。运行 folio --help 查看用法。', 'USAGE');
  if (command === 'library') {
    const library = new DocumentLibrary(dataDirectory());
    const options = { limit: f.limit, offset: f.offset, projectId: f['project-id'] };
    if (w[1] === 'add') {
      if (!w[2] && !f.workspace) throw new CloudError('需要项目文件夹路径。', 'USAGE');
      return library.register(path.resolve(w[2] || f.workspace));
    }
    if (w[1] === 'remove') return library.remove(w[2]);
    if (w[1] === 'list') return library.snapshot(options);
    if (w[1] === 'search') return library.snapshot({ ...options, query: w[2] || '' });
    throw new CloudError('使用 library add DIR、remove ID、list 或 search QUERY。', 'USAGE');
  }
  if (command === 'doctor')
    return {
      version: VERSION,
      node: process.versions.node,
      dataDirectory: dataDirectory(),
      desktopRequired: false,
      harnessRequired: false,
      cloud: await cloud.status(),
    };
  if (command === 'open') {
    if (w.length > 2) throw new CloudError('open 只接受一个文件或文件夹。', 'USAGE');
    if (process.platform !== 'darwin')
      throw new CloudError('此发行版的图形窗口支持 macOS；其余 CLI 命令可独立使用。', 'CONFIG');
    const target = w[1],
      bundle = await appBundle();
    const launchEnv = { ...process.env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(
      '/usr/bin/open',
      ['-a', bundle, ...(target ? ['--', path.resolve(target)] : [])],
      { env: launchEnv },
    );
    return { opened: target ? path.resolve(target) : bundle };
  }
  if (command === 'memos') {
    if (w[1] === 'status') return cloud.status(f.workspace ? path.resolve(f.workspace) : undefined);
    if (w[1] === 'configure')
      return cloud.configure({
        apiKey: f['key-stdin'] ? (await stdin()).trim() : undefined,
        keyFile: f['key-file'],
        baseURL: f['base-url'],
        userId: f['user-id'],
        clearKey: f['clear-key'],
      });
    if (w[1] === 'collection-create') return cloud.addCollection(w[2], f.description || '');
    if (w[1] === 'collection-attach') return cloud.attachCollection(w[2], f.name);
    if (w[1] === 'search' && !f.workspace) return cloud.search(w[2], f.collection);
  }
  if (!f.workspace) throw new CloudError('此操作需要显式指定 --workspace DIR。', 'USAGE');
  const store = new FileStore(dataDirectory());
  await store.setRoot(path.resolve(f.workspace));
  const knowledge = new KnowledgeStore(store),
    target = w[1];
  if (command === 'dingtalk') {
    const sync = new DingTalkSync(dataDirectory());
    if (w[1] === 'status') return sync.info(knowledge, w[2]);
    if (w[1] === 'plan')
      return sync.plan(knowledge, w[2], {
        profile: f.profile,
        expectedRevision: f.expect,
        diagrams: f['diagram-file'] ? JSON.parse(await readInput(f['diagram-file'])) : [],
      });
    if (w[1] === 'sync') return sync.execute(knowledge, f.plan, { confirmed: f.yes === true });
    if (w[1] === 'check') return sync.reconcile(knowledge, w[2]);
    if (w[1] === 'recovery') return sync.recoveryInfo(knowledge, w[2], { nodeId: f['node-id'] });
    if (w[1] === 'recover')
      return sync.recover(knowledge, w[2], {
        action: f.action,
        nodeId: f['node-id'],
        expectedPlanId: f['expected-plan-id'],
        expectedRevision:
          f['remote-revision'] === undefined ? undefined : Number(f['remote-revision']),
        confirmed: f.yes === true,
      });
    if (w[1] === 'share-status') return sync.shareStatus(knowledge, w[2], f.to);
    if (w[1] === 'share-resolve')
      return sync.resolveShare(knowledge, w[2], {
        to: f.to,
        outcome: f.outcome,
        expectedPackageHash: f['expected-package-hash'],
        confirmed: f.yes === true,
      });
    throw new CloudError('未知钉钉命令，运行 folio --help 查看用法。', 'USAGE');
  }
  if (command === 'task') {
    const tasks = new AgentTasks(knowledge, cloud);
    if (w[1] === 'begin') return tasks.begin(w[2]);
    if (w[1] === 'end') {
      if (!f['task-id']) throw new CloudError('需要 --task-id。', 'USAGE');
      return tasks.finish(f['task-id'], f.manifest ? JSON.parse(await readInput(f.manifest)) : {});
    }
    throw new CloudError('使用 task begin QUERY 或 task end --task-id ID。', 'USAGE');
  }
  if (command === 'resolve') return knowledge.resolve(target);
  if (command === 'read') {
    const p = f['document-id'] ? (await knowledge.lookup(f['document-id'])).path : target;
    if (f.revision) {
      const found = await store.historyEntry(p, f.revision).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (!found) throw new CloudError('该历史版本不在本地保留的快照中。', 'NOT_FOUND');
      return { file: found, historical: true, capturedAt: found.time };
    }
    const r = await knowledge.inspect(p);
    return {
      file: r.file,
      document: {
        id: r.document.id,
        path: r.document.path,
        revision: r.document.revision,
        latestContribution: r.document.events.at(-1) || null,
      },
      sections: r.sections.map(({ content, ...h }) => h),
    };
  }
  if (command === 'search')
    return { query: target, scope: store.root, results: await store.search(target) };
  if (command === 'context')
    return knowledge.context(target, { maxChars: Number(f['max-chars'] || 12000) });
  if (command === 'provenance') return knowledge.provenance(target);
  if (command === 'history') return store.history(target);
  if (command === 'discover') {
    const kb = f.collection || (await cloud.project(store.root)).knowledgebaseId;
    if (!kb)
      throw new CloudError('当前项目未配置记忆。可继续使用本地 search/read。', 'NOT_CONFIGURED');
    const result = await searchKnowledge(knowledge, cloud, target, kb);
    return {
      ...result,
      items: result.items.filter((i) => i.source),
      unassociatedCount: result.items.filter((i) => !i.source).length,
    };
  }
  if (command === 'write' || command === 'patch') {
    attribution({ actor: f.actor, origin: f.origin, runId: f['run-id'], model: f.model });
    if (!f.expect)
      throw new CloudError('写入必须提供 --expect（read 返回的 hash；新文件使用 new）。', 'USAGE');
    let previous = null;
    try {
      previous = await store.read(target);
      await knowledge.observe(previous);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const expected = f.expect === 'new' ? null : f.expect;
    if ((previous?.hash ?? null) !== expected)
      throw new CloudError('文件版本已变化。重新读取后重做修改。', 'CONFLICT', {
        expected,
        actual: previous?.hash ?? null,
      });
    let content;
    if (command === 'write') {
      if (!f.input) throw new CloudError('请通过 --input FILE 或 --input - 提供文本。', 'USAGE');
      content = await readInput(f.input);
    } else {
      if (!previous || !f.patch)
        throw new CloudError('patch 需要现有文档和 --patch FILE。', 'USAGE');
      const changes = JSON.parse(await readInput(f.patch));
      if (!Array.isArray(changes) || !changes.length)
        throw new CloudError('补丁必须为非空数组。', 'USAGE');
      content = previous.content;
      for (const change of changes) {
        if (typeof change.find !== 'string' || !change.find || typeof change.replace !== 'string')
          throw new CloudError('补丁需要非空 find 和字符串 replace。', 'USAGE');
        const index = content.indexOf(change.find);
        if (index < 0 || content.indexOf(change.find, index + 1) >= 0)
          throw new CloudError('补丁原文不唯一或已变化。', 'CONFLICT');
        content =
          content.slice(0, index) + change.replace + content.slice(index + change.find.length);
      }
    }
    const bom = previous?.bom ?? content.startsWith('\uFEFF'),
      eol = previous?.eol || (content.includes('\r\n') ? 'CRLF' : 'LF');
    content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const result = await store.save({ path: target, content, expectedHash: expected, eol, bom });
    if (!result.ok)
      throw new CloudError('写入时出现版本冲突。', 'CONFLICT', {
        actual: result.conflict?.hash || null,
      });
    let document = null,
      metadataWarning;
    try {
      await knowledge.recordWrite(previous, result, {
        actor: f.actor || 'cli-unknown',
        origin: f.origin || 'unknown',
        runId: f['run-id'],
        model: f.model,
      });
      document = await knowledge.provenance(result.file.path);
    } catch (e) {
      metadataWarning = {
        code: e.code || 'METADATA_UNAVAILABLE',
        message: '文件已保存，但来源记录暂不可用：' + e.message,
      };
    }
    return { ...result, document, ...(metadataWarning ? { metadataWarning } : {}) };
  }
  if (command === 'memos') {
    const kind = w[1],
      kb = f.collection || (await cloud.project(store.root)).knowledgebaseId;
    if (kind === 'bind') {
      if (!f.collection) throw new CloudError('bind 需要 --collection ID。', 'USAGE');
      return cloud.bindProject(store.root, f.collection);
    }
    if (kind === 'unbind') return cloud.bindProject(store.root, null);
    if (kind === 'search') return searchKnowledge(knowledge, cloud, w[2], kb);
    if (kind === 'plan') {
      const { content, ...plan } = await knowledge.publishPlan(w[2], kb, {
        includeAssets: f['include-assets'],
        mode: f.mode || 'navigation',
        summary: f.summary,
        whenToRead: f['when-to-read'],
      });
      return plan;
    }
    if (kind === 'publish') {
      const result = await publish(knowledge, cloud, w[2], kb, {
        expectedRevision: f.expect,
        includeAssets: f['include-assets'],
        mode: f.mode || 'navigation',
        summary: f.summary,
        whenToRead: f['when-to-read'],
      });
      if (result.state === 'failed')
        throw new CloudError(
          '云端处理失败；已有文件不会重复上传，请检查状态并修正原文后提交新版本。',
          'CLOUD_ERROR',
          { publicationId: result.id },
        );
      if (['uncertain', 'sending'].includes(result.state))
        throw new CloudError(
          '发布结果尚未确认，请检查已有发布记录，不要重复上传。',
          'REMOTE_UNCERTAIN',
          { publicationId: result.id },
        );
      return result;
    }
    if (kind === 'publications')
      return knowledge.publications(f.file ? await store.safe(f.file, true) : undefined);
    if (kind === 'refresh') {
      const result = await refreshPublication(knowledge, cloud, w[2]);
      if (result.state === 'failed')
        throw new CloudError(
          '云端处理失败，请检查文件状态；不会重复上传已有版本。',
          'CLOUD_ERROR',
          { publicationId: result.id },
        );
      return result;
    }
    if (kind === 'resolve')
      return resolvePublication(knowledge, cloud, w[2], {
        outcome: f.outcome,
        fileIds: f['file-ids']
          ?.split(',')
          .map((id) => id.trim())
          .filter(Boolean),
        note: f.note,
        confirmed: f.yes === true,
      });
  }
  throw new CloudError('未知命令。运行 folio --help 查看用法。', 'USAGE');
}
async function main() {
  const json = process.argv.includes('--json');
  try {
    const result = await run(process.argv.slice(2));
    if (result?.help && !json) process.stdout.write(result.help);
    else
      process.stdout.write(
        JSON.stringify(json ? { ok: true, data: result } : result, null, json ? 0 : 2) + '\n',
      );
  } catch (e) {
    const code = e.code || 'ERROR';
    const exit =
      {
        USAGE: 2,
        CONFLICT: 3,
        BUSY: 3,
        NOT_CONFIGURED: 4,
        CONFIG: 4,
        AUTH: 4,
        CLOUD_ERROR: 5,
        NETWORK: 5,
        BAD_RESPONSE: 5,
        REMOTE_UNCERTAIN: 6,
        DWS_UNKNOWN: 6,
        DWS_CONFLICT: 3,
        DWS_STALE_PLAN: 3,
        DWS_AUTH: 4,
        DWS_PROFILE: 4,
        DWS_UNAVAILABLE: 4,
        CONFIRMATION_REQUIRED: 2,
        STATE_RECOVERY_REQUIRED: 4,
        SEARCH_CANCELED: 3,
        ENOENT: 2,
        DWS_CONTENT: 2,
        DWS_RENDER_REQUIRED: 2,
        NOT_FOUND: 2,
      }[code] || 1;
    const response = {
      ok: false,
      error: { code, message: e.message, ...(e.details ? { details: e.details } : {}) },
    };
    (json ? process.stdout : process.stderr).write(JSON.stringify(response) + '\n');
    process.exitCode = exit;
  }
}
if (require.main === module) void main();
module.exports = { run, parse, main, HELP, VERSION, appBundle };
