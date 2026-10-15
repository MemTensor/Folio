import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { EditorState } from '@codemirror/state';
import { createBridgeActivity } from '../src/bridge-activity.mjs';
import {
  installSnapshot,
  sameInstallSnapshot,
  prepareUpdateInstall,
  updateInstallBlocker,
} from '../src/update-preparation.mjs';

const path = '/generated/update.md';
const file = { path, content: 'saved text', hash: 'base-hash', eol: 'LF', bom: false };
const fixture = () => ({
  [path]: { file: { ...file }, content: 'unsaved text', revision: 0, restorePending: true },
});
function preparation() {
  const state = { documents: fixture(), epoch: 0, invalidated: false, frozen: false };
  const calls = [];
  const options = {
    freeze: () => {
      state.frozen = true;
      calls.push('freeze');
    },
    thaw: async () => {
      state.frozen = false;
      calls.push('thaw');
    },
    snapshot: () => installSnapshot(state.documents, path, state.epoch),
    invalidated: () => state.invalidated,
    begin: async () => {
      calls.push('begin');
      return { requestId: 'request-current' };
    },
    waitDrafts: async () => {
      calls.push('drain-drafts');
    },
    flush: async () => {
      calls.push('flush');
    },
    commit: async (requestId) => {
      calls.push('commit:' + requestId);
    },
    abort: async (requestId) => {
      calls.push('abort:' + requestId);
    },
  };
  return { state, calls, options };
}

test('update commit waits for draft durability and leaves editing locked until exit', async () => {
  const { state, calls, options } = preparation();
  assert.deepEqual(await prepareUpdateInstall(options), { requestId: 'request-current' });
  assert.deepEqual(calls, ['freeze', 'begin', 'drain-drafts', 'flush', 'commit:request-current']);
  assert.equal(state.frozen, true);
  assert.equal(state.documents[path].content, 'unsaved text');
  assert.equal(state.documents[path].restorePending, true);
});

test('a partially failed editor freeze also restores editing without creating an install request', async () => {
  const { state, calls, options } = preparation();
  options.freeze = () => {
    state.frozen = true;
    throw Error('editor became unavailable');
  };
  await assert.rejects(() => prepareUpdateInstall(options), /editor became unavailable/);
  assert.equal(state.frozen, false);
  assert(!calls.includes('begin'));
});

test('new input during a draft flush invalidates install without overwriting the new text', async () => {
  const { state, calls, options } = preparation();
  options.flush = async () => {
    await Promise.resolve();
    state.documents[path] = { ...state.documents[path], content: 'new input' };
    state.epoch++;
  };
  await assert.rejects(() => prepareUpdateInstall(options), /文档发生变化/);
  assert.equal(state.documents[path].content, 'new input');
  assert.equal(state.frozen, false);
  assert(calls.includes('abort:request-current'));
  assert(!calls.some((call) => call.startsWith('commit:')));
});

test('external events invalidate preparation even when the renderer queues them without changing documents', async () => {
  const { state, calls, options } = preparation();
  options.waitDrafts = async () => {
    state.invalidated = true;
  };
  await assert.rejects(() => prepareUpdateInstall(options), /文档发生变化/);
  assert.equal(state.frozen, false);
  assert(!calls.includes('flush'));
  assert(!calls.some((call) => call.startsWith('commit:')));
});

test('failed old or final draft writes abort only this install request and restore editing', async () => {
  for (const step of ['waitDrafts', 'flush']) {
    const { state, calls, options } = preparation();
    options[step] = async () => {
      throw Error('draft disk full');
    };
    await assert.rejects(() => prepareUpdateInstall(options), /draft disk full/);
    assert(calls.includes('abort:request-current'));
    assert.equal(state.frozen, false);
    assert(!calls.some((call) => call.startsWith('commit:')));
  }
});

test('an expired main-process confirmation is never retried with a different request', async () => {
  const { state, calls, options } = preparation();
  options.commit = async (request) => {
    calls.push('rejected:' + request);
    throw Error('request expired');
  };
  options.abort = async (request) => {
    calls.push('aborted:' + request);
    throw Error('already invalidated');
  };
  await assert.rejects(() => prepareUpdateInstall(options), /request expired/);
  assert(calls.includes('rejected:request-current'));
  assert(calls.includes('aborted:request-current'));
  assert.equal(calls.filter((x) => x === 'begin').length, 1);
  assert.equal(state.frozen, false);
});

test('install snapshots cover tab membership, source revisions, conflicts and restore confirmation', () => {
  const original = fixture(),
    before = installSnapshot(original, path, 0);
  for (const documents of [
    {},
    { ...original, other: { ...original[path] } },
    { [path]: { ...original[path], pending: null } },
    { [path]: { ...original[path], file: { ...file, hash: 'new-hash' } } },
    { [path]: { ...original[path], restorePending: false } },
  ])
    assert.equal(sameInstallSnapshot(before, installSnapshot(documents, path, 0)), false);
  assert.equal(sameInstallSnapshot(before, installSnapshot(original, path, 1)), false);
  assert.equal(sameInstallSnapshot(before, installSnapshot(original, 'other', 0)), false);
});

test('missing files and uncommitted editor operations block update; ordinary drafts and conflicts can be preserved', () => {
  const state = {
    loading: false,
    richEditing: false,
    composing: false,
    restoring: false,
    removing: false,
    actions: 0,
    writes: 0,
    documents: fixture(),
  };
  assert.equal(updateInstallBlocker(state), '');
  assert.equal(
    updateInstallBlocker({
      ...state,
      documents: {
        [path]: {
          ...state.documents[path],
          pending: { ...file, hash: 'remote', content: 'agent text' },
        },
      },
    }),
    '',
  );
  for (const field of ['loading', 'richEditing', 'composing', 'restoring', 'removing'])
    assert(updateInstallBlocker({ ...state, [field]: true }));
  for (const field of ['actions', 'writes']) assert(updateInstallBlocker({ ...state, [field]: 1 }));
  assert.match(
    updateInstallBlocker({
      ...state,
      documents: { [path]: { ...state.documents[path], pending: null } },
    }),
    /另存或重新创建/,
  );
  assert(
    updateInstallBlocker({
      ...state,
      documents: { [path]: { ...state.documents[path], saving: true } },
    }),
  );
});

test('bridge activity drains already-issued drafts and rejects new source writes during preparation', async () => {
  const activity = createBridgeActivity(),
    events = [];
  let finish;
  const first = activity.track(
    'draft',
    () =>
      new Promise((resolve) => {
        finish = () => {
          events.push('old');
          resolve();
        };
      }),
  );
  await Promise.resolve();
  activity.setFrozen(true);
  await assert.rejects(() => activity.track('write', () => events.push('forbidden')), /准备更新/);
  assert.equal(activity.pendingDrafts(), 1);
  assert.equal(activity.pendingWrites(), 0);
  finish();
  await activity.waitDrafts();
  await first;
  await activity.track('draft', async () => events.push('latest'));
  assert.deepEqual(events, ['old', 'latest']);
  assert.equal(activity.pendingDrafts(), 0);
  activity.setFrozen(false);
  await activity.track('write', async () => events.push('allowed'));
  assert.equal(events.at(-1), 'allowed');
});

test('actual editor commands respect the synchronous CodeMirror read-only state', () => {
  const require = createRequire(import.meta.url);
  const source = fs.readFileSync(new URL('../src/editor.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const context = {
    exports: {},
    require: (id) =>
      id === './editor-changes.mjs'
        ? require('../src/editor-changes.mjs')
        : id === './markdown' || id === './task-markers.mjs' || id === './reading-copy'
          ? {}
          : id === './i18n'
            ? { t: (message) => message, getLocale: () => 'zh-CN', subscribeLocale: () => () => {} }
            : require(id),
  };
  vm.runInNewContext(output, context);
  const view = {
    state: EditorState.create({ doc: 'original', extensions: EditorState.readOnly.of(true) }),
    dispatch(spec) {
      this.state = this.state.update(spec).state;
    },
    focus() {},
  };
  for (const command of ['bold', 'italic', 'heading-1', 'task'])
    context.exports.runCommand(view, command);
  context.exports.insertText(view, 'should not insert');
  assert.equal(view.state.doc.toString(), 'original');
  view.state = EditorState.create({ doc: 'original' });
  context.exports.insertText(view, 'allowed ');
  assert.equal(view.state.doc.toString(), 'allowed original');
});
