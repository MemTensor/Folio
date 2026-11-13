/** Recognize persisted desktop paths; filesystem authorization stays in the main process. */
export function isAbsoluteLocalPath(value) {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
  );
}
