// Manual, explicitly authorized smoke test. Key is read from a non-echoing stdin;
// only generated fixtures are uploaded, and the test collection is removed.
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { MemosCloud, publish, searchKnowledge } = require('../core/memos-cloud.cjs');
const { FileStore } = require('../core/file-store.cjs');
const { KnowledgeStore } = require('../core/knowledge.cjs');
async function keyFromStdin() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('Waiting for test credential on stdin (input hidden).\n');
  return new Promise((resolve) => {
    let value = '';
    const read = (b) => {
      value += b.toString();
      if (/[\r\n]/.test(value)) {
        process.stdin.off('data', read);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(value.trim());
      }
    };
    process.stdin.on('data', read);
  });
}
(async () => {
  const key = await keyFromStdin(),
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-live-')),
    cloud = new MemosCloud(path.join(temp, 'state'), {
      apiKey: key,
      userId: 'folio-integration-test',
    });
  let collection,
    fileIds = [];
  const emit = (data) => process.stdout.write(JSON.stringify(data) + '\n');
  try {
    const root = path.join(temp, 'workspace');
    await fs.mkdir(root);
    const code = 'FOLIO_TEST_' + crypto.randomBytes(6).toString('hex');
    const target = path.join(root, 'integration.md');
    await fs.writeFile(
      target,
      `# Folio cloud integration test\n\nThis is generated test data, not user content.\n\n## Verification details\n\nThe verification code is ${code}.\n\nFormula: $E=mc^2$.\n\n| Field | Value |\n| --- | --- |\n| Purpose | Automated test |\n`,
    );
    collection = await cloud.addCollection(
      'Folio temporary integration ' + Date.now(),
      'Generated fixture. Removed when the test completes.',
    );
    emit({ step: 'collection-created', id: collection.id });
    const store = new FileStore(path.join(temp, 'state'));
    await store.setRoot(root);
    const knowledge = new KnowledgeStore(store),
      file = await store.read(target);
    const result = await publish(knowledge, cloud, target, collection.id, {
      expectedRevision: file.hash,
    });
    fileIds = result.fileIds;
    emit({ step: 'published', state: result.state, fileIds, responseShape: result.response });
    if (!fileIds.length)
      throw Error('Cloud accepted response without recognized file identifiers.');
    let recalled = false;
    for (let i = 0; i < 12; i++) {
      const status = await cloud.documentStatus(fileIds);
      emit({ step: 'status', attempt: i + 1, data: status });
      const query = 'Which document describes Folio integration verification details?';
      const found = await cloud.search(query, collection.id);
      const routes = await searchKnowledge(knowledge, cloud, query, collection.id);
      const route = routes.items.find((x) => x.source?.documentId === result.documentId);
      recalled = Boolean(route && (await store.read(route.source.path)).content.includes(code));
      emit({
        step: 'search',
        attempt: i + 1,
        recallVerified: recalled,
        route: route?.source,
        shape: found.data?.memory_detail_list?.[0] || found,
      });
      if (recalled) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!recalled) throw Error('Ingestion/search was not verified within the bounded test window.');
    emit({ step: 'verified', retrievedOwnFixture: true });
  } catch (e) {
    emit({ step: 'error', code: e.code, message: e.message });
    process.exitCode = 1;
  } finally {
    if (fileIds.length)
      try {
        await cloud.removeDocuments(fileIds);
        emit({ step: 'test-documents-removed' });
      } catch (e) {
        emit({ step: 'cleanup-error', message: e.message });
        process.exitCode = 1;
      }
    if (collection)
      try {
        await cloud.removeCollection(collection.id);
        emit({ step: 'test-collection-removed', id: collection.id });
      } catch (e) {
        emit({ step: 'cleanup-error', message: e.message });
        process.exitCode = 1;
      }
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  process.stderr.write(e.message + '\n');
  process.exitCode = 1;
});
