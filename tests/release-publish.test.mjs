import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  main,
  prepareRelease,
  publishRelease,
  releaseVersion,
  releaseNotes,
  parseArgs,
  REPOSITORY,
} from '../scripts/publish-release.mjs';
const execute = promisify(execFile),
  HEAD = 'a'.repeat(40),
  OTHER = 'b'.repeat(40);
async function fixture(
  t,
  {
    version = '0.4.0-beta.4',
    bundleVersion = version,
    cpu = 0x0100000c,
    buildCommit = HEAD,
    buildDirty = false,
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'release'),
    contents = path.join(root, 'bundle', 'Folio.app', 'Contents');
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(contents, 'Resources', 'updater'), { recursive: true });
  await fs.writeFile(
    path.join(contents, 'Resources/updater/build-info.json'),
    JSON.stringify({
      version,
      commit: buildCommit,
      dirty: buildDirty,
      platform: 'darwin',
      arch: 'arm64',
    }),
  );
  for (const relative of [
    'bin/folio',
    'cli/folio.cjs',
    'cli/index-worker.cjs',
    'cli/resvg.wasm',
    'updater/folio-update-helper',
  ]) {
    const file = path.join(contents, 'Resources', relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'generated runtime fixture');
  }
  await fs.mkdir(output);
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(cpu, 4);
  await fs.writeFile(path.join(contents, 'MacOS', 'Folio'), binary);
  await fs.writeFile(path.join(contents, 'Resources', 'app.asar'), 'generated test archive');
  const entries = {
    CFBundleIdentifier: 'io.folio.markdown',
    CFBundleExecutable: 'Folio',
    CFBundleShortVersionString: bundleVersion,
    CFBundleVersion: bundleVersion,
  };
  await fs.writeFile(
    path.join(contents, 'Info.plist'),
    '<plist><dict>' +
      Object.entries(entries)
        .map(([k, v]) => `<key>${k}</key><string>${v}</string>`)
        .join('') +
      '</dict></plist>',
  );
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      version,
      private: true,
      build: { appId: 'io.folio.markdown', directories: { output: 'release' } },
    }),
  );
  await fs.writeFile(
    path.join(root, 'CHANGELOG.md'),
    `# 更新记录\n\n## v${version}（待发布）\n\n- 支持检查更新。\n- 下载后可确认重启安装。\n\n## v0.1.0\n\n旧版功能。\n`,
  );
  const zip = path.join(output, `Folio-${version}-arm64-mac.zip`);
  await execute('/usr/bin/zip', ['-qr', zip, 'Folio.app'], { cwd: path.join(root, 'bundle') });
  const state = {
    calls: [],
    head: HEAD,
    remote: HEAD,
    dirty: false,
    private: true,
    tag: null,
    release: null,
    badUploadedDigest: false,
  };
  const command = async (binary, args, options = {}) => {
    state.calls.push({ binary, args });
    if (binary === 'git') {
      if (args[0] === 'rev-parse') return { stdout: state.head + '\n' };
      if (args[0] === 'status') return { stdout: state.dirty ? ' M code.js\n' : '' };
      if (args[0] === 'symbolic-ref') {
        if (state.detached) throw Error('detached HEAD');
        return { stdout: 'main\n' };
      }
      throw Error('Unexpected git operation');
    }
    if (binary !== 'gh') return execute(binary, args, options);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.env.GH_DEBUG, undefined);
    if (args[0] === 'api') {
      const endpoint = args.find((v) => v.startsWith('repos/'));
      assert(endpoint.startsWith('repos/' + REPOSITORY));
      if (endpoint === 'repos/' + REPOSITORY)
        return {
          stdout: JSON.stringify({
            full_name: REPOSITORY,
            private: state.private,
            default_branch: 'main',
          }),
        };
      if (endpoint.endsWith('/git/ref/heads/main'))
        return { stdout: JSON.stringify({ object: { type: 'commit', sha: state.remote } }) };
      if (endpoint.includes('/git/ref/tags/')) {
        if (!state.tag)
          throw Object.assign(Error('not found'), { stderr: 'gh: Not Found (HTTP 404)' });
        return { stdout: JSON.stringify({ object: { type: 'commit', sha: state.tag } }) };
      }
      if (endpoint.endsWith('/git/refs')) {
        const body = JSON.parse(await fs.readFile(args[args.indexOf('--input') + 1], 'utf8'));
        assert.equal(body.sha, HEAD);
        assert.equal(body.ref, 'refs/tags/v' + version);
        state.tag = body.sha;
        return { stdout: JSON.stringify({ object: { type: 'commit', sha: body.sha } }) };
      }
      if (endpoint.includes('/releases?'))
        return { stdout: JSON.stringify(state.release ? [state.release] : []) };
      throw Error('Unexpected API operation ' + endpoint);
    }
    assert.equal(args[args.indexOf('--repo') + 1], REPOSITORY);
    if (args[1] === 'create') {
      assert(args.includes('--verify-tag'));
      assert(args.includes('--draft'));
      assert.equal(state.tag, HEAD);
      state.release = {
        id: 1,
        tag_name: 'v' + version,
        draft: true,
        prerelease: version.includes('-'),
        html_url: 'https://github.com/' + REPOSITORY + '/releases/tag/v' + version,
        assets: [],
      };
      return { stdout: '' };
    }
    if (args[1] === 'upload') {
      assert(!args.includes('--clobber'));
      assert.equal(state.release.draft, true);
      const file = args[3],
        bytes = await fs.readFile(file);
      state.release.assets.push({
        id: state.release.assets.length + 1,
        name: path.basename(file),
        state: 'uploaded',
        size: bytes.length,
        digest:
          'sha256:' +
          (state.badUploadedDigest
            ? '0'.repeat(64)
            : crypto.createHash('sha256').update(bytes).digest('hex')),
      });
      return { stdout: '' };
    }
    if (args[1] === 'edit') {
      assert(args.includes('--draft=false'));
      assert.equal(state.release.assets.length, 2);
      state.release.draft = false;
      return { stdout: '' };
    }
    throw Error('Unexpected gh command');
  };
  return { root, output, zip, state, command };
}
const mutations = (state) =>
  state.calls.filter(
    (c) => c.binary === 'gh' && (c.args[0] === 'release' || c.args.includes('POST')),
  );
test('release semver and notes reject ambiguity and omit development heading annotations', () => {
  assert.equal(releaseVersion('0.4.0-beta.10').prerelease, true);
  assert.equal(releaseVersion('1.0.0').prerelease, false);
  for (const version of ['v1.0.0', '01.0.0', '1.0', '1.0.0-beta.01', '1.0.0+local', '1.0.0\n'])
    assert.throws(() => releaseVersion(version));
  assert.throws(() => parseArgs(['--publish', '--dry-run']));
  assert.throws(() => parseArgs(['--commit', 'main']));
  assert.throws(() => parseArgs(['--repo', 'other/repo']));
  const notes = releaseNotes('## v1.0.0（待发布）\n\n- New.\n\n## v0.1.0\n\nOld.', 'v1.0.0');
  assert(notes.includes('- New.'));
  assert(!notes.includes('Old.'));
  assert(!notes.includes('待发布'));
  assert(!notes.includes('私有仓库'));
  assert(notes.includes('https://github.com/MemTensor/Folio/releases'));
});
test('default prepare and dry-run only generate local verified assets', async (t) => {
  const f = await fixture(t);
  const result = await main([], { root: f.root, command: f.command });
  assert.equal(result.state, 'prepared');
  assert.equal(f.state.calls.filter((c) => c.binary === 'gh').length, 0);
  const checksum = await fs.readFile(path.join(f.output, 'SHA256SUMS.txt'), 'utf8');
  assert(checksum.endsWith('  Folio-0.4.0-beta.4-arm64-mac.zip\n'));
  const first = checksum;
  await main(['--dry-run'], { root: f.root, command: f.command });
  assert.equal(await fs.readFile(path.join(f.output, 'SHA256SUMS.txt'), 'utf8'), first);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.output, 'release-plan.json'), 'utf8')).commit,
    HEAD,
  );
});
test('incorrect bundle version or architecture stops preparation', async (t) => {
  for (const options of [{ bundleVersion: '0.4.0-beta.3' }, { cpu: 0x01000007 }]) {
    const f = await fixture(t, options);
    await assert.rejects(prepareRelease(f));
    assert.equal(f.state.calls.filter((c) => c.binary === 'gh').length, 0);
  }
});
test('publish requires clean pushed HEAD and private fixed repository before mutations', async (t) => {
  for (const change of [{ dirty: true }, { remote: OTHER }, { private: false }, { tag: OTHER }]) {
    const f = await fixture(t),
      plan = await prepareRelease(f);
    Object.assign(f.state, change);
    await assert.rejects(publishRelease(plan, f));
    assert.equal(mutations(f.state).length, 0);
  }
});
test('publish creates exact tag then draft, validates assets, and publishes once', async (t) => {
  const f = await fixture(t),
    plan = await prepareRelease(f),
    result = await publishRelease(plan, f);
  assert.equal(result.state, 'published');
  assert.equal(f.state.tag, HEAD);
  assert.equal(f.state.release.draft, false);
  assert.deepEqual(
    f.state.calls.filter((c) => c.binary === 'gh' && c.args[0] === 'release').map((c) => c.args[1]),
    ['create', 'upload', 'upload', 'edit'],
  );
  const before = mutations(f.state).length;
  assert.equal((await publishRelease(plan, f)).state, 'already-published');
  assert.equal(mutations(f.state).length, before);
});
test('matching draft resumes only missing assets and never overwrites an asset', async (t) => {
  const f = await fixture(t),
    plan = await prepareRelease(f);
  f.state.tag = HEAD;
  f.state.release = {
    id: 1,
    tag_name: plan.tag,
    draft: true,
    prerelease: true,
    assets: [
      {
        id: 1,
        name: plan.assets[0].name,
        state: 'uploaded',
        size: plan.assets[0].size,
        digest: 'sha256:' + plan.assets[0].sha256,
      },
    ],
  };
  await publishRelease(plan, f);
  assert.deepEqual(
    f.state.calls.filter((c) => c.binary === 'gh' && c.args[0] === 'release').map((c) => c.args[1]),
    ['upload', 'edit'],
  );
});
test('mismatched existing assets or changed local ZIP fail before remote mutations', async (t) => {
  const f = await fixture(t),
    plan = await prepareRelease(f);
  f.state.tag = HEAD;
  f.state.release = {
    id: 1,
    tag_name: plan.tag,
    draft: true,
    prerelease: true,
    assets: [
      {
        name: plan.assets[0].name,
        state: 'uploaded',
        size: plan.assets[0].size,
        digest: 'sha256:' + '0'.repeat(64),
      },
    ],
  };
  await assert.rejects(publishRelease(plan, f), /拒绝覆盖/);
  assert.equal(mutations(f.state).length, 0);
  f.state.release = null;
  await fs.appendFile(f.zip, 'changed');
  await assert.rejects(publishRelease(plan, f), /发生变化/);
  assert.equal(mutations(f.state).length, 0);
});
test('bad upload readback leaves the draft unpublished', async (t) => {
  const f = await fixture(t),
    plan = await prepareRelease(f);
  f.state.badUploadedDigest = true;
  await assert.rejects(publishRelease(plan, f), /拒绝覆盖/);
  assert.equal(f.state.release.draft, true);
  assert(!f.state.calls.some((c) => c.binary === 'gh' && c.args[1] === 'edit'));
});

test('release rejects binaries from a different or dirty source tree', async (t) => {
  const stale = await fixture(t, { buildCommit: OTHER });
  await assert.rejects(prepareRelease(stale), /干净提交/);
  const dirty = await fixture(t, { buildDirty: true });
  await assert.rejects(prepareRelease(dirty), /干净提交/);
});
test('a clean detached build may publish the exact pushed default-branch commit', async (t) => {
  const f = await fixture(t);
  f.state.detached = true;
  const plan = await prepareRelease(f);
  const result = await publishRelease(plan, f);
  assert.equal(result.state, 'published');
  assert.equal(result.commit, HEAD);
});

test('publication rejects an actual ZIP missing the CLI or future updater helper', async (t) => {
  for (const file of ['cli/folio.cjs', 'updater/folio-update-helper']) {
    const f = await fixture(t);
    await execute('/usr/bin/zip', ['-dq', f.zip, 'Folio.app/Contents/Resources/' + file]);
    await assert.rejects(prepareRelease(f), /安装包缺少/);
    assert.deepEqual(mutations(f.state), []);
  }
});

test('public publication requires an explicit matching visibility selection', async (t) => {
  const f = await fixture(t),
    plan = await prepareRelease(f);
  f.state.private = false;
  await assert.rejects(publishRelease(plan, f), /可见性/);
  assert.deepEqual(mutations(f.state), []);
  assert.deepEqual(parseArgs(['--publish', '--visibility', 'public']), {
    publish: true,
    visibility: 'public',
  });
  assert.throws(() => parseArgs(['--visibility', 'internal']));
  const result = await publishRelease(plan, { ...f, visibility: 'public' });
  assert.equal(result.state, 'published');
  assert.equal(f.state.private, false);
  assert(!f.state.calls.some((c) => c.binary === 'gh' && c.args[0] === 'repo'));
});

test('a visibility change during asset upload leaves the draft unpublished', async (t) => {
  const f = await fixture(t),
    plan = await prepareRelease(f);
  f.state.private = false;
  const command = async (binary, args, options) => {
    const result = await f.command(binary, args, options);
    if (binary === 'gh' && args[0] === 'release' && args[1] === 'upload') f.state.private = true;
    return result;
  };
  await assert.rejects(
    publishRelease(plan, { ...f, command, visibility: 'public' }),
    /可见性已变化/,
  );
  assert.equal(f.state.release.draft, true);
});
