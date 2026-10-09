import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isDependencyDirectory } = require('../core/ignored-directories.cjs');
const { scanProject } = require('../core/library-scan.cjs');
const { FileStore } = require('../core/file-store.cjs');
const { category, documentAllowed } = require('../core/document-catalog-policy.cjs');

test('every traversal agrees on which directories hold dependencies, not documents', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ignore-')));
  const root = path.join(directory, 'project');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dependency = ['node_modules', 'Node_Modules', 'venv', 'site-packages', 'coverage', 'build'];
  const documents = ['docs', 'notes', 'reference'];
  for (const name of [...dependency, ...documents]) {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, name, 'Note.md'), '# body needle');
  }
  const store = new FileStore(path.join(directory, 'state'));
  await store.setRoot(root);
  const scanned = scanProject(root, {
    maxEntries: 5000,
    maxDepth: 12,
    entries: 0,
    deadline: performance.now() + 5000,
  });
  const treeNames = new Set();
  const walk = (nodes) => {
    for (const node of nodes) {
      treeNames.add(node.name);
      if (node.children) walk(node.children);
    }
  };
  walk(await store.tree());

  for (const name of dependency) {
    assert.equal(isDependencyDirectory(name), true, name);
    assert.equal(category(name), 'skip', name);
    assert.equal(documentAllowed(`${name}/Note.md`, true), false, name);
    // The full-text index must not read bodies out of a virtualenv.
    assert.equal(
      scanned.files.some((file) => file.includes(path.sep + name + path.sep)),
      false,
      name,
    );
    assert.equal(treeNames.has(name), false, name);
  }
  for (const name of documents) {
    assert.equal(isDependencyDirectory(name), false, name);
    assert.notEqual(category(name), 'skip', name);
    assert.equal(documentAllowed(`${name}/Note.md`, true), true, name);
    assert.equal(
      scanned.files.some((file) => file.includes(path.sep + name + path.sep)),
      true,
      name,
    );
    assert.equal(treeNames.has(name), true, name);
  }
});

test('folders that only the document list hides stay browsable in the tree', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ignore-')));
  const root = path.join(directory, 'project');
  await fs.mkdir(path.join(root, 'skills'), { recursive: true });
  await fs.writeFile(path.join(root, 'skills', 'SKILL.md'), '# agent instructions');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FileStore(path.join(directory, 'state'));
  await store.setRoot(root);
  // Written for a tool rather than for the reader, so it is not offered as one of
  // the project's documents, but the folder is still the user's to open.
  assert.equal(category('skills'), 'skip');
  assert.equal(isDependencyDirectory('skills'), false);
  assert.equal(
    (await store.tree()).some((node) => node.name === 'skills'),
    true,
  );
});
