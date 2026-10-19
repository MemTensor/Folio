// Idle debounce with a maximum wait, so continuous typing still reaches storage.
const deadlines = new WeakMap();
export function scheduleBounded(timers, key, run, idle, maximum, now = Date.now()) {
  let pending = deadlines.get(timers);
  if (!pending) deadlines.set(timers, (pending = new Map()));
  const deadline = pending.get(key) ?? now + maximum;
  pending.set(key, deadline);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(
      () => {
        timers.delete(key);
        pending.delete(key);
        run();
      },
      Math.max(0, Math.min(idle, deadline - now)),
    ),
  );
}
export function cancelBounded(timers, key) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  deadlines.get(timers)?.delete(key);
}
