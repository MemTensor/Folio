import { diffChars } from 'diff';

/** Preserve positions of unchanged text when an external revision arrives.
 * @param {string} before @param {string} after
 */
export function documentChanges(before, after) {
  const parts = diffChars(before, after, { timeout: 20, maxEditLength: 2048 });
  if (!parts)
    return { changes: [{ from: 0, to: before.length, insert: after }], resetHistory: true };
  /** @type {{from:number,to:number,insert:string}[]} */
  const changes = [];
  let at = 0;
  /** @type {{from:number,to:number,insert:string}|undefined} */
  let change;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (change) changes.push(change);
      change = undefined;
      at += part.value.length;
      continue;
    }
    change ||= { from: at, to: at, insert: '' };
    if (part.removed) {
      at += part.value.length;
      change.to = at;
    } else change.insert += part.value;
  }
  if (change) changes.push(change);
  return {
    changes,
    resetHistory: changes.length === 1 && changes[0].from === 0 && changes[0].to === before.length,
  };
}
