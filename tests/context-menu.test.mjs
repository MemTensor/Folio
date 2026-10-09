import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { contextItems, popupContext } = createRequire(import.meta.url)(
  '../electron/context-menu.cjs',
);
const identity = (value) => value;

test('reading and rendered selections never enable native cut, paste or formatting', () => {
  const items = contextItems(
    { kind: 'document', editable: false, selection: true },
    identity,
    () => {},
  );
  assert.equal(items.find((item) => item.role === 'copy').enabled, true);
  for (const role of ['cut', 'paste', 'pasteAndMatchStyle'])
    assert.equal(items.find((item) => item.role === role).enabled, false);
  assert.equal(
    items.some((item) => item.submenu),
    false,
  );
  assert.equal(items.find((item) => item.id === 'select-document').enabled, true);
  assert.equal(
    items.some((item) => item.role === 'selectAll'),
    false,
    'select only the document, not app chrome',
  );
});

test('invalid menu scopes and nonboolean editing flags are rejected', () => {
  for (const input of [
    null,
    { kind: 'terminal', editable: true, selection: true },
    { kind: 'text', editable: 'true', selection: false },
  ])
    assert.throws(() => contextItems(input, identity, () => {}), /右键菜单请求无效/);
});

test('closing the owner window cancels a pending native menu without a late action', async () => {
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  let items;
  const Menu = {
    buildFromTemplate: (value) => {
      items = value;
      return { popup: () => {} };
    },
  };
  const pending = popupContext(
    Menu,
    window,
    { kind: 'file', editable: false, selection: false },
    identity,
  );
  window.emit('closed');
  assert.equal(await pending, null);
  items.find((item) => item.id === 'trash').click();
  assert.equal(window.listenerCount('closed'), 0);
});
