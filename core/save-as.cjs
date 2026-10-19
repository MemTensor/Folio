// A completed disk write remains a success if opening the destination fails.
async function saveAsDocument(store, input, openWorkspace) {
  let previous = null;
  try {
    previous = await store.read(input.path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = await store.save({ ...input, expectedHash: previous?.hash ?? null });
  if (!result.ok) throw Error('目标文件在另存为期间被修改，请重试。');
  try {
    const info = await openWorkspace(result.file.path);
    return { ...result.file, workspaceRoot: info.root };
  } catch {
    return { ...result.file, openWarning: true };
  }
}
module.exports = { saveAsDocument };
