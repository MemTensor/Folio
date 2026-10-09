import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createBridgeActivity, wrapBridgeActivity } from '../src/bridge-activity.mjs';

test('the actual desktop bridge module boots with a frozen contextBridge API', async () => {
  const sourceURL = new URL('../src/bridge.ts', import.meta.url),
    require = createRequire(sourceURL);
  const calls = [];
  const desktop = Object.freeze({
    desktop: true,
    bootstrap: async () => {
      calls.push('bootstrap');
      return { root: '/generated' };
    },
    save: async (input) => {
      calls.push('save');
      return { ok: true, file: input };
    },
    putDraft: async () => {
      calls.push('putDraft');
    },
    onUpdate: (callback) => {
      calls.push('onUpdate');
      callback({ phase: 'idle' });
      return () => calls.push('unsubscribe');
    },
  });
  const descriptors = Object.getOwnPropertyDescriptors(desktop);
  const compiled = ts.transpileModule(fs.readFileSync(sourceURL, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const context = {
    exports: {},
    window: { folio: desktop },
    localStorage: { getItem: () => null, setItem: () => {} },
    require: (id) => (id.endsWith('.md?raw') ? 'generated example' : require(id)),
  };
  vm.runInNewContext(compiled, context, { filename: 'src/bridge.ts' });
  const bridge = context.exports.bridge;
  assert.equal(bridge.desktop, true);
  assert.equal((await bridge.bootstrap()).root, '/generated');
  assert.equal((await bridge.save({ path: '/generated/note.md', content: 'test' })).ok, true);
  await bridge.putDraft('/generated/note.md', { content: 'draft' });
  let state;
  const off = bridge.onUpdate((value) => {
    state = value;
  });
  assert.equal(state.phase, 'idle');
  off();
  assert.deepEqual(calls, ['bootstrap', 'save', 'putDraft', 'onUpdate', 'unsubscribe']);
  assert.deepEqual(Object.getOwnPropertyDescriptors(desktop), descriptors);
});

for (const kind of ['frozen contextBridge object', 'non-enumerable non-configurable methods']) {
  test(`desktop bridge facade invokes bootstrap, save, drafts and subscription on ${kind}`, async () => {
    const calls = [],
      listeners = new Set();
    let source;
    const methods = {
      async bootstrap() {
        assert.equal(this, source);
        calls.push('bootstrap');
        return { root: '/generated' };
      },
      async save(input) {
        assert.equal(this, source);
        calls.push(['save', input]);
        return { ok: true, file: input };
      },
      async putDraft(path, draft) {
        assert.equal(this, source);
        calls.push(['draft', path, draft]);
      },
      onUpdate(callback) {
        assert.equal(this, source);
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };
    if (kind === 'frozen contextBridge object')
      source = Object.freeze({ desktop: true, ...methods });
    else {
      source = { desktop: true };
      for (const [key, value] of Object.entries(methods))
        Object.defineProperty(source, key, {
          value,
          writable: false,
          configurable: false,
          enumerable: false,
        });
      Object.preventExtensions(source);
    }
    const original = Object.getOwnPropertyDescriptors(source),
      activity = createBridgeActivity();
    const bridge = wrapBridgeActivity(source, activity, new Set(['bootstrap', 'save']));
    assert.notEqual(bridge, source);
    assert.equal(bridge.desktop, true);
    const opening = bridge.bootstrap();
    assert.equal(activity.pendingWrites(), 1);
    assert.deepEqual(await opening, { root: '/generated' });
    assert.equal(activity.pendingWrites(), 0);
    const input = { path: '/generated/note.md', content: 'generated test text' };
    assert.deepEqual(await bridge.save(input), { ok: true, file: input });
    const draft = { content: 'unsaved generated text', restorePending: true };
    const savingDraft = bridge.putDraft(input.path, draft);
    assert.equal(activity.pendingDrafts(), 1);
    await savingDraft;
    assert.equal(activity.pendingDrafts(), 0);
    const observed = [];
    const off = bridge.onUpdate((state) => observed.push(state));
    assert.equal(typeof off, 'function');
    for (const listener of listeners) listener({ phase: 'ready' });
    off();
    assert.deepEqual(observed, [{ phase: 'ready' }]);
    assert.equal(listeners.size, 0);
    assert.deepEqual(Object.getOwnPropertyDescriptors(source), original);
    assert.equal(source.bootstrap, methods.bootstrap);
    assert.equal(source.save, methods.save);
    assert.equal(source.putDraft, methods.putDraft);
    assert.equal(source.onUpdate, methods.onUpdate);
    assert.deepEqual(calls, ['bootstrap', ['save', input], ['draft', input.path, draft]]);
  });
}

test('a frozen desktop facade retains the update write barrier without mutating its source', async () => {
  let saves = 0,
    drafts = 0;
  const source = Object.freeze({
    save: async () => {
      saves++;
    },
    putDraft: async () => {
      drafts++;
    },
  });
  const activity = createBridgeActivity(),
    bridge = wrapBridgeActivity(source, activity, new Set(['save']));
  activity.setFrozen(true);
  await assert.rejects(() => bridge.save(), /准备更新/);
  await bridge.putDraft('/generated/a.md', { content: 'draft' });
  assert.equal(saves, 0);
  assert.equal(drafts, 1);
  activity.setFrozen(false);
  await bridge.save();
  assert.equal(saves, 1);
  assert(Object.isFrozen(source));
});
