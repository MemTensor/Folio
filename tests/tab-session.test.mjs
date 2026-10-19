import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readTabSession,
  writeTabSession,
  startupTabs,
  restoreTabsPreference,
  needsClosePrompt,
} from '../src/tab-session.mjs';

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('tab sessions distinguish a fresh installation from closing every tab', () => {
  const state = storage();
  assert.equal(readTabSession(state), null);
  writeTabSession(state, [], '', true);
  assert.deepEqual(startupTabs(readTabSession(state), 'always'), []);
  assert.notEqual(readTabSession(state), null);
  writeTabSession(state, ['/fixture/a.md'], '/fixture/a.md', false);
  assert.deepEqual(readTabSession(state), {
    paths: [],
    active: '',
    restore: false,
    resumeOnce: false,
  });
});

test('restore keeps every tab in order and the active tab, including more than 30 tabs', () => {
  const state = storage();
  const paths = Array.from({ length: 64 }, (_, i) => `/fixture/project-${i}/note.md`);
  writeTabSession(state, paths, paths[3], true);
  assert.deepEqual(startupTabs(readTabSession(state), 'always'), paths);
  assert.equal(readTabSession(state).active, paths[3]);
  assert.deepEqual(startupTabs(readTabSession(state), 'ask'), paths);
  assert.deepEqual(startupTabs(readTabSession(state), 'never'), []);
});

test('update restart resumes tabs once even when ordinary startup restore is off', () => {
  const state = storage();
  writeTabSession(state, ['/fixture/a.md'], '/fixture/a.md', true, true);
  assert.deepEqual(startupTabs(readTabSession(state), 'never'), ['/fixture/a.md']);
  // The renderer checkpoints the ordinary policy after boot, or after an aborted update.
  writeTabSession(state, ['/fixture/a.md'], '/fixture/a.md', false);
  assert.deepEqual(startupTabs(readTabSession(state), 'never'), []);
});

test('legacy tabs migrate and malformed state cannot block explicit document opening', () => {
  const state = storage({
    'folio-open-tabs': JSON.stringify([
      '/fixture/a.md',
      '/fixture/a.md',
      null,
      'https://example.com',
    ]),
  });
  assert.deepEqual(readTabSession(state).paths, ['/fixture/a.md']);
  writeTabSession(state, ['/fixture/a.md'], '/fixture/missing.md', true);
  assert.equal(state.getItem('folio-open-tabs'), null);
  assert.equal(readTabSession(state).active, '');
  for (const value of ['{', 'null', '[]', '{"version":2,"paths":[]}']) {
    assert.equal(readTabSession(storage({ 'folio-tab-session': value })), null);
  }
});

test('unsaved work always prompts, while remembered choices skip clean close dialogs', () => {
  assert.equal(restoreTabsPreference(undefined), 'ask');
  assert.equal(restoreTabsPreference('bad'), 'ask');
  for (const preference of ['always', 'never', 'ask']) {
    assert.equal(needsClosePrompt(preference, 2, true), true);
    assert.equal(needsClosePrompt(preference, 0, false), false);
  }
  assert.equal(needsClosePrompt('ask', 2, false), true);
  assert.equal(needsClosePrompt('always', 2, false), false);
  assert.equal(needsClosePrompt('never', 2, false), false);
});

// Exercise the actual close coordinator with delayed or failing persistence.
// No Electron window, local document, or real application state is involved.
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const appSource = ts.createSourceFile(
  'App.tsx',
  fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const functions = [];
function collect(node) {
  if (
    ts.isFunctionDeclaration(node) &&
    ['closeSession', 'hasUnsavedDocuments'].includes(node.name?.text)
  )
    functions.push(node.getText(appSource));
  ts.forEachChild(node, collect);
}
collect(appSource);
const closeCode = ts.transpileModule(functions.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function closeFixture() {
  const events = [],
    state = storage();
  const doc = { file: { content: 'base' }, content: 'unsaved' };
  const context = {
    closing: { current: false },
    restoringHistory: { current: false },
    activeActions: { current: 1 },
    bridgeActivity: {
      pendingWrites: () => 0,
      waitDrafts: async () => {
        events.push('drain');
      },
    },
    docsRef: { current: { '/fixture/a.md': doc } },
    activeRef: { current: '/fixture/a.md' },
    documentEpoch: { current: 0 },
    prefRef: { current: { restoreTabs: 'ask' } },
    editor: { current: { lock: (value) => events.push(value ? 'lock' : 'unlock') } },
    timers: { current: new Map() },
    draftTimers: { current: new Map() },
    queuedCloseFiles: { current: new Map() },
    setClosingWindow: () => {},
    setModal: () => {},
    setPrefs: () => {},
    notify: (message) => events.push(message),
    t: (message) => message,
    clearTimeout,
    writeTabSession,
    localStorage: state,
    changed: (d) => d.content !== d.file.content,
    documentDraft: (d) => (d.content !== d.file.content ? d : null),
    flushAll: async () => {
      events.push('flush');
    },
    save: async () => {
      events.push('save');
      doc.file.content = doc.content;
    },
    bridge: {
      close: async () => {
        events.push('close');
      },
    },
    external: async () => {},
    schedule: () => {},
  };
  vm.createContext(context);
  vm.runInContext(closeCode, context);
  return { context, events, state, doc, close: (...args) => context.closeSession(...args) };
}

test('closing drains draft writes before snapshot and remembers only after durable drafts', async () => {
  const f = closeFixture();
  await f.close(false, false, true);
  assert.deepEqual(f.events, ['lock', 'drain', 'flush', 'close']);
  assert.equal(f.context.closing.current, true);
  assert.equal(JSON.parse(f.state.getItem('folio-preferences')).restoreTabs, 'never');
  assert.deepEqual(readTabSession(f.state).paths, []);
  assert.equal(f.doc.content, 'unsaved');
});

test('draft failures, concurrent edits, and native close failures retain documents and policy', async () => {
  for (const failure of ['draft', 'mutation', 'native']) {
    const f = closeFixture();
    if (failure === 'draft')
      f.context.flushAll = async () => {
        throw Error('disk full');
      };
    if (failure === 'mutation')
      f.context.flushAll = async () => {
        f.context.documentEpoch.current++;
      };
    if (failure === 'native')
      f.context.bridge.close = async () => {
        throw Error('native failure');
      };
    await assert.rejects(() => f.close(false, false, true));
    assert.equal(f.context.closing.current, false);
    assert.equal(f.events.at(-1), 'unlock');
    assert.equal(f.context.prefRef.current.restoreTabs, 'ask');
    assert.equal(f.doc.content, 'unsaved');
    assert.deepEqual(readTabSession(f.state).paths, ['/fixture/a.md']);
  }
});

test('save and close honors conflicts, saving failures and unconfirmed restored drafts', async () => {
  for (const pending of [null, { content: 'external' }, undefined]) {
    const f = closeFixture();
    f.doc.pending = pending;
    f.doc.restorePending = pending === undefined;
    f.context.save = async () => {};
    await f.close(true, true, true);
    assert(!f.events.includes('close'));
    assert.equal(f.context.closing.current, false);
    assert.equal(f.context.prefRef.current.restoreTabs, 'ask');
    assert.equal(f.doc.content, 'unsaved');
  }
});

test('a successful save closes only after the draft flush completes', async () => {
  const f = closeFixture();
  await f.close(true, true, false);
  assert.deepEqual(f.events, ['lock', 'save', 'drain', 'flush', 'close']);
  assert.equal(f.doc.file.content, 'unsaved');
});

test('native window close consults the renderer for clean tabs, while confirmed and update quits proceed', () => {
  const main = ts.createSourceFile(
    'main.cjs',
    fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let handler;
  function find(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(main) === 'win.on' &&
      node.arguments[0]?.text === 'close'
    )
      handler = node.arguments[1].getText(main);
    ts.forEachChild(node, find);
  }
  find(main);
  assert(handler);
  for (const [ready, dirty, allowed, updating, authorized, expected] of [
    [true, false, false, false, false, ['prevent', 'close-request']],
    [false, true, false, false, false, ['prevent', 'close-request']],
    [false, false, false, false, false, []],
    [true, true, true, false, false, []],
    [true, true, true, true, true, []],
    [true, false, false, true, false, ['prevent', 'notice']],
  ]) {
    const events = [];
    const callback = vm.runInNewContext(`(${handler})`, {
      rendererReady: ready,
      dirty,
      allowClose: allowed,
      updateQuitAuthorized: authorized,
      updateGate: { activeTicket: () => updating },
      command: (id) => events.push(id),
      send: (type) => events.push(type),
    });
    callback({ preventDefault: () => events.push('prevent') });
    assert.deepEqual(events, expected);
  }
});
