import test from 'node:test';
import assert from 'node:assert/strict';
import { imageURL } from '../src/image-url.mjs';
import { readImageRecovery } from '../src/image-import.mjs';

test('local images resolve from Windows drive, UNC and POSIX document paths', () => {
  for (const [document, expected] of [
    ['C:\\项目\\笔记.md', 'C:/项目/assets/图.png'],
    ['D:/Project/Notes.md', 'D:/Project/assets/图.png'],
    ['\\\\server\\share\\Notes.md', '//server/share/assets/图.png'],
    ['/project/Notes.md', '/project/assets/图.png'],
  ]) {
    const url = new URL(imageURL('assets/图.png', { path: document }));
    assert.equal(url.searchParams.get('path'), expected);
    assert.equal(url.searchParams.get('document'), document);
    const recovery = { path: document, items: [{ name: '图.png', relative: 'assets/图.png' }] };
    assert.deepEqual(readImageRecovery({ getItem: () => JSON.stringify(recovery) }), recovery);
  }
});
