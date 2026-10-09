/** @type {import('./types').AgentConnection} */
let snapshot = { phase: 'idle', models: [] };
const listeners = new Set();
export const agentConnection = () => snapshot;
/** @param {import('./types').AgentConnection} value */
export function receiveAgentConnection(value) {
  if ((value.revision || 0) < (snapshot.revision || 0)) return;
  if (
    value.revision === snapshot.revision &&
    value.phase === snapshot.phase &&
    value.provider === snapshot.provider
  )
    return;
  snapshot = value;
  for (const listener of listeners) listener();
}
export function watchAgentConnection(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
