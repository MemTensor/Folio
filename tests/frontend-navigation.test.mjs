import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryListing } from '../src/directory-listing.mjs';
import { previewBudget, PREVIEW_LIMITS } from '../src/preview-budget.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const node = (name) => ({ name, path: '/project/' + name, kind: 'file' });

test('collapsed folders do not read; opening loads one level and closing releases cached nodes', async () => {
  const reads = [],
    states = [];
  const listing = createDirectoryListing(
    async (...args) => {
      reads.push(args);
      return { nodes: [node('One.md')], limited: false };
    },
    (state) => states.push(state),
  );
  await listing.refresh();
  assert.deepEqual(reads, []);
  await listing.open('/project', '/project/notes');
  assert.deepEqual(reads, [['/project', '/project/notes']]);
  assert.equal(states.at(-1).nodes.length, 1);
  listing.close();
  assert.deepEqual(states.at(-1), { nodes: [], limited: false, loading: false, error: '' });
  await listing.refresh();
  assert.equal(reads.length, 1);
});

test('a late response cannot repopulate a collapsed or different folder', async () => {
  const first = deferred(),
    second = deferred(),
    states = [];
  let calls = 0;
  const listing = createDirectoryListing(
    () => (++calls === 1 ? first.promise : second.promise),
    (state) => states.push(state),
  );
  const old = listing.open('/project', '/project/old');
  listing.close();
  const fresh = listing.open('/project', '/project/new');
  second.resolve({ nodes: [node('New.md')], limited: false });
  await fresh;
  first.resolve({ nodes: [node('Old.md')], limited: true });
  await old;
  assert.equal(states.at(-1).nodes[0].name, 'New.md');
  assert.equal(states.at(-1).limited, false);
  assert.equal(states.at(-1).loading, false);
});

test('watcher bursts coalesce into one pending directory refresh', async () => {
  const first = deferred(),
    second = deferred(),
    states = [];
  let calls = 0;
  const listing = createDirectoryListing(
    () => (++calls === 1 ? first.promise : second.promise),
    (state) => states.push(state),
  );
  const opened = listing.open('/project', '/project');
  await Promise.all(Array.from({ length: 100 }, () => listing.refresh()));
  assert.equal(calls, 1);
  first.resolve({ nodes: [node('Before.md')], limited: false });
  await opened;
  assert.equal(calls, 2);
  second.resolve({ nodes: [node('After.md')], limited: true });
  await tick();
  assert.equal(calls, 2);
  assert.equal(states.at(-1).nodes[0].name, 'After.md');
  assert.equal(states.at(-1).limited, true);
});

test('directory failures leave retry possible without discarding the last valid listing', async () => {
  let fail = false,
    last;
  const listing = createDirectoryListing(
    async () => {
      if (fail) throw Error('Temporary permission failure');
      return { nodes: [node('Kept.md')], limited: false };
    },
    (state) => {
      last = state;
    },
  );
  await listing.open('/project', '/project');
  fail = true;
  await listing.refresh();
  assert.equal(last.nodes[0].name, 'Kept.md');
  assert.match(last.error, /permission/);
  assert.equal(last.loading, false);
  fail = false;
  await listing.refresh();
  assert.equal(last.error, '');
});

test('preview budget admits ordinary formulas and tables, and bounds text before parsing', () => {
  assert.equal(
    previewBudget('# Notes\n\n$$x^2+y^2=z^2$$\n\n| One | Two |\n|---|---|\n| a | b |\n').allowed,
    true,
  );
  assert.equal(previewBudget('x'.repeat(PREVIEW_LIMITS.characters + 1)).reason, 'characters');
  assert.equal(previewBudget('\n'.repeat(PREVIEW_LIMITS.lines + 1)).reason, 'lines');
  // A file that ends with a newline has as many lines as it has newlines, so the
  // limit itself must still be admitted. Counting the terminator as a further
  // line put the real ceiling one line below the documented one.
  assert.equal(previewBudget('\n'.repeat(PREVIEW_LIMITS.lines)).allowed, true);
  const atLimit = Array.from({ length: PREVIEW_LIMITS.lines }, (_, i) => 'line ' + i).join('\n');
  assert.equal(previewBudget(atLimit + '\n').allowed, true);
  assert.equal(previewBudget(atLimit + '\nover').reason, 'lines');
  assert.equal(previewBudget('x'.repeat(PREVIEW_LIMITS.lineLength + 1)).reason, 'lineLength');
  assert.equal(previewBudget('x'.repeat(PREVIEW_LIMITS.lineLength)).allowed, true);
  assert.equal(previewBudget('x'.repeat(PREVIEW_LIMITS.lineLength) + '\nnext').allowed, true);
});
