import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverableProjects,
  isTemporaryProject,
  projectTitle,
  recentShelfDocuments,
  selectProjectShelf,
  SHELF_PROJECT_LIMIT,
} from '../src/project-shelf.mjs';

const project = (id, root, options = {}) => ({
  id,
  root,
  name: root.split('/').at(-1),
  sources: ['Codex'],
  available: true,
  registered: false,
  lastOpenedAt: 0,
  ...options,
});

test('100 discovered task folders do not displace intentionally opened projects', () => {
  const noise = Array.from({ length: 100 }, (_, index) =>
    project('task-' + index, '/Users/person/Documents/Codex/2026-09-21/task-' + index, {
      registered: index % 2 === 0,
      lastOpenedAt: 10000 + index,
    }),
  );
  const projects = [
    ...noise,
    project('one', '/Users/person/Code/Orion', { registered: true, lastOpenedAt: 100 }),
    project('two', '/Users/person/Code/Atlas/docs', { registered: true, lastOpenedAt: 200 }),
    project('discovered', '/Users/person/Code/Unopened', { lastOpenedAt: 30000 }),
    project('missing', '/Users/person/Code/Missing', {
      registered: true,
      available: false,
      lastOpenedAt: 40000,
    }),
  ];
  const before = structuredClone(projects);
  assert.deepEqual(
    selectProjectShelf(projects).map((item) => item.id),
    ['two', 'one'],
  );
  assert.deepEqual(projects, before);
  assert.deepEqual(
    discoverableProjects(projects).map((item) => item.id),
    ['two', 'one', 'discovered'],
  );
});

test('temporary classification uses path boundaries and explicit pins can override it', () => {
  const examples = [
    '/tmp/project',
    '/private/tmp/project',
    '/var/folders/abc/task',
    '/Users/person/.codex/worktrees/abcd/project',
    '/Users/person/.claude/worktrees/task/project',
    '/Users/person/Documents/Codex/2026-09-21/task',
  ];
  assert(examples.every((root) => isTemporaryProject({ root })));
  assert(!isTemporaryProject({ root: '/Users/person/Code/tmp-research' }));
  assert(!isTemporaryProject({ root: '/Users/person/Code/new-chat-client' }));
  assert(!isTemporaryProject({ root: '/Users/person/Documents/new-chat' }));
  assert(!isTemporaryProject({ root: '/Users/person/Documents/Codex/research-project' }));
  const candidates = examples.map((root, index) => project(String(index), root));
  assert.equal(selectProjectShelf(candidates).length, 0);
  assert.equal(discoverableProjects(candidates).length, 0);
  assert.equal(
    discoverableProjects(candidates, { includeTemporary: true }).length,
    examples.length,
  );
  assert.deepEqual(
    selectProjectShelf(candidates, ['3', '0']).map((item) => item.id),
    ['3', '0'],
  );
  candidates[3].available = false;
  assert.deepEqual(
    selectProjectShelf(candidates, ['3', '0']).map((item) => item.id),
    ['0'],
  );
});

test('the shelf is capped and generic document folders identify their parent project', () => {
  const projects = Array.from({ length: 20 }, (_, index) =>
    project(String(index), '/Users/person/Code/Project-' + index, {
      registered: true,
      lastOpenedAt: index,
    }),
  );
  const shelf = selectProjectShelf(projects, ['1']);
  assert.equal(shelf.length, SHELF_PROJECT_LIMIT);
  assert.equal(shelf[0].id, '1');
  assert.equal(shelf[1].id, '19');
  assert.equal(projectTitle(project('a', '/Users/person/Code/Orion/docs')), 'Orion · 文档');
  assert.equal(
    projectTitle(project('b', '/Users/person/Code/Atlas/notes'), 'Documents'),
    'Atlas · Documents',
  );
  assert.equal(
    projectTitle(project('c', '/Users/person/Code/Special', { name: 'Custom project' })),
    'Custom project',
  );
});

test('discovery filters locally by project name and path while preserving hidden defaults', () => {
  const projects = [project('a', '/Users/person/Code/Orion/docs'), project('b', '/tmp/Orion')];
  assert.deepEqual(
    discoverableProjects(projects, { query: 'ORION' }).map((item) => item.id),
    ['a'],
  );
  assert.equal(
    discoverableProjects(projects, { query: 'ORION', includeTemporary: true }).length,
    2,
  );
});

const document = (path, lastOpenedAt) => ({
  path,
  name: path.split('/').at(-1),
  projectName: 'Research',
  relativePath: path.split('/').at(-1),
  lastOpenedAt,
});
test('recent documents exclude generated tasks and archive mirrors before taking eight rows', () => {
  const noise = Array.from({ length: 100 }, (_, index) =>
    document('/tmp/task-' + index + '/HANDOFF.md', 10000 + index),
  );
  const recent = [
    ...noise,
    document('/Users/person/Projects/Research/代码镜像/engine/HANDOFF.md', 30000),
    document('/Users/person/Projects/Research/backups/plan.md', 30001),
    document('/Users/person/.codex/worktrees/xyz/notes.md', 30002),
    ...Array.from({ length: 12 }, (_, index) =>
      document('/Users/person/Code/Research/Note-' + index + '.md', 100 + index),
    ),
    document('/Users/person/Code/Research/Note-11.md', 1),
  ];
  const before = structuredClone(recent);
  const selected = recentShelfDocuments(recent);
  assert.equal(selected.length, 8);
  assert.equal(selected[0].name, 'Note-11.md');
  assert(selected.every((item) => item.path.startsWith('/Users/person/Code/Research/')));
  assert.deepEqual(recent, before);
});

test('recent documents respect unavailable projects and explicit temporary project pins', () => {
  const projects = [
    project('temp', '/tmp/notes'),
    project('missing', '/Users/person/Code/Missing', { available: false }),
  ];
  const recent = [
    document('/tmp/notes/Note.md', 10),
    document('/Users/person/Code/Missing/Old.md', 20),
  ];
  assert.deepEqual(recentShelfDocuments(recent, projects), []);
  assert.deepEqual(
    recentShelfDocuments(recent, projects, ['temp', 'missing']).map((item) => item.name),
    ['Note.md'],
  );
});
