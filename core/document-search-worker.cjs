const { parentPort } = require('node:worker_threads');
const { FileStore } = require('./file-store.cjs');
parentPort.on('message', async ({ id, root, dataDir, query }) => {
  try {
    const store = new FileStore(dataDir);
    await store.setRoot(root);
    parentPort.postMessage({ id, result: await store.search(query) });
  } catch (error) {
    parentPort.postMessage({ id, error: { code: error.code, message: error.message } });
  }
});
