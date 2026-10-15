/** @typedef {import('./types').FileSnapshot} FileSnapshot */
/** @typedef {{file:FileSnapshot,content:string,revision:number,pending?:FileSnapshot|null,restorePending?:boolean,saving?:boolean,review?:{before:string,after:string,time:number}}} DocumentState */

/** @param {DocumentState} doc */
export const isChanged = (doc) => doc.content !== doc.file.content;

/** Acknowledging our own write must not discard a newer external revision.
 * @param {DocumentState} doc @param {FileSnapshot} file @param {number} revision @param {boolean} recreate
 */
export function acknowledgeSave(doc, file, revision, recreate = false) {
  return {
    ...doc,
    file,
    saving: false,
    pending:
      doc.pending?.hash === file.hash || (recreate && doc.pending === null)
        ? undefined
        : doc.pending,
    restorePending: doc.revision === revision ? false : doc.restorePending,
  };
}

/** @param {DocumentState} doc */
export function documentDraft(doc) {
  return isChanged(doc) || doc.pending !== undefined || doc.restorePending
    ? { content: doc.content, base: doc.file, restorePending: !!doc.restorePending }
    : null;
}

/** @param {DocumentState} doc @param {boolean} enabled */
export const canAutoSave = (doc, enabled) =>
  enabled && !doc.restorePending && doc.pending === undefined;

/** @param {DocumentState} doc @param {string} content */
export function restoreHistory(doc, content) {
  return { ...doc, content, revision: doc.revision + 1, restorePending: true };
}

/**
 * The outgoing editor content must have its own history entry before replacing
 * the recovery draft. A delayed checkpoint never authorizes a newer document.
 * @param {{path:string,doc:DocumentState}} before
 * @param {string} content
 * @param {(path:string,content:string)=>Promise<unknown>} checkpoint
 * @param {()=>{path:string,doc?:DocumentState}} current
 */
export async function checkpointHistoryRestore(before, content, checkpoint, current) {
  return restoreHistory(await checkpointDocumentTransition(before, checkpoint, current), content);
}

/** @param {FileSnapshot|null|undefined} a @param {FileSnapshot|null|undefined} b */
const sameFileVersion = (a, b) =>
  a === b || !!(a && b && a.path === b.path && a.hash === b.hash && a.content === b.content);

/** @param {{path:string,doc:DocumentState}} before @param {{path:string,doc?:DocumentState}} latest */
export function sameDocumentVersion(before, latest) {
  const a = before.doc,
    b = latest.doc;
  return (
    latest.path === before.path &&
    !!b &&
    !b.saving &&
    a.revision === b.revision &&
    a.content === b.content &&
    sameFileVersion(a.file, b.file) &&
    sameFileVersion(a.pending, b.pending) &&
    !!a.restorePending === !!b.restorePending &&
    a.review?.before === b.review?.before &&
    a.review?.after === b.review?.after
  );
}

/**
 * @param {{path:string,doc:DocumentState}} before
 * @param {(path:string,content:string)=>Promise<unknown>} checkpoint
 * @param {()=>{path:string,doc?:DocumentState}} current
 */
export async function checkpointDocumentTransition(before, checkpoint, current) {
  const validate = () => {
    const latest = current();
    if (!sameDocumentVersion(before, latest))
      throw Error('文档已变化，本次操作尚未应用，请重新审阅。');
    return /** @type {DocumentState} */ (latest.doc);
  };
  validate();
  await checkpoint(before.path, before.doc.content);
  return validate();
}

/** @param {string} path @param {DocumentState|undefined} doc */
export function mergeInput(path, doc) {
  return doc?.pending
    ? {
        path,
        base: doc.file.content,
        baseHash: doc.file.hash,
        local: doc.content,
        remote: doc.pending.content,
        remoteHash: doc.pending.hash,
      }
    : null;
}
/** @typedef {ReturnType<typeof mergeInput>} MergeInput */
/** @param {MergeInput} a @param {MergeInput} b */
export function sameMergeInput(a, b) {
  return (
    !!a &&
    !!b &&
    a.path === b.path &&
    a.base === b.base &&
    a.baseHash === b.baseHash &&
    a.local === b.local &&
    a.remote === b.remote &&
    a.remoteHash === b.remoteHash
  );
}
/** @param {{input:MergeInput,values:Record<number,'local'|'remote'>}} choices @param {MergeInput} input */
export function choicesForInput(choices, input) {
  return sameMergeInput(choices.input, input) ? choices.values : {};
}

/** @param {FileSnapshot} file @param {import('./types').Draft|null} draft */
export function restoredDocument(file, draft) {
  /** @type {DocumentState} */
  const doc = { file, content: file.content, revision: 0 };
  if (draft && (draft.content !== file.content || draft.restorePending)) {
    doc.content = draft.content;
    doc.file = draft.base;
    doc.restorePending = !!draft.restorePending;
    if (draft.base.hash !== file.hash) doc.pending = file;
  }
  return doc;
}

/**
 * File deletion has no snapshot. Compare hashes only after checking that a
 * snapshot exists, so two missing optional hashes cannot hide a deletion.
 * @param {DocumentState} doc
 * @param {import('./types').FileEvent} event
 * @param {{reviewExternal:boolean,richEditing:boolean}} options
 */
export function receiveExternal(doc, event, options) {
  if (event.error) return { kind: 'error', doc, error: event.error };
  const remote = event.deleted ? undefined : event.file;
  if (!remote) {
    if (!event.deleted || doc.pending === null) return { kind: 'ignore', doc };
    return {
      kind: 'pending',
      doc: { ...doc, pending: null },
      cancelSave: true,
      flushDraft: true,
      notice: '文件已从磁盘移除，你的内容仍然保留。',
    };
  }
  if (
    (doc.pending === undefined && remote.hash === doc.file.hash) ||
    remote.hash === doc.pending?.hash
  )
    return { kind: 'ignore', doc };
  if (remote.content === doc.content)
    return { kind: 'ack', doc: { ...doc, file: remote, pending: undefined }, flushDraft: true };
  if (remote.content === doc.file.content)
    return {
      kind: 'metadata',
      doc: { ...doc, file: remote, pending: undefined },
      flushDraft: doc.pending !== undefined,
    };
  if (isChanged(doc) || doc.restorePending || options.reviewExternal || options.richEditing)
    return {
      kind: 'pending',
      doc: { ...doc, pending: remote },
      cancelSave: true,
      flushDraft: true,
      notice: '外部修改等待审阅，你的草稿已保留。',
    };
  return {
    kind: 'replace',
    doc: {
      ...doc,
      file: remote,
      content: remote.content,
      revision: doc.revision + 1,
      review: { before: doc.file.content, after: remote.content, time: Date.now() },
    },
    cancelSave: true,
    notice: '已同步外部修改，可在「改动」中审阅。',
  };
}

/** @param {{path:string,content:string,revision:number}} doc @param {{from:number,to:number,raw:string,kind?:'table'|'math'|'diagram'}} range */
export function beginRichEdit(doc, range) {
  if (
    range.from < 0 ||
    range.to < range.from ||
    range.to > doc.content.length ||
    doc.content.slice(range.from, range.to) !== range.raw
  )
    throw Error('文档内容已变化，请重新打开编辑器。');
  return { ...range, path: doc.path, content: doc.content, revision: doc.revision };
}

/** @param {ReturnType<typeof beginRichEdit>} session @param {{path:string,content:string,revision:number}} doc @param {string} replacement */
export function richEditChange(session, doc, replacement) {
  if (
    doc.path !== session.path ||
    doc.revision !== session.revision ||
    doc.content !== session.content ||
    doc.content.slice(session.from, session.to) !== session.raw
  )
    throw Error('文档内容已变化，本次编辑尚未应用。请复制编辑内容，关闭后重新打开编辑器。');
  return {
    from: session.from,
    to: session.to,
    insert: (session.raw ? '' : '\n') + replacement + (session.raw ? '' : '\n'),
  };
}

/** @param {boolean} richEditing @param {string} command */
export function blocksRichCommand(richEditing, command) {
  return richEditing;
}
