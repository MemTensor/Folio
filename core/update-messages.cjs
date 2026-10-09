const { UpdateError } = require('./update-release.cjs');

// UPDATE_INSTALL is shared by several installer checks. Classify only exact,
// known diagnostics; an unfamiliar failure must not be called a corrupt package.
const PACKAGE_CHECKS = new Set([
  '安装包意外截断。',
  '安装包包含无效路径。',
  '安装包包含越界路径。',
  '安装包只能包含 Folio.app。',
  '安装包包含重复路径。',
  '不支持加密安装包。',
  '安装包包含不支持的文件类型。',
  '安装包文件类型不一致。',
  '安装包大小无效。',
  '安装包解压大小或文件数量超出限制。',
  '安装包符号链接过长。',
  '安装包不能向符号链接目录写入文件。',
  'Folio.app 必须是目录。',
  '安装包包含越界符号链接。',
  '安装包符号链接必须位于 Folio.app 内。',
  '安装包缺少必要文件。',
  '安装包的应用标识或版本不匹配。',
  '安装包架构与当前应用不匹配。',
  '安装包签名信息无效。',
  '安装包大小不匹配。',
  '安装包 SHA256 校验失败。',
  '安装包在解压期间发生变化。',
  '安装包隔离属性无效。',
  '新版应用必须由同一开发者签名。',
  '应用校验清单过大。',
]);
const INSTALL_LOCATIONS = new Set([
  '请先将 Folio 安装到可写的应用程序目录。',
  '更新必须在同一磁盘卷内进行。',
]);
const INSTALL_HELPER = new Set([
  '更新安装助手不可用。',
  '更新助手在复制期间发生变化。',
  '更新助手未能启动。',
  '更新助手校验失败，尚未退出应用。',
  '更新助手返回异常。',
]);

function updateErrorPresentation(error) {
  let errorCode = error?.code || 'UPDATE_ERROR',
    message = '更新未完成，原应用已保留，请重试。',
    retryInstall = false;
  if (errorCode === 'EACCES' || errorCode === 'EPERM') {
    errorCode = 'PERMISSION';
    message = '没有权限写入更新位置。请将 Folio 放在可写的应用程序文件夹后重试。';
    retryInstall = true;
  } else if (errorCode === 'ENOSPC') {
    errorCode = 'DISK_FULL';
    message = '可用空间不足，请释放磁盘空间后重试。';
    retryInstall = true;
  } else if (errorCode === 'UPDATE_CANCELED') {
    message = '更新准备已取消，文档保持原样。你可以重试安装。';
    retryInstall = true;
  } else if (errorCode === 'UPDATE_BUSY') {
    message = '另一个更新操作正在进行，请稍后重试安装。';
    retryInstall = true;
  } else if (errorCode === 'UPDATE_INSTALL') {
    if (INSTALL_LOCATIONS.has(error.message)) {
      message = '请先将 Folio 移到本机可写的应用程序文件夹，再重试安装更新。';
      retryInstall = true;
    } else if (PACKAGE_CHECKS.has(error.message)) {
      message = '安装包未通过安全校验，原应用保持不变。请重新下载更新；若仍失败，请查看发布页面。';
    } else if (INSTALL_HELPER.has(error.message)) {
      message =
        '更新安装助手未能启动或通过检查，原应用保持不变。请重新打开 Folio 后重试；若仍失败，请从发布页面手动安装。';
    }
  } else if (error instanceof UpdateError) {
    // UpdateError messages are fixed UI wording from the release/transport layer.
    message = error.message;
  }
  return {
    status: {
      errorCode,
      message: String(message)
        .replace(/(?:gh[pousr]_|github_pat_|mpg-|sk-)[A-Za-z0-9_-]{16,}/g, '[已隐藏]')
        .slice(0, 400),
    },
    retryInstall,
  };
}
module.exports = { updateErrorPresentation };
