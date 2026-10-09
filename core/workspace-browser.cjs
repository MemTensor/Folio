const path = require('node:path');
const { Worker } = require('node:worker_threads');

const LIMITS = Object.freeze({ maxEntries: 2000, maxNodes: 500, maxDirectories: 128 });
const failure = (code, message) => Object.assign(Error(message), { code });

/** Metadata browsing and native watchers never execute on Electron's main thread. */
class WorkspaceBrowser {
  constructor({
    onChange = () => {},
    onNotice = () => {},
    timeoutMs = 2800,
    limits = {},
    workerFactory = (file, options) => new Worker(file, options),
  } = {}) {
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.timeoutMs = Math.max(1, Math.min(2800, timeoutMs));
    this.limits = Object.fromEntries(
      Object.entries(LIMITS).map(([key, maximum]) => [
        key,
        Math.max(1, Math.min(maximum, Math.floor(limits[key]) || maximum)),
      ]),
    );
    this.workerFactory = workerFactory;
    this.worker = null;
    this.retiring = new Set();
    this.pending = new Map();
    this.sequence = 0;
    // Changes on worker creation. A session can restore its desired directory
    // subscriptions after the next successful explicit operation, without
    // immediately retrying a slow cloud filesystem after a timeout.
    this.generation = 0;
    this.closed = false;
  }
  notify(event) {
    try {
      this.onNotice(event);
    } catch {}
  }
  start() {
    if (this.worker) return this.worker;
    if (this.retiring.size >= 2)
      throw failure('WORKSPACE_BUSY', '上一次读取还在结束，请稍后重试。');
    const worker = this.workerFactory(path.join(__dirname, 'workspace-browser-worker.cjs'), {
      workerData: { limits: this.limits },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    this.worker = worker;
    this.generation++;
    worker.on('message', (message) => {
      if (this.worker !== worker) return;
      if (message.event === 'change') {
        try {
          this.onChange(message.value);
        } catch {}
        return;
      }
      if (message.event === 'notice') {
        this.notify(message.value);
        return;
      }
      const task = this.pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      this.pending.delete(message.id);
      if (message.error) task.reject(failure(message.error.code, message.error.message));
      else task.resolve(message.result);
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', (error) => this.failed(worker, error));
    worker.on('exit', () => {
      if (this.worker === worker)
        this.failed(worker, failure('WORKSPACE_WORKER_EXIT', '文件夹浏览暂不可用，请重试。'));
    });
    return worker;
  }
  failed(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.pending.clear();
    // Termination can itself wait for a blocked filesystem call. Never await it
    // on the UI's request path; discard this worker before accepting a retry.
    this.retire(worker);
    this.notify({ code: error.code || 'WORKSPACE_WORKER_EXIT', message: error.message });
  }
  request(operation, args = {}) {
    if (this.closed) return Promise.reject(failure('WORKSPACE_CLOSED', '文件夹浏览已关闭。'));
    let worker;
    try {
      worker = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    worker.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.failed(
            worker,
            failure('WORKSPACE_TIMEOUT', '文件夹响应较慢，已停止此次读取。请稍后重试。'),
          ),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, operation, ...args });
      } catch (error) {
        this.failed(worker, error);
      }
    });
  }
  list(root, directory = root) {
    return this.request('list', { root, directory });
  }
  watch(root, directory = root) {
    return this.request('watch', { root, directory });
  }
  unwatch(root, directory = root) {
    if (!this.worker) return Promise.resolve({ closed: 0 });
    return this.request('unwatch', { root, directory });
  }
  closeRoot(root) {
    if (!this.worker) return Promise.resolve({ closed: 0 });
    return this.request('close-root', { root });
  }
  debugStats() {
    if (!this.worker)
      return Promise.resolve({ directories: 0, files: 0, roots: 0, pending: this.pending.size });
    return this.request('stats').then((stats) => ({ ...stats, pending: this.pending.size }));
  }
  retire(worker) {
    this.retiring.add(worker);
    worker.unref();
    // A native call may delay termination. Bound retired workers as well, so
    // repeated retries cannot accumulate blocked threads and file handles.
    void Promise.resolve(worker.terminate())
      .catch(() => {})
      .finally(() => this.retiring.delete(worker));
  }
  async close() {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(failure('WORKSPACE_CLOSED', '文件夹浏览已关闭。'));
    }
    this.pending.clear();
    if (worker) this.retire(worker);
  }
}
module.exports = { WorkspaceBrowser, WORKSPACE_BROWSER_LIMITS: LIMITS };
