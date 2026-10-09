export function createBridgeActivity() {
  /** @type {Set<Promise<any>>} */ const drafts = new Set();
  /** @type {Set<Promise<any>>} */ const writes = new Set();
  let frozen = false;
  return {
    setFrozen(value) {
      frozen = value;
    },
    pendingWrites: () => writes.size,
    pendingDrafts: () => drafts.size,
    /** @param {'draft'|'write'} kind @param {()=>any} operation */
    track(kind, operation) {
      if (frozen && kind !== 'draft') return Promise.reject(Error('正在准备更新，请稍后再操作。'));
      const group = kind === 'draft' ? drafts : writes;
      let tracked;
      tracked = Promise.resolve()
        .then(operation)
        .finally(() => group.delete(tracked));
      group.add(tracked);
      return tracked;
    },
    async waitDrafts() {
      await Promise.all([...drafts]);
    },
  };
}

/**
 * contextBridge exposes a frozen object with non-configurable function values.
 * Build a separate facade: a Proxy over that object cannot substitute methods
 * without violating JavaScript's invariant for read-only target properties.
 * @template {object} T
 * @param {T} source
 * @param {ReturnType<typeof createBridgeActivity>} activity
 * @param {Set<keyof T>} writeMethods
 * @returns {T}
 */
export function wrapBridgeActivity(source, activity, writeMethods) {
  const facade = Object.create(null);
  for (const key of Reflect.ownKeys(source)) {
    const original = Reflect.get(source, key);
    const tracked = key === 'putDraft' || writeMethods.has(/** @type {keyof T} */ (key));
    const value =
      typeof original !== 'function'
        ? original
        : tracked
          ? (...args) =>
              activity.track(key === 'putDraft' ? 'draft' : 'write', () =>
                Reflect.apply(original, source, args),
              )
          : (...args) => Reflect.apply(original, source, args);
    Object.defineProperty(facade, key, {
      value,
      enumerable: Object.getOwnPropertyDescriptor(source, key)?.enumerable ?? true,
      writable: true,
      configurable: true,
    });
  }
  return facade;
}
