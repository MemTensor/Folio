function contextItems(input, t, choose) {
  if (
    !input ||
    !['document', 'file', 'tab', 'text'].includes(input.kind) ||
    typeof input.editable !== 'boolean' ||
    typeof input.selection !== 'boolean' ||
    (input.blockKind !== undefined && !['table', 'math', 'diagram'].includes(input.blockKind))
  )
    throw Error('右键菜单请求无效。');
  const item = (label, id, enabled = true) => ({
    id,
    label: t(label),
    enabled,
    click: () => choose(id),
  });
  const separator = { type: 'separator' };
  const location = [
    item('复制完整路径', 'copy-path'),
    item('复制相对路径', 'copy-relative-path'),
    item('在 Finder 中显示', 'reveal'),
  ];
  if (input.kind === 'file')
    return [
      item('打开文档', 'open'),
      separator,
      item('重命名', 'rename'),
      ...location,
      separator,
      item('移入回收站', 'trash'),
    ];
  if (input.kind === 'tab')
    return [
      item('保存', 'save'),
      ...location,
      separator,
      item('关闭标签', 'close-tab'),
      item('关闭其他标签', 'close-others'),
      item('关闭右侧标签', 'close-right'),
      item('关闭所有标签', 'close-all'),
    ];
  const role = (label, name, enabled = true) => ({ label: t(label), role: name, enabled });
  const editing = [
    role('撤销', 'undo', input.editable),
    role('重做', 'redo', input.editable),
    separator,
    role('剪切', 'cut', input.editable && input.selection),
    input.kind === 'document' && !input.editable
      ? item('复制', 'copy-preview', input.selection)
      : role('复制', 'copy', input.selection),
    role('粘贴', 'paste', input.editable),
    role('粘贴为纯文本', 'pasteAndMatchStyle', input.editable),
    role('全选', 'selectAll'),
  ];
  if (input.kind === 'text') return editing;
  return [
    ...(input.blockKind
      ? [
          item(
            { table: '编辑表格', math: '编辑公式', diagram: '编辑图表' }[input.blockKind],
            'edit-block',
          ),
          separator,
        ]
      : []),
    ...editing.slice(0, -1),
    item('全选', 'select-document'),
    separator,
    ...(input.editable
      ? [
          {
            label: t('格式'),
            submenu: [
              item('粗体', 'bold'),
              item('斜体', 'italic'),
              item('删除线', 'strike'),
              item('行内代码', 'code'),
              item('插入链接', 'link'),
              separator,
              item('引用', 'quote'),
              item('无序列表', 'bullet'),
              item('有序列表', 'ordered'),
              item('任务列表', 'task'),
            ],
          },
          {
            label: t('快速插入'),
            submenu: [
              item('公式', 'math'),
              item('图表', 'diagram'),
              item('表格', 'table'),
              item('代码块', 'codeblock'),
            ],
          },
        ]
      : [item('源码', 'edit-source')]),
    item('Agent 文档助手', 'document-agent'),
    separator,
    ...location,
  ];
}

function popupContext(Menu, window, input, translate) {
  return new Promise((resolve, reject) => {
    let result = null,
      settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeListener('closed', finish);
      resolve(result);
    };
    try {
      const menu = Menu.buildFromTemplate(contextItems(input, translate, (id) => (result = id)));
      if (window.isDestroyed()) return finish();
      window.once('closed', finish);
      menu.popup({ window, callback: finish });
    } catch (error) {
      window.removeListener('closed', finish);
      reject(error);
    }
  });
}
module.exports = { contextItems, popupContext };
