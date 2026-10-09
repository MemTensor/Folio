// Electron may still be unwinding will-quit when resolved promises run.
// Retry quit on the next event-loop turn, after its quitting flag is reset.
const DRAIN_TIMEOUT = 5000;
/**
 * @param {import('electron').App} app
 * @param {() => Promise<unknown>} cleanup
 * @param {(error: Error) => void} [onError]
 * @param {{ timeout?: number }} [options]
 */
function installShutdown(app, cleanup, onError = () => {}, { timeout = DRAIN_TIMEOUT } = {}) {
  let complete = false,
    pending = false;
  app.on('will-quit', (event) => {
    if (complete) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    // Cleanup cancels read-only work and drains writes. The deadline reports a
    // slow drain; it cannot authorize killing a replacement between moving the
    // old document aside and putting the completed document in its place.
    const timer = setTimeout(() => {
      onError(
        Object.assign(Error('后台任务仍在收尾，完成后会退出。'), { code: 'SHUTDOWN_TIMEOUT' }),
      );
    }, timeout);
    timer.unref?.();
    Promise.resolve()
      .then(cleanup)
      .catch(onError)
      .finally(() => {
        clearTimeout(timer);
        complete = true;
        setImmediate(() => app.quit());
      })
      .catch(onError);
  });
}
module.exports = { installShutdown, DRAIN_TIMEOUT };
