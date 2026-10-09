import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FileStore } = require('../core/file-store.cjs');
const { embedLocalImages } = require('../core/export-assets.cjs');
test('export embeds local image bytes without retaining private absolute paths', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-export-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new FileStore(path.join(dir, 'state'));
  await store.setRoot(dir);
  const p = path.join(dir, 'image.png');
  await fs.writeFile(p, Buffer.from([1, 2, 3]));
  const html = await embedLocalImages(
    '<img src="folio-asset://local/?path=' + encodeURIComponent(p) + '" alt="test">',
    store,
  );
  assert.equal(html, '<img src="data:image/png;base64,AQID" alt="test">');
});
