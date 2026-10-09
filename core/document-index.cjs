const path = require('node:path');
const { Worker } = require('node:worker_threads');

class DocumentIndex {
  constructor(dataDir, { home } = {}) {
    this.dataDir = dataDir;
    this.home = home;
    this.sequence = 0;
    this.pending = new Map();
    this.worker = null;
    this.idle = null;
  }
  async request(args) {
    clearTimeout(this.idle);
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, 'index-worker.cjs'), {
        workerData: { dataDir: this.dataDir, home: this.home },
      });
      this.worker = worker;
      const failed = (error) => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(error);
        }
        this.pending.clear();
      };
      worker.on('error', failed);
      worker.on('exit', (code) => {
        if (this.worker === worker) failed(Error('本地搜索线程已退出：' + code));
      });
      worker.on('message', ({ id, result, error }) => {
        const task = this.pending.get(id);
        if (!task) return;
        clearTimeout(task.timer);
        this.pending.delete(id);
        error
          ? task.reject(Object.assign(Error(error.message), { code: error.code }))
          : task.resolve(result);
        if (!this.pending.size) {
          worker.unref();
          this.idle = setTimeout(() => void this.close(), 10000);
          this.idle.unref();
        }
      });
    }
    this.worker.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => void this.close('查找超时，请缩小项目范围后重试。'), 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...args });
    });
  }
  async close(message = '已取消查找。') {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(Error(message), { code: 'SEARCH_CANCELED' }));
    }
    this.pending.clear();
    await worker?.terminate();
  }
}
module.exports = { DocumentIndex };
