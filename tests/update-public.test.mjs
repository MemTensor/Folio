import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const require = createRequire(import.meta.url);
const { GitHubUpdateSource } = require('../core/update-source.cjs');
function ghReply(body, code = 0, error = '') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.stdout.destroy();
    child.emit('close', 1);
  };
  setImmediate(() => {
    child.stdout.end(body);
    child.stderr.end(error);
    child.emit('close', code);
  });
  return child;
}
test('public release lookup and asset download ignore a broken gh and invalid GH_TOKEN', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-public-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'generated-invalid-token';
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  let ghCalls = 0;
  const requests = [],
    bytes = Buffer.from('generated release archive');
  const source = new GitHubUpdateSource({
    ghBinary: '/generated/gh',
    spawnImpl: () => {
      ghCalls++;
      return ghReply('bad auth', 1, 'HTTP 401');
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(url.includes('/assets/') ? bytes : '[]');
    },
  });
  assert.deepEqual(await source.listReleases(), []);
  const destination = path.join(root, 'release.zip');
  await source.asset({ id: 23, size: bytes.length }, { destination });
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.equal(ghCalls, 0);
  for (const { options } of requests) assert.equal(options.headers.Authorization, undefined);
});

test('restricted releases retain bounded gh fallback after anonymous access fails', async () => {
  let ghCalls = 0;
  const source = new GitHubUpdateSource({
    ghBinary: '/generated/gh',
    fetchImpl: async () => new Response('private', { status: 404 }),
    spawnImpl: () => {
      ghCalls++;
      return ghReply('[]');
    },
  });
  assert.deepEqual(await source.listReleases(), []);
  assert.equal(ghCalls, 1);
});

test('anonymous access errors stay actionable when gh authentication also fails', async () => {
  for (const [status, code] of [
    [401, 'AUTH_REQUIRED'],
    [403, 'ACCESS_DENIED'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
  ]) {
    const source = new GitHubUpdateSource({
      ghBinary: '/generated/gh',
      fetchImpl: async () => new Response('', { status }),
      spawnImpl: () =>
        ghReply('generated partial auth response', 1, 'HTTP 401 generated-invalid-token'),
    });
    await assert.rejects(source.listReleases(), (error) => {
      assert.equal(error.code, code);
      assert(!error.message.includes('generated-invalid-token'));
      assert(!error.message.includes('私有测试版'));
      return true;
    });
  }
});

test('cancel, size limits and unsafe redirects never fall back to gh', async () => {
  let ghCalls = 0;
  const make = (fetchImpl) =>
    new GitHubUpdateSource({
      ghBinary: '/generated/gh',
      fetchImpl,
      spawnImpl: () => {
        ghCalls++;
        return ghReply('[]');
      },
    });
  await assert.rejects(
    make(async () => new Response('oversize')).request('repos/MemTensor/Folio/releases', {
      maxBytes: 1,
    }),
    { code: 'TOO_LARGE' },
  );
  await assert.rejects(
    make(
      async () =>
        new Response('', { status: 302, headers: { location: 'https://invalid.example/archive' } }),
    ).listReleases(),
    { code: 'BAD_SOURCE' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    make(async () => {
      throw Error('not reached');
    }).listReleases({ signal: controller.signal }),
    { code: 'CANCELED' },
  );
  assert.equal(ghCalls, 0);
});

test('an immediate anonymous network failure can use gh without requiring it for successful public requests', async () => {
  let ghCalls = 0;
  const source = new GitHubUpdateSource({
    ghBinary: '/generated/gh',
    fetchImpl: async () => {
      throw TypeError('generated connection failure');
    },
    spawnImpl: () => {
      ghCalls++;
      return ghReply('[]');
    },
  });
  assert.deepEqual(await source.listReleases(), []);
  assert.equal(ghCalls, 1);
});
test('partial HTTP bodies are not concatenated with a second transport', async () => {
  let ghCalls = 0,
    step = 0;
  const source = new GitHubUpdateSource({
    ghBinary: '/generated/gh',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (step++ === 0) controller.enqueue(new TextEncoder().encode('partial'));
            else controller.error(Error('generated interrupted body'));
          },
        }),
      ),
    spawnImpl: () => {
      ghCalls++;
      return ghReply('[]');
    },
  });
  await assert.rejects(source.listReleases(), { code: 'NETWORK' });
  assert.equal(ghCalls, 0);
});
test('rate-limit headers on anonymous 403 use a specific diagnostic', async () => {
  const source = new GitHubUpdateSource({
    ghBinary: null,
    fetchImpl: async () =>
      new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  });
  await assert.rejects(source.listReleases(), { code: 'RATE_LIMITED' });
});
