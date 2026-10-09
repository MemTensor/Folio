/** @typedef {import('./document-state.mjs').DocumentState} DocumentState */

/** @param {Record<string,DocumentState>} documents @param {string} active @param {number} epoch */
export function installSnapshot(documents, active, epoch) {
  return {
    active,
    epoch,
    documents: Object.keys(documents)
      .sort()
      .map((path) => {
        const d = documents[path];
        return {
          path,
          content: d.content,
          base: d.file.content,
          hash: d.file.hash,
          revision: d.revision,
          pending: d.pending === null ? 'deleted' : d.pending === undefined ? 'none' : 'changed',
          remote: d.pending?.content,
          remoteHash: d.pending?.hash,
          restorePending: !!d.restorePending,
          saving: !!d.saving,
        };
      }),
  };
}

/** @param {ReturnType<typeof installSnapshot>} before @param {ReturnType<typeof installSnapshot>} after */
export function sameInstallSnapshot(before, after) {
  if (
    before.epoch !== after.epoch ||
    before.active !== after.active ||
    before.documents.length !== after.documents.length
  )
    return false;
  return before.documents.every((doc, index) =>
    Object.keys(doc).every((key) => doc[key] === after.documents[index][key]),
  );
}

/**
 * A completed preparation remains frozen until the application exits. Failures
 * invalidate their own request and return editing control to the same window.
 * @param {{freeze:()=>void,thaw:()=>Promise<void>,snapshot:()=>ReturnType<typeof installSnapshot>,invalidated:()=>boolean,begin:()=>Promise<{requestId:string}>,waitDrafts:()=>Promise<void>,flush:()=>Promise<void>,commit:(requestId:string)=>Promise<unknown>,abort:(requestId:string)=>Promise<unknown>}} options
 */
export async function prepareUpdateInstall(options) {
  let requestId;
  /** @type {ReturnType<typeof installSnapshot>} */ let before;
  const verify = () => {
    if (options.invalidated() || !sameInstallSnapshot(before, options.snapshot()))
      throw Error('准备更新时文档发生变化，请检查最新内容后重试。');
  };
  try {
    options.freeze();
    before = options.snapshot();
    const request = await options.begin();
    requestId = request.requestId;
    if (typeof requestId !== 'string' || !requestId) throw Error('无法开始更新，请重新检查更新。');
    verify();
    await options.waitDrafts();
    verify();
    await options.flush();
    verify();
    await options.commit(requestId);
    return { requestId };
  } catch (error) {
    if (requestId) await options.abort(requestId).catch(() => {});
    await options.thaw();
    throw error;
  }
}

/** @param {{loading:boolean,richEditing:boolean,composing:boolean,restoring:boolean,removing:boolean,actions:number,writes:number,documents:Record<string,DocumentState>}} state */
export function updateInstallBlocker(state) {
  if (state.loading) return '文档仍在打开中，请稍后再更新。';
  if (state.richEditing) return '请先应用或关闭表格、公式或图表编辑器，再更新。';
  if (state.composing) return '请先完成当前输入，再更新。';
  if (
    state.restoring ||
    state.removing ||
    state.actions ||
    state.writes ||
    Object.values(state.documents).some((d) => d.saving)
  )
    return '正在完成当前操作，请稍后再更新。';
  if (Object.values(state.documents).some((d) => d.pending === null))
    return '有文件已从磁盘移除，请先另存或重新创建，再更新。';
  return '';
}
