const WRITES = new Set([
  'agent-send',
  'agent-configure',
  'agent-login',
  'agent-clear',
  'agent-resolve',
  'save',
  'project-configure',
  'project-open',
  'project-sync',
  'project-sync-bind',
  'project-sync-resolve',
  'export',
  'dingtalk-plan',
  'dingtalk-reconcile',
  'checkpoint',
  'create',
  'rename',
  'trash',
  'save-as',
  'import-image',
  'library-remove',
  'choose',
  'accept-open',
  'activate-workspace',
  'library-open',
  'cloud-configure',
  'cloud-bind-project',
  'cloud-create-collection',
  'cloud-attach-collection',
  'dingtalk-execute',
  'dingtalk-recover',
  'dingtalk-share',
  'dingtalk-share-resolve',
]);
const fail = (message) => Object.assign(Error(message), { code: 'UPDATE_DOCUMENT_CHANGED' });
// Matches the installer's own confirmation window. A renderer that stops
// answering must not leave editing frozen and the application unquittable.
const TICKET_TTL = 180000;
class UpdateGate {
  constructor({ now = () => Date.now(), ttl = TICKET_TTL, onExpire = () => {} } = {}) {
    this.epoch = 0;
    this.writes = 0;
    this.drafts = 0;
    this.ticket = null;
    this.now = now;
    this.ttl = ttl;
    this.onExpire = onExpire;
    this.timer = null;
  }
  /** Expire both sides of an uncommitted request before accepting another one. */
  activeTicket() {
    if (this.ticket && !this.ticket.committing && this.now() >= this.ticket.expires) {
      const expired = this.ticket;
      clearTimeout(this.timer);
      this.timer = null;
      this.ticket = null;
      this.onExpire(expired);
    }
    return this.ticket;
  }
  scheduleExpiry() {
    const ticket = this.ticket;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (this.ticket !== ticket || ticket.committing) return;
        if (this.activeTicket()) this.scheduleExpiry();
      },
      Math.max(1, ticket.expires - this.now()),
    );
    this.timer.unref?.();
  }
  enter(name) {
    const draft = name === 'draft-put',
      write = WRITES.has(name);
    const ticket = this.activeTicket();
    if (ticket && (write || (draft && ticket.committing)))
      throw fail('正在准备安装更新，请稍候再操作。');
    if (draft) this.drafts++;
    if (write) this.writes++;
    return () => {
      if (draft) this.drafts--;
      if (write) this.writes--;
    };
  }
  begin(requestId, owner) {
    if (this.activeTicket() || this.writes) throw fail('文档操作尚未完成，请稍后再安装更新。');
    this.ticket = {
      requestId,
      owner,
      epoch: this.epoch,
      committing: false,
      expires: this.now() + this.ttl,
    };
    this.scheduleExpiry();
  }
  changed() {
    this.epoch++;
  }
  valid(requestId, owner) {
    const ticket = this.activeTicket();
    return (
      !!ticket &&
      ticket.requestId === requestId &&
      ticket.owner === owner &&
      ticket.epoch === this.epoch &&
      this.writes === 0 &&
      this.drafts === 0
    );
  }
  commit(requestId, owner) {
    if (!this.valid(requestId, owner) || this.ticket.committing)
      throw fail('文档或窗口已变化，请重新检查后安装。');
    this.ticket.committing = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
  cancel(requestId) {
    if (!requestId || this.ticket?.requestId === requestId) {
      clearTimeout(this.timer);
      this.timer = null;
      this.ticket = null;
    }
  }
}
module.exports = { UpdateGate };
