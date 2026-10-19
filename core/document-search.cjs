const path = require('node:path');
const { Worker } = require('node:worker_threads');
// One active search per window; cancellation retires the worker without waiting
// for slow filesystem calls. Retired workers are bounded as well.
class DocumentSearch {
  constructor({
    timeout = 10000,
    workerFactory = (file, options) => new Worker(file, options),
  } = {}) {
    this.timeout = timeout;
    this.workerFactory = workerFactory;
    this.active = null;
    this.retiring = new Set();
    this.closed = false;
    this.sequence = 0;
  }
  cancel() {
    if (!this.active) return;
    const { worker, finish } = this.active;
    finish(null, []);
    this.retire(worker);
  }
  retire(worker) {
    if (this.retiring.has(worker)) return;
    this.retiring.add(worker);
    worker.unref();
    void worker
      .terminate()
      .catch(() => {})
      .finally(() => this.retiring.delete(worker));
  }
  search(root, dataDir, query) {
    this.cancel();
    if (this.closed || !query?.trim()) return Promise.resolve([]);
    if (this.retiring.size >= 2)
      return Promise.reject(
        Object.assign(Error('上一次搜索还在结束，请稍后重试。'), { code: 'SEARCH_BUSY' }),
      );
    const worker = this.workerFactory(path.join(__dirname, 'document-search-worker.cjs'), {
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.active?.worker === worker) this.active = null;
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        finish(
          Object.assign(Error('搜索耗时较长，已停止。请缩小项目范围后重试。'), {
            code: 'SEARCH_TIMEOUT',
          }),
        );
        this.retire(worker);
      }, this.timeout);
      this.active = { worker, finish };
      worker.once('message', (message) => {
        if (message.id !== id) return;
        finish(
          message.error
            ? Object.assign(Error(message.error.message), { code: message.error.code })
            : null,
          message.result,
        );
        this.retire(worker);
      });
      worker.once('error', (error) => {
        finish(error);
        this.retire(worker);
      });
      worker.once('exit', () =>
        finish(Object.assign(Error('搜索暂不可用，请重试。'), { code: 'SEARCH_WORKER_EXIT' })),
      );
      worker.postMessage({ id, root, dataDir, query });
    });
  }
  close() {
    this.closed = true;
    this.cancel();
  }
}
module.exports = { DocumentSearch };
