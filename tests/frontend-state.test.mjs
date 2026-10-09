import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import tasks from 'markdown-it-task-lists';
import { imageURL } from '../src/image-url.mjs';
import { annotateTaskMarkers, taskToggleChange } from '../src/task-markers.mjs';
import {
  documentDraft,
  canAutoSave,
  restoreHistory,
  checkpointHistoryRestore,
  checkpointDocumentTransition,
  mergeInput,
  choicesForInput,
  restoredDocument,
  receiveExternal,
  beginRichEdit,
  richEditChange,
  blocksRichCommand,
} from '../src/document-state.mjs';

const file = {
  path: '/generated/note.md',
  content: 'disk version',
  hash: 'disk-hash',
  eol: 'LF',
  bom: false,
};
const document = () => ({ file: { ...file }, content: file.content, revision: 0 });
const options = { reviewExternal: false, richEditing: false };
const md = new MarkdownIt({ html: true }).use(tasks, { enabled: true, label: true });
md.core.ruler.after('github-task-lists', 'folio-task-markers', annotateTaskMarkers);
const markers = (content) =>
  md
    .parse(content, {})
    .flatMap((token) => token.children || [])
    .filter((token) => token.type === 'folio_task_checkbox')
    .map((token) => token.meta);
const apply = (content, change) =>
  content.slice(0, change.from) + change.insert + content.slice(change.to);

test('malformed UTF-8 image URLs become placeholders without losing valid percent filenames', () => {
  for (const input of ['%FF.png', '%E0%A4.png']) {
    const token = md
      .parse(`![bad](${input})`, {})
      .find((t) => t.type === 'inline')
      .children.find((t) => t.type === 'image');
    assert.equal(imageURL(token.attrGet('src'), { path: file.path }), '');
  }
  for (const input of ['100%.png', 'foo%GG.png', 'valid%20name.png']) {
    const token = md
      .parse(`![ok](${input})`, {})
      .find((t) => t.type === 'inline')
      .children.find((t) => t.type === 'image');
    const result = imageURL(token.attrGet('src'), { path: file.path });
    assert(result.startsWith('folio-asset:'));
  }
  assert.equal(imageURL('%', { path: file.path }), '');
  const local = imageURL('figure.png', { path: '/100% results/note.md' });
  assert.equal(new URL(local).searchParams.get('path'), '/100% results/figure.png');
  assert.equal(imageURL('https://example.invalid/image.png', { path: file.path }), '');
  assert.equal(imageURL('javascript:alert(1)', { path: file.path }), '');
});

test('deletion of clean, dirty, or already conflicted documents preserves content and creates a draft', () => {
  for (const original of [
    document(),
    { ...document(), content: 'human draft' },
    { ...document(), pending: { ...file, hash: 'remote', content: 'remote' } },
  ]) {
    const result = receiveExternal(original, { path: file.path, deleted: true }, options);
    assert.equal(result.kind, 'pending');
    assert.equal(result.doc.pending, null);
    assert.equal(result.doc.content, original.content);
    assert.equal(result.cancelSave, true);
    assert.equal(result.flushDraft, true);
    assert.equal(documentDraft(result.doc).content, original.content);
    assert.equal(canAutoSave(result.doc, true), false);
    assert.equal(
      receiveExternal(result.doc, { path: file.path, deleted: true }, options).kind,
      'ignore',
    );
  }
});

test('normal external updates still sync, while active rich edits remain queued for review', () => {
  const event = {
    path: file.path,
    file: { ...file, content: 'agent version', hash: 'agent-hash' },
  };
  const clean = receiveExternal(document(), event, options);
  assert.equal(clean.kind, 'replace');
  assert.equal(clean.doc.content, 'agent version');
  const editing = receiveExternal(document(), event, { ...options, richEditing: true });
  assert.equal(editing.kind, 'pending');
  assert.equal(editing.doc.content, 'disk version');
  const ack = receiveExternal({ ...document(), content: 'agent version' }, event, options);
  assert.equal(ack.kind, 'ack');
  assert.equal(ack.doc.file.hash, 'agent-hash');
  assert.equal(receiveExternal(document(), { path: file.path }, options).kind, 'ignore');
});

test('recreated files clear deletion state even at the original hash and retain unsaved human text', () => {
  for (const content of [file.content, 'unsaved human text']) {
    const deleted = { ...document(), content, pending: null };
    const result = receiveExternal(deleted, { path: file.path, file: { ...file } }, options);
    assert.notEqual(result.kind, 'ignore');
    assert.equal(result.doc.pending, undefined);
    assert.equal(result.doc.content, content);
    assert.equal(result.doc.file.hash, file.hash);
    assert.equal(result.flushDraft, true);
    if (content !== file.content) assert.equal(documentDraft(result.doc).content, content);
    else assert.equal(documentDraft(result.doc), null);
  }
});

test('history restoration checkpoints the outgoing unsaved draft before producing replacement state', async () => {
  const before = { path: file.path, doc: { ...document(), content: 'only unsaved copy' } },
    checkpoints = [];
  const result = await checkpointHistoryRestore(
    before,
    'older content',
    async (path, content) => {
      checkpoints.push({ path, content });
    },
    () => before,
  );
  assert.deepEqual(checkpoints, [{ path: file.path, content: 'only unsaved copy' }]);
  assert.equal(result.content, 'older content');
  assert.equal(documentDraft(result).restorePending, true);
  await assert.rejects(
    () =>
      checkpointHistoryRestore(
        before,
        'older content',
        async () => {
          throw Error('disk full');
        },
        () => before,
      ),
    /disk full/,
  );
  assert.equal(before.doc.content, 'only unsaved copy');
});

test('a delayed history checkpoint never overwrites edits, navigation, or external revisions arriving during it', async () => {
  const before = { path: file.path, doc: { ...document(), content: 'initial draft' } };
  for (const latest of [
    { ...before, doc: { ...before.doc, content: 'typed during checkpoint' } },
    { ...before, path: '/generated/other.md' },
    { ...before, doc: { ...before.doc, revision: 1 } },
    { ...before, doc: { ...before.doc, file: { ...file, hash: 'new' } } },
    { ...before, doc: { ...before.doc, pending: null } },
  ]) {
    let current = before;
    await assert.rejects(
      () =>
        checkpointHistoryRestore(
          before,
          'old',
          async () => {
            await Promise.resolve();
            current = latest;
          },
          () => current,
        ),
      /文档已变化/,
    );
    assert.equal(current, latest);
  }
});

test('conflict choices expire immediately when any merge input changes, including whole-document fallback', () => {
  const original = {
    ...document(),
    content: 'small local edit',
    pending: { ...file, hash: 'remote', content: 'small remote edit' },
  };
  const input = mergeInput(file.path, original),
    choices = { input, values: { 0: 'local' } };
  assert.deepEqual(choicesForInput(choices, input), { 0: 'local' });
  for (const changed of [
    { ...original, content: 'whole document rewrite\n'.repeat(20000) },
    { ...original, pending: { ...original.pending, content: 'new remote edit' } },
    { ...original, pending: { ...original.pending, hash: 'new hash' } },
    { ...original, file: { ...file, content: 'different base' } },
  ]) {
    assert.deepEqual(choicesForInput(choices, mergeInput(file.path, changed)), {});
  }
  assert.deepEqual(choicesForInput(choices, mergeInput('/generated/other.md', original)), {});
  assert.deepEqual(choicesForInput(choices, null), {});
});

test('review and hunk-revert checkpoints reject changes that arrive while awaiting history writes', async () => {
  for (const before of [
    {
      path: file.path,
      doc: {
        ...document(),
        content: 'local',
        pending: { ...file, hash: 'remote', content: 'remote' },
      },
    },
    {
      path: file.path,
      doc: { ...document(), review: { before: 'old', after: file.content, time: 1 } },
    },
  ]) {
    for (const change of [
      (doc) => ({ ...doc, content: 'typing during checkpoint' }),
      (doc) => ({ ...doc, pending: { ...file, hash: 'new remote', content: 'new remote' } }),
      (doc) => ({ ...doc, review: undefined, revision: doc.revision + 1 }),
    ]) {
      let latest = before;
      await assert.rejects(
        () =>
          checkpointDocumentTransition(
            before,
            async () => {
              await Promise.resolve();
              latest = { ...before, doc: change(before.doc) };
            },
            () => latest,
          ),
        /文档已变化/,
      );
      assert.notEqual(latest.doc, before.doc);
    }
  }
});

test('restoring history pauses only its document, persists through draft reopening, and keeps external conflict protection', () => {
  const preferences = { autoSave: true };
  const a = restoreHistory(document(), 'historical content'),
    b = { ...document(), content: 'other draft' };
  assert.equal(canAutoSave(a, preferences.autoSave), false);
  assert.equal(canAutoSave(b, preferences.autoSave), true);
  assert.equal(preferences.autoSave, true);
  const persisted = JSON.parse(JSON.stringify(documentDraft(a)));
  assert.equal(persisted.restorePending, true);
  const reopened = restoredDocument(file, persisted);
  assert.equal(reopened.content, 'historical content');
  assert.equal(reopened.restorePending, true);
  assert.equal(canAutoSave(reopened, true), false);
  const changedDisk = { ...file, hash: 'new-hash', content: 'new disk version' };
  assert.equal(restoredDocument(changedDisk, persisted).pending.hash, 'new-hash');
  const confirmed = {
    ...reopened,
    file: { ...file, content: reopened.content },
    restorePending: false,
  };
  assert.equal(documentDraft(confirmed), null);
  assert.equal(canAutoSave(confirmed, true), true);
});

test('even a restored snapshot identical to disk keeps its explicit confirmation across reopening', () => {
  const restored = restoreHistory(document(), file.content);
  const draft = documentDraft(restored);
  assert(draft);
  assert.equal(restoredDocument(file, draft).restorePending, true);
});

test('rich edits reject stale positions, another document, and a replaced document version', () => {
  const content = 'Intro paragraph.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nTail paragraph.';
  const state = { path: file.path, content, revision: 1 },
    from = content.indexOf('| A'),
    to = content.indexOf('\n\nTail');
  const session = beginRichEdit(state, { from, to, raw: content.slice(from, to), kind: 'table' });
  const replacement = '| A | B |\n| --- | --- |\n| 3 | 4 |';
  assert.equal(
    apply(content, richEditChange(session, state, replacement)),
    content.slice(0, from) + replacement + content.slice(to),
  );
  assert.throws(
    () => richEditChange(session, { ...state, content: '**文字**' + content }, replacement),
    /文档内容已变化/,
  );
  assert.throws(
    () => richEditChange(session, { ...state, path: '/generated/other.md' }, replacement),
    /文档内容已变化/,
  );
  assert.throws(
    () => richEditChange(session, { ...state, revision: 2 }, replacement),
    /文档内容已变化/,
  );
  assert.throws(() => beginRichEdit(state, { from, to, raw: 'outdated table' }), /文档内容已变化/);
  for (const kind of ['math', 'diagram']) {
    const edit = beginRichEdit(state, { from: 0, to: 0, raw: '', kind });
    assert.throws(
      () => richEditChange(edit, { ...state, content: 'new' }, '$$x$$'),
      /文档内容已变化/,
    );
  }
});

test('all document keyboard and menu commands are blocked while a rich editor owns its draft', () => {
  for (const command of [
    'bold',
    'italic',
    'link',
    'heading-1',
    'source',
    'save',
    'save-as',
    'open',
    'close-request',
  ]) {
    assert.equal(blocksRichCommand(true, command), true);
    assert.equal(blocksRichCommand(false, command), false);
  }
});

test('ordered, quoted, nested, and spaced task lists map each checkbox to its actual source marker', () => {
  for (const raw of [
    '1. [ ] first\n2. [x] second',
    '> - [ ] first\n> - [x] second',
    '-  [ ] first\n- [x] second',
    '- parent\n  - [ ] first\n  - [x] second',
  ]) {
    const items = markers(raw);
    assert.equal(items.length, 2, raw);
    for (let i = 0; i < items.length; i++) {
      const result = apply(raw, taskToggleChange(raw, items[i].offset));
      assert.equal(
        result,
        raw.slice(0, items[i].offset) + (i === 0 ? 'x' : ' ') + raw.slice(items[i].offset + 1),
      );
      assert.equal(items[i].checked, i === 1);
    }
  }
});

test('task-like prose and code never steal the actual checkbox source position', () => {
  for (const raw of [
    '- [ ]not-a-task\n- [ ] real task',
    '- container\n\n  ```text\n  - [ ] example\n  ```\n\n- [ ] real task',
  ]) {
    const items = markers(raw);
    assert.equal(items.length, 1);
    assert.equal(
      apply(raw, taskToggleChange(raw, items[0].offset)),
      raw.replace('- [ ] real task', '- [x] real task'),
    );
  }
  assert.equal(markers('```md\n- [ ] code\n```').length, 0);
  assert.equal(taskToggleChange('- [ ] real', NaN), null);
  assert.equal(taskToggleChange('- [ ] real', 3, 4, 10), null);
  assert.equal(taskToggleChange('- text', 3), null);
});
