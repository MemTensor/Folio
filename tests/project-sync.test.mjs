import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProjectSync, referencedFiles, MAX_FILE_BYTES } = require('../core/project-sync.cjs');
const { digest } = require('../core/state.cjs');
async function setup(t, limits = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-project-sync-')));
  const home = path.join(tmp, 'home'),
    root = path.join(home, 'project'),
    cloudRoot = path.join(tmp, 'cloud', 'Folio'),
    dataDir = path.join(tmp, 'state');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.dirname(cloudRoot));
  const project = { id: digest(root).slice(0, 24), root, name: 'Project' };
  const sync = new ProjectSync(dataDir, { home, cloudRoot, limits });
  t.after(async () => {
    await sync.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return {
    tmp,
    root,
    home,
    cloudRoot,
    dataDir,
    cloud: path.join(cloudRoot, 'Project-' + project.id),
    project,
    sync,
    run: () => sync.sync({ projects: [project] }),
  };
}
async function put(root, relative, content) {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}
const read = (root, relative) => fs.readFile(path.join(root, relative), 'utf8');
const missing = (file) => assert.rejects(fs.stat(file), { code: 'ENOENT' });

test('sync is off by default; inspecting and configuring never touches cloud files', async (t) => {
  const { sync, cloudRoot, project, run } = await setup(t);
  assert.equal((await sync.status()).enabled, false);
  assert.equal((await run()).disabled, true);
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await missing(cloudRoot);
});
test('only chosen registered projects sync; markdown and referenced attachments are copied', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(
    root,
    'docs/readme.md',
    '# Hello\n![Plot](../images/chart.png)\n[Report](../files/report.pdf)\n[Bad](../credentials.txt)\n[Code](../script.js)',
  );
  await put(root, 'images/chart.png', 'image');
  await put(root, 'images/unreferenced.png', 'private');
  await put(root, 'files/report.pdf', 'pdf');
  await put(root, 'credentials.txt', 'secret');
  await put(root, 'script.js', 'code');
  await put(root, '.hidden.md', 'hidden');
  await put(root, 'node_modules/package/README.md', 'dependency');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  const unregistered = await sync.sync({ projects: [] });
  assert.equal(unregistered.skipped[0].code, 'PROJECT_NOT_OPEN');
  const result = await run();
  assert.equal(result.uploaded, 3);
  assert.equal(await read(cloud, 'docs/readme.md'), await read(root, 'docs/readme.md'));
  assert.equal(await read(cloud, 'images/chart.png'), 'image');
  await missing(path.join(cloud, 'images/unreferenced.png'));
  await missing(path.join(cloud, 'credentials.txt'));
  await missing(path.join(cloud, 'script.js'));
  await missing(path.join(cloud, '.hidden.md'));
  await missing(path.join(cloud, 'node_modules'));
});
test('single-sided edits synchronize both ways and preserve overwritten bytes for recovery', async (t) => {
  const { sync, root, cloud, dataDir, project, run } = await setup(t);
  await put(root, 'note.md', 'original');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  await put(root, 'note.md', 'local edit');
  assert.equal((await run()).uploaded, 1);
  assert.equal(await read(cloud, 'note.md'), 'local edit');
  await put(cloud, 'note.md', 'cloud edit');
  assert.equal((await run()).downloaded, 1);
  assert.equal(await read(root, 'note.md'), 'cloud edit');
  const index = JSON.parse(await read(path.join(dataDir, 'sync-recovery'), 'index.json'));
  assert(index.some((item) => item.hash === digest('local edit') && item.path === 'note.md'));
  assert.equal(
    await read(path.join(dataDir, 'sync-recovery'), digest('local edit') + '.md'),
    'local edit',
  );
});
test('both-sided edit stays intact until user resolves against exact hashes', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'base');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  await put(root, 'note.md', 'local');
  await put(cloud, 'note.md', 'cloud');
  const { conflicts } = await run();
  assert.equal(conflicts.length, 1);
  assert.equal(await read(root, 'note.md'), 'local');
  assert.equal(await read(cloud, 'note.md'), 'cloud');
  await assert.rejects(
    sync.resolve({ project, ...conflicts[0], choice: 'use-cloud', localHash: digest('old') }),
    { code: 'SYNC_CONFLICT' },
  );
  await sync.resolve({ project, ...conflicts[0], choice: 'use-cloud' });
  assert.equal(await read(root, 'note.md'), 'cloud');
  assert.equal((await sync.status()).lastRun.conflicts.length, 0);
});
test('keep-local is an explicit conflict resolution; edited cloud invalidates stale choice', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'local');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await fs.mkdir(cloud, { recursive: true });
  await put(cloud, 'note.md', 'cloud');
  let conflict = (await run()).conflicts[0];
  await put(cloud, 'note.md', 'new cloud');
  await assert.rejects(sync.resolve({ project, ...conflict, choice: 'keep-local' }), {
    code: 'SYNC_CONFLICT',
  });
  conflict = (await run()).conflicts[0];
  await sync.resolve({ project, ...conflict, choice: 'keep-local' });
  assert.equal(await read(cloud, 'note.md'), 'local');
});
test('deletions never destroy or silently restore the other side', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'local-delete.md', 'a');
  await put(root, 'cloud-delete.md', 'b');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  await fs.unlink(path.join(root, 'local-delete.md'));
  await fs.unlink(path.join(cloud, 'cloud-delete.md'));
  const result = await run();
  assert.equal(result.skipped.filter((item) => item.code === 'DELETION_PRESERVED').length, 2);
  assert.equal(await read(cloud, 'local-delete.md'), 'a');
  assert.equal(await read(root, 'cloud-delete.md'), 'b');
  await missing(path.join(root, 'local-delete.md'));
  await missing(path.join(cloud, 'cloud-delete.md'));
});
test('cloud-only markdown and its referenced attachment import; unreferenced files do not', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await put(cloud, 'remote.md', '![image](pic.png)');
  await put(cloud, 'pic.png', 'image');
  await put(cloud, 'unlinked.pdf', 'pdf');
  const result = await run();
  assert.equal(result.downloaded, 2);
  assert.equal(await read(root, 'pic.png'), 'image');
  await missing(path.join(root, 'unlinked.pdf'));
});
test('symlinks, root escapes and over-100MB files cannot upload', async (t) => {
  const { sync, root, cloud, tmp, project, run } = await setup(t);
  await put(tmp, 'outside.pdf', 'private');
  await fs.symlink(path.join(tmp, 'outside.pdf'), path.join(root, 'link.pdf'));
  await put(
    root,
    'readme.md',
    '[link](link.pdf)\n[outside](../../outside.pdf)\n[large](large.pdf)',
  );
  const large = await fs.open(path.join(root, 'large.pdf'), 'w');
  await large.truncate(MAX_FILE_BYTES);
  await large.close();
  await sync.configure({ enabled: true, projectIds: [project.id] });
  const result = await run();
  assert.equal(result.uploaded, 1);
  assert(result.skipped.some((item) => item.path === 'large.pdf' && item.code === 'SYNC_SIZE'));
  await missing(path.join(cloud, 'large.pdf'));
  await missing(path.join(cloud, 'link.pdf'));
  assert.equal(await read(tmp, 'outside.pdf'), 'private');
});
test('symlink replacement of cloud directory cannot redirect a write', async (t) => {
  const { sync, root, cloud, tmp, project, run } = await setup(t);
  await put(root, 'note.md', 'local');
  await fs.mkdir(path.dirname(cloud), { recursive: true });
  const other = path.join(tmp, 'other');
  await fs.mkdir(other);
  await fs.symlink(other, cloud);
  await sync.configure({ enabled: true, projectIds: [project.id] });
  assert.equal((await run()).skipped[0].code, 'SYNC_PATH');
  await missing(path.join(other, 'note.md'));
});
test('unchanged files use metadata and cached hashes instead of re-reading document contents', async (t) => {
  const { sync, root, project, run } = await setup(t);
  await put(root, 'note.md', '# Hello\n![pic](pic.png)');
  await put(root, 'pic.png', 'image');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  await run();
  const third = await run();
  assert.equal(third.bytesRead, 0);
  assert.equal(third.unchanged, 2);
});
test('strict entry and byte limits stop scans without deletions', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t, { maxEntries: 2, maxBytes: 5 });
  for (const name of ['a.md', 'b.md', 'c.md']) await put(root, name, 'content longer than limit');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  const result = await run();
  assert.equal(result.limited, true);
  assert.equal(result.uploaded, 0);
  assert.equal(await read(root, 'a.md'), 'content longer than limit');
  await missing(path.join(cloud, 'a.md'));
});
test('a destination created during sync is preserved by exclusive creation', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'local');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  const original = sync.writeExpected.bind(sync);
  sync.writeExpected = async (...args) => {
    await put(cloud, 'note.md', 'concurrent cloud edit');
    return original(...args);
  };
  const result = await run();
  assert.equal(result.conflicts.length, 1);
  assert.equal(await read(cloud, 'note.md'), 'concurrent cloud edit');
});
test('Markdown reference parser supports reference links and ignores code, remote URLs and hidden files', () => {
  assert.deepEqual(
    referencedFiles(
      '![a][img]\n\n[img]: ../assets/a%20b.png\n\n`![x](secret.pdf)`\n[x](https://example.com/a.pdf)\n[x](../.env)\n[x](bad%QQ.png)',
      'docs/readme.md',
    ),
    ['assets/a b.png', 'docs/bad%QQ.png'],
  );
});

test('cloud pull rechecks a locally edited destination after scan', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'base');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  await put(cloud, 'note.md', 'cloud edit');
  const original = sync.writeExpected.bind(sync);
  sync.writeExpected = async (...args) => {
    await put(root, 'note.md', 'new local edit');
    return original(...args);
  };
  const result = await run();
  assert.equal(result.conflicts.length, 1);
  assert.equal(await read(root, 'note.md'), 'new local edit');
  assert.equal(await read(cloud, 'note.md'), 'cloud edit');
});
test('cloud watch is native, non-recursive and restricted to selected known directories', async (t) => {
  const { sync, root, project, run } = await setup(t);
  assert.deepEqual(await sync.watch([project], () => {}), {
    watching: false,
    directories: 0,
    limited: false,
  });
  await put(root, 'docs/readme.md', '# Test');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  assert.deepEqual(await sync.watch([project], () => {}), {
    watching: true,
    directories: 2,
    limited: false,
  });
  await sync.close();
  assert.equal(sync.watchers.length, 0);
});

test('another device binds an existing readable cloud project without exposing local paths in metadata', async (t) => {
  const { sync, root, cloud, cloudRoot, tmp, project, run } = await setup(t);
  await put(root, 'note.md', 'shared');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  const metadata = JSON.parse(await read(cloud, '.folio-project.json'));
  assert.deepEqual(metadata, { version: 1, id: project.id, name: project.name });
  assert.equal((await sync.listCloudProjects()).projects[0].path, cloud);
  const secondRoot = path.join(tmp, 'second-device', 'renamed-project');
  await fs.mkdir(secondRoot, { recursive: true });
  const second = { id: digest(secondRoot).slice(0, 24), root: secondRoot, name: 'Different Name' };
  const other = new ProjectSync(path.join(tmp, 'second-state'), {
    cloudRoot,
    home: path.dirname(secondRoot),
  });
  t.after(() => other.close());
  await other.configure({ enabled: true, projectIds: [second.id] });
  await other.bindCloudProject(second.id, project.id);
  const result = await other.sync({ projects: [second] });
  assert.equal(result.downloaded, 1);
  assert.equal(await read(secondRoot, 'note.md'), 'shared');
  assert.equal((await other.listCloudProjects()).projects.length, 1);
});

test('damaged optional sync state recovers backup; damage to both disables safely', async (t) => {
  const { sync, project, dataDir, root, run } = await setup(t);
  await put(root, 'note.md', 'original');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  const file = path.join(dataDir, 'project-sync.json');
  await fs.writeFile(file, '{');
  assert.equal((await sync.status()).enabled, true);
  assert.equal((await sync.status()).recovery, 'backup');
  await fs.writeFile(file, '{');
  await fs.writeFile(file + '.backup', '{');
  assert.equal((await sync.status()).enabled, false);
  assert.equal((await sync.status()).recovery, 'reset');
  assert.equal(await read(root, 'note.md'), 'original');
});
test('atomic capture preserves a local edit in the final replace window', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'base');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  await put(cloud, 'note.md', 'cloud edit');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (
      from === path.join(root, 'note.md') &&
      path.basename(to).startsWith('.folio-sync-captured-')
    )
      await fs.writeFile(from, 'last-moment local edit');
    return rename(from, to);
  };
  let result;
  try {
    result = await run();
  } finally {
    fs.rename = rename;
  }
  assert.equal(result.conflicts.length, 1);
  assert.equal(await read(root, 'note.md'), 'last-moment local edit');
  assert.equal(await read(cloud, 'note.md'), 'cloud edit');
});
test('metadata symlinks do not get followed or rewritten', async (t) => {
  const { sync, root, cloud, tmp, project, run } = await setup(t);
  await put(root, 'note.md', 'local');
  await put(tmp, 'outside.json', '{"secret":"private"}');
  await fs.mkdir(cloud, { recursive: true });
  await fs.symlink(path.join(tmp, 'outside.json'), path.join(cloud, '.folio-project.json'));
  await sync.configure({ enabled: true, projectIds: [project.id] });
  assert.equal((await run()).skipped[0].code, 'SYNC_METADATA');
  assert.equal(await read(tmp, 'outside.json'), '{"secret":"private"}');
  await missing(path.join(cloud, 'note.md'));
});
test(
  'watch coalesces selected cloud changes and performs no idle scans',
  {
    skip:
      process.env.CODEX_SANDBOX === 'seatbelt'
        ? 'macOS seatbelt sandbox suppresses native filesystem events; verified outside sandbox'
        : false,
  },
  async (t) => {
    const { sync, root, cloud, project, run } = await setup(t);
    await put(root, 'note.md', 'base');
    await sync.configure({ enabled: true, projectIds: [project.id] });
    await run();
    let calls = 0;
    let done;
    const changed = new Promise((resolve) => {
      done = resolve;
    });
    await sync.watch([project], () => {
      calls++;
      done();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls, 0);
    await put(cloud, 'note.md', 'cloud edit');
    await put(cloud, 'note.md', 'final cloud edit');
    let timeout;
    try {
      await Promise.race([
        changed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('missing native watch event')), 6000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(calls, 1);
    assert.equal(await read(root, 'note.md'), 'base');
    assert.equal((await run()).downloaded, 1);
    assert.equal(await read(root, 'note.md'), 'final cloud edit');
  },
);

test('disconnecting a cloud mapping preserves both sides and resets its merge baseline', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'original');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  const another = '0123456789abcdef01234567';
  await assert.rejects(sync.bindCloudProject(another, project.id), { code: 'SYNC_CONFIG' });
  await sync.configure({ enabled: false, projectIds: [] });
  await sync.bindCloudProject(another, project.id);
  assert.equal((await sync.status()).bindings[another], project.id);
  await sync.bindCloudProject(another, null);
  assert.equal((await sync.status()).bindings[another], undefined);
  assert.equal(await read(root, 'note.md'), 'original');
  assert.equal(await read(cloud, 'note.md'), 'original');
});

test('a file emptied by an outside writer is raised as a resolvable conflict', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'thesis.md', '# Thesis\n'.repeat(400));
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  assert.equal((await read(cloud, 'thesis.md')).length > 1000, true);
  // A writer that truncates before writing leaves a valid zero-byte file behind
  // for an instant. Publishing that would erase the copy on every other device.
  await fs.writeFile(path.join(root, 'thesis.md'), '');
  const result = await run();
  assert.equal(result.uploaded, 0);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.equal(conflict.path, 'thesis.md');
  assert.equal((await read(cloud, 'thesis.md')).length > 1000, true, 'cloud copy is untouched');
  // The record has to carry hashes, or neither resolution button can act on it.
  await sync.resolve({
    project,
    path: conflict.path,
    choice: 'use-cloud',
    localHash: conflict.localHash,
    cloudHash: conflict.cloudHash,
  });
  assert.equal((await read(root, 'thesis.md')).length > 1000, true);
});

test('an evicted iCloud file is skipped rather than treated as a deletion', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'local body');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  assert.equal(await read(cloud, 'note.md'), 'local body');
  // macOS evicts by replacing the file with a `.name.icloud` placeholder.
  await fs.rm(path.join(cloud, 'note.md'));
  await fs.writeFile(path.join(cloud, '.note.md.icloud'), 'placeholder');
  const result = await run();
  assert.equal(result.downloaded, 0);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(
    result.skipped.map((item) => item.code),
    ['SYNC_NOT_DOWNLOADED'],
  );
  assert.equal(await read(root, 'note.md'), 'local body', 'the local document is left alone');
});

test('a large project cannot starve the ones queued behind it', async (t) => {
  // maxEntries is per project, so the small project is reached on the first run
  // rather than waiting for a round that never comes.
  const { sync, tmp, home, cloudRoot, dataDir } = await setup(t, { maxEntries: 30 });
  const big = path.join(home, 'big'),
    small = path.join(home, 'small');
  await fs.mkdir(big, { recursive: true });
  await fs.mkdir(small, { recursive: true });
  for (let index = 0; index < 60; index++) await put(big, `note-${index}.md`, 'body ' + index);
  await put(small, 'only.md', 'small body');
  const projects = [
    { id: digest(big).slice(0, 24), root: big, name: 'Big' },
    { id: digest(small).slice(0, 24), root: small, name: 'Small' },
  ];
  await sync.configure({ enabled: true, projectIds: projects.map((p) => p.id) });
  const result = await sync.sync({ projects });
  assert.equal(result.limited, true, 'the big project is reported as partial');
  const smallCloud = path.join(cloudRoot, 'Small-' + projects[1].id);
  assert.equal(await read(smallCloud, 'only.md'), 'small body');
  assert.equal(typeof tmp, 'string');
  assert.equal(typeof dataDir, 'string');
});

test('a file recreated after both sides deleted it syncs again even with identical bytes', async (t) => {
  const { sync, root, cloud, project, run } = await setup(t);
  await put(root, 'note.md', 'same generated content');
  await sync.configure({ enabled: true, projectIds: [project.id] });
  await run();
  await fs.unlink(path.join(root, 'note.md'));
  await fs.unlink(path.join(cloud, 'note.md'));
  await run();
  await put(root, 'note.md', 'same generated content');
  assert.equal((await run()).uploaded, 1);
  assert.equal(await read(cloud, 'note.md'), 'same generated content');
});
