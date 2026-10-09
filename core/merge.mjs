import { diffArrays, diffLines } from 'diff';

export const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const DIFF_BUDGET = { timeout: 40, maxEditLength: 1024 };
export function edits(base, next, budget = DIFF_BUDGET) {
  if (base === next) return [];
  const original = lines(base),
    replacement = lines(next);
  const parts = diffArrays(original, replacement, budget);
  if (!parts)
    return Object.assign([{ start: 0, end: original.length, text: replacement }], {
      budgetExceeded: true,
    });
  let cursor = 0,
    current = null;
  const result = [];
  const flush = () => {
    if (current) result.push(current);
    current = null;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush();
      cursor += part.count;
      continue;
    }
    current ||= { start: cursor, end: cursor, text: [] };
    if (part.removed) {
      cursor += part.count;
      current.end = cursor;
    } else current.text = current.text.concat(part.value);
  }
  flush();
  return result;
}
function overlap(a, b) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  // Insertions exactly on a changed boundary are deliberately conservative.
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}
function applyPart(base, start, end, changes) {
  let cursor = start,
    text = '';
  for (const change of changes.sort((a, b) => a.start - b.start)) {
    text += base.slice(cursor, change.start).join('') + change.text.join('');
    cursor = change.end;
  }
  return text + base.slice(cursor, end).join('');
}
/** A pure three-way merge. Conflicts are data; never insert conflict markers into files. */
export function merge3(base, local, remote, budget = DIFF_BUDGET) {
  if (local === remote) return { segments: [{ text: local }], conflicts: 0 };
  if (base === local) return { segments: [{ text: remote }], conflicts: 0 };
  if (base === remote) return { segments: [{ text: local }], conflicts: 0 };
  const original = lines(base);
  const leftEdits = edits(base, local, budget),
    rightEdits = edits(base, remote, budget);
  if (leftEdits.budgetExceeded || rightEdits.budgetExceeded)
    return {
      segments: [{ id: 0, start: 1, base, local, remote }],
      conflicts: 1,
      budgetExceeded: true,
    };
  const all = [
    ...leftEdits.map((e) => ({ ...e, side: 'local' })),
    ...rightEdits.map((e) => ({ ...e, side: 'remote' })),
  ];
  const groups = [];
  for (const change of all.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const touching = groups.filter((g) => g.changes.some((e) => overlap(e, change)));
    const group = { changes: [change, ...touching.flatMap((g) => g.changes)] };
    for (const g of touching) groups.splice(groups.indexOf(g), 1);
    groups.push(group);
  }
  const segments = [];
  let cursor = 0,
    count = 0;
  for (const group of groups.sort(
    (a, b) =>
      Math.min(...a.changes.map((e) => e.start)) - Math.min(...b.changes.map((e) => e.start)),
  )) {
    const start = Math.min(...group.changes.map((e) => e.start)),
      end = Math.max(...group.changes.map((e) => e.end));
    if (start > cursor) segments.push({ text: original.slice(cursor, start).join('') });
    const left = group.changes.filter((e) => e.side === 'local'),
      right = group.changes.filter((e) => e.side === 'remote');
    const l = applyPart(original, start, end, left),
      r = applyPart(original, start, end, right);
    if (!left.length) segments.push({ text: r });
    else if (!right.length || l === r) segments.push({ text: l });
    else
      segments.push({
        id: count++,
        start: start + 1,
        base: original.slice(start, end).join(''),
        local: l,
        remote: r,
      });
    cursor = end;
  }
  if (cursor < original.length) segments.push({ text: original.slice(cursor).join('') });
  return { segments, conflicts: count };
}
export function resolveMerge(merge, choices = {}) {
  return merge.segments
    .map((s) => {
      if ('text' in s) return s.text;
      const choice = choices[s.id];
      if (choice !== 'local' && choice !== 'remote') throw new Error('请先处理所有冲突。');
      return s[choice];
    })
    .join('');
}
export function reviewChanges(before, after, budget = DIFF_BUDGET) {
  let line = 1,
    hunk = -1,
    inChange = false;
  const computed = diffLines(before, after, budget);
  const parts = computed || [
    ...(before ? [{ value: before, removed: true, count: lines(before).length }] : []),
    ...(after ? [{ value: after, added: true, count: lines(after).length }] : []),
  ];
  return parts.map((part, i) => {
    if (part.added || part.removed) {
      if (!inChange) hunk++;
      inChange = true;
    } else inChange = false;
    const item = {
      id: i,
      hunk: inChange ? hunk : -1,
      text: part.value,
      type: part.added ? 'add' : part.removed ? 'remove' : 'same',
      line,
      count: part.count,
      wholeDocument: !computed,
    };
    if (!part.added) line += part.count || 0;
    return item;
  });
}
export function revertChange(before, after, index, { wholeDocument = false } = {}) {
  if (wholeDocument) {
    if (index !== 0) throw Error('改动已更新，请重新审阅。');
    return before;
  }
  const original = lines(before),
    changes = edits(before, after);
  if (changes.budgetExceeded)
    throw Error('修改范围较大，无法逐段撤回。请重新审阅整篇修改或从历史版本恢复。');
  if (index < 0 || index >= changes.length) throw Error('改动已更新，请重新审阅。');
  return applyPart(
    original,
    0,
    original.length,
    changes.filter((_, i) => i !== index),
  );
}
