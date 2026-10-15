class OperationGroup {
  constructor() {
    this.pending = new Set();
    this.closed = false;
  }
  run(fn) {
    if (this.closed)
      return Promise.reject(
        Object.assign(Error('后台任务仍在收尾，完成后会退出。'), { code: 'CLOSING' }),
      );
    const job = Promise.resolve().then(fn);
    this.pending.add(job);
    const remove = () => this.pending.delete(job);
    job.then(remove, remove);
    return job;
  }
  async close() {
    this.closed = true;
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
module.exports = { OperationGroup };
