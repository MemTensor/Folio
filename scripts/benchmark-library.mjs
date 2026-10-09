import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { DocumentLibrary } = require('../core/library.cjs');
const count = Number(process.argv[2] || 10000),
  output = process.argv[3],
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-index-bench-')),
  library = new DocumentLibrary(path.join(tmp, 'state'));
const body =
  '# 实验记录\n\n包含训练配置、公式说明、表格和结果讨论。This is a generated benchmark fixture, not user data.\n\n$$L = -\\sum_i \\log p(x_i)$$\n\n| 指标 | 结果 |\n| --- | --- |\n| loss | 0.25 |\n\n'.repeat(
    20,
  );
try {
  const roots = [];
  for (let i = 0; i < 10; i++) {
    const root = path.join(tmp, 'project-' + i);
    await fs.mkdir(root);
    await library.register(root);
    roots.push(root);
  }
  for (let start = 0; start < count; start += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, count - start) }, (_, i) => {
        const n = start + i;
        return fs.writeFile(
          path.join(roots[n % 10], 'note-' + n + '.md'),
          body + '\nunique-document-' + n + '\n',
        );
      }),
    );
  async function measure(query = '') {
    const start = performance.now(),
      result = await library.snapshot({ query });
    return {
      durationMs: Math.round(performance.now() - start),
      total: result.total,
      filesRead: result.index.filesRead,
      result,
    };
  }
  const cold = await measure();
  assert.equal(cold.total, count);
  const warm = await measure('公式');
  assert.equal(warm.total, count);
  assert.equal(warm.filesRead, 0);
  const targeted = await measure('unique-document-' + (count - 1));
  assert.equal(targeted.total, 1);
  const target = path.join(roots[0], 'note-0.md');
  await fs.appendFile(target, '\nUPDATED-UNIQUE-ANCHOR\n');
  const update = await measure('UPDATED-UNIQUE-ANCHOR');
  assert.equal(update.total, 1);
  assert.equal(update.filesRead, 1);
  const clean = (m) => ({ durationMs: m.durationMs, total: m.total, filesRead: m.filesRead });
  const report = {
    node: process.versions.node,
    documents: count,
    generatedBytes: Buffer.byteLength(body) * count,
    projects: 10,
    cold: clean(cold),
    warmChinese: clean(warm),
    warmTargeted: clean(targeted),
    singleFileUpdate: clean(update),
  };
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
} finally {
  await library.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
