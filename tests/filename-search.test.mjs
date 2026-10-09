import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../core/index-worker.cjs', import.meta.url));
async function setup(t, { clockStep = 0 } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-filenames-'))),
    root = path.join(temporary, 'project'),
    state = path.join(temporary, 'state');
  await fs.mkdir(root);
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    const fs=require('node:fs'),path=require('node:path');
    const reads=[];
    let directoryReads=0;
    for(const method of ['openSync','readFileSync','readSync']) {
      const original=fs[method];
      fs[method]=function(target,...args) {
        if(typeof target==='number'||(typeof target==='string'&&(target===workerData.root||target.startsWith(workerData.root+path.sep)))) {
          reads.push({method,path:typeof target==='number'?'descriptor':path.relative(workerData.root,target)});
          throw Error('Test forbids reading document bodies');
        }
        return original.call(this,target,...args);
      };
    }
    const openDirectory=fs.opendirSync;
    fs.opendirSync=function(...args){directoryReads++;return openDirectory.apply(this,args);};
    if(workerData.clockStep){
      let clock=0;
      Object.defineProperty(globalThis,'performance',{value:{now:()=>clock+=workerData.clockStep}});
    }
    const post=parentPort.postMessage.bind(parentPort);
    parentPort.postMessage=(message)=>post({...message,audit:{reads,directoryReads}});
    require(workerData.entry);
  `,
    { eval: true, workerData: { entry, root, dataDir: state, clockStep } },
  );
  t.after(async () => {
    await worker.terminate();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  let sequence = 0;
  const request = (query) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(Error('Filename fixture timed out')), 8000);
      const receive = (message) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        worker.off('message', receive);
        worker.off('error', failed);
        if (message.error) reject(Error(message.error.message));
        else resolve(message);
      };
      const failed = (error) => {
        clearTimeout(timer);
        worker.off('message', receive);
        reject(error);
      };
      worker.on('message', receive);
      worker.once('error', failed);
      worker.postMessage({ id, operation: 'filenames', root, query });
    });
  return { temporary, root, state, request };
}

test('filename lookup reads no document content and creates no full-text index', async (t) => {
  const { temporary, root, state, request } = await setup(t);
  await fs.mkdir(path.join(root, 'notes'));
  await fs.writeFile(path.join(root, 'notes', 'Research.md'), Buffer.from([0xff, 0x00, 0xfe]));
  await fs.writeFile(
    path.join(root, 'plain.md'),
    'A body-only-needle never becomes a filename hit.',
  );
  await fs.writeFile(path.join(temporary, 'outside.md'), 'outside fixture');
  await fs.symlink(path.join(temporary, 'outside.md'), path.join(root, 'Research-link.md'));
  const matched = await request('research');
  assert.deepEqual(matched.result.documents, [
    { path: path.join(root, 'notes', 'Research.md'), name: 'Research.md' },
  ]);
  assert.deepEqual(matched.audit.reads, []);
  assert.equal(matched.result.limited, false);
  assert.deepEqual((await request('body-only-needle')).result.documents, []);
  await assert.rejects(fs.access(path.join(state, 'document-index')), { code: 'ENOENT' });
});

test('empty quick-open does not recursively enumerate a project', async (t) => {
  const { root, request } = await setup(t);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'hidden-until-search.md'), 'fixture');
  const result = await request('  ');
  assert.deepEqual(result.result, { documents: [], limited: false });
  assert.equal(result.audit.directoryReads, 0);
  assert.deepEqual(result.audit.reads, []);
});

test('filename matches are capped at 100 and dependency folders are skipped', async (t) => {
  const { root, request } = await setup(t);
  await Promise.all(
    Array.from({ length: 105 }, (_, index) =>
      fs.writeFile(path.join(root, `Note-${index}.md`), 'fixture'),
    ),
  );
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'Dependency.md'), 'fixture');
  const result = await request('note');
  assert.equal(result.result.documents.length, 100);
  assert.equal(result.result.limited, true);
  assert.deepEqual(result.audit.reads, []);
  assert.deepEqual((await request('Dependency')).result.documents, []);
});

test('deep directory trees are bounded and reported as partial', async (t) => {
  const { root, request } = await setup(t);
  const deep = path.join(root, ...Array.from({ length: 17 }, (_, index) => 'level-' + index));
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, 'Deep-note.md'), 'fixture');
  await fs.writeFile(path.join(root, 'Root-note.md'), 'fixture');
  const result = await request('note');
  assert.deepEqual(
    result.result.documents.map((item) => item.name),
    ['Root-note.md'],
  );
  assert.equal(result.result.limited, true);
  assert.deepEqual(result.audit.reads, []);
});

test('filename traversal stops when the 700ms metadata budget expires', async (t) => {
  const { root, request } = await setup(t, { clockStep: 400 });
  await fs.writeFile(path.join(root, 'Note.md'), 'fixture');
  const result = await request('note');
  assert.equal(result.result.limited, true);
  assert.deepEqual(result.result.documents, []);
  assert.deepEqual(result.audit.reads, []);
  assert(result.audit.directoryReads <= 1);
});

test('an exhausted traversal still returns the matches it already collected', async (t) => {
  // A slow volume must not turn quick-open into a search that finds nothing: the
  // budget bounds how much of the tree is walked, never which of the walked
  // entries are reported.
  const { root, request } = await setup(t, { clockStep: 100 });
  // Everything sits directly in the root so the traversal collects matches before
  // its deadline expires partway through the same directory.
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      fs.writeFile(path.join(root, `Note-${index}.md`), 'fixture'),
    ),
  );
  const result = await request('note');
  assert.equal(result.result.limited, true);
  assert(
    result.result.documents.length > 0,
    'expected the partially scanned tree to report its matches',
  );
  assert(result.result.documents.every((item) => item.name.startsWith('Note-')));
  assert.deepEqual(result.audit.reads, []);
});

test('filename matching normalises composed and decomposed names alike', async (t) => {
  const { root, request } = await setup(t);
  // Finder writes NFD; keyboards and paste usually produce NFC.
  await fs.writeFile(path.join(root, 'café-plan.md'), 'fixture');
  const composed = await request('café');
  assert.equal(composed.result.documents.length, 1, 'NFC query should match an NFD filename');
  const decomposed = await request('café');
  assert.equal(decomposed.result.documents.length, 1);
  assert.deepEqual(composed.audit.reads, []);
});
