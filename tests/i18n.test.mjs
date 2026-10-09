import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { analyzeFiles, analyzeSource, sourceFiles, CHINESE } from './helpers/i18n-source.mjs';

const require = createRequire(import.meta.url);
const source = (
  await build({
    entryPoints: ['src/i18n.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
).outputFiles[0].text;
function load(saved, blocked = false) {
  const values = new Map(saved === undefined ? [] : [['folio-language', saved]]);
  const events = new Map();
  const context = {
    exports: {},
    module: { exports: {} },
    document: { documentElement: { lang: '' } },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    localStorage: {
      getItem: (key) => {
        if (blocked) throw Error('Storage disabled');
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (blocked) throw Error('Storage disabled');
        values.set(key, value);
      },
    },
  };
  vm.runInNewContext(source, context);
  return { ...context.module.exports, values, events, context };
}

test('language selection persists, announces changes once, and follows other windows', () => {
  const ui = load();
  assert.equal(ui.getLocale(), 'zh-CN');
  assert.equal(ui.t('打开文档'), '打开文档');
  let changes = 0;
  const off = ui.subscribeLocale(() => changes++);
  ui.setLocale('en');
  assert.equal(ui.t('打开文档'), 'Open document');
  assert.equal(ui.context.document.documentElement.lang, 'en');
  assert.equal(ui.values.get('folio-language'), 'en');
  ui.setLocale('en');
  assert.equal(changes, 1);
  ui.values.set('folio-language', 'zh-CN');
  ui.events.get('storage')({ key: 'folio-language' });
  assert.equal(ui.t('打开文档'), '打开文档');
  assert.equal(changes, 2);
  off();
  ui.setLocale('en');
  assert.equal(changes, 2);
});

test('English UI preserves unknown content and interpolation values exactly', () => {
  const ui = load('en');
  assert.equal(ui.localeTag(), 'en-US');
  assert.equal(ui.t('constructor'), 'constructor');
  assert.equal(ui.t('__proto__'), '__proto__');
  assert.equal(ui.t('我的研究文档：$x^2$ 与图表'), '我的研究文档：$x^2$ 与图表');
  const title = '中文文档 {other} <img src=x> $x^2$';
  assert.equal(ui.t('上次同步：{time}', { time: title }), `Last synced: ${title}`);
  assert.equal(ui.t('第 {line} 行，第 {column} 列', { line: 2, column: 9 }), 'Line 2, column 9');
  assert.equal(ui.t('未知消息 {name}', { name: title }), `未知消息 ${title}`);
  // A value nobody supplied stays written out rather than reading as an empty gap.
  assert.equal(ui.t('{count} 字', {}), '{count} {count|word|words}');
});

test('a count reads as English singular or plural, and as one Chinese wording', () => {
  const ui = load('en');
  assert.equal(ui.t('{count} 字', { count: 1 }), '1 word');
  assert.equal(ui.t('{count} 字', { count: 2 }), '2 words');
  assert.equal(ui.t('{count} 字符', { count: 1 }), '1 character');
  assert.equal(ui.t('{count} 处需要你的判断', { count: 1 }), '1 conflict needs your review');
  assert.equal(ui.t('{count} 处需要你的判断', { count: 4 }), '4 conflicts need your review');
  assert.equal(
    ui.t('{formulas} 个公式 · {tables} 个表格 · {images} 张图片', {
      formulas: 1,
      tables: 3,
      images: 0,
    }),
    '1 equation · 3 tables · 0 images',
  );
  const chinese = load('zh-CN');
  assert.equal(chinese.t('{count} 字', { count: 1 }), '1 字');
  assert.equal(chinese.t('{count} 处需要你的判断', { count: 4 }), '4 处需要你的判断');
});

test('a message that ends in a path or reason still translates its sentence', () => {
  const ui = load('en');
  // The tail is assembled where the failure happens, so the whole string is not a key.
  assert.equal(
    ui.t('这个历史快照已损坏，原文件已保留：/Users/me/notes/.folio/history.json'),
    'This snapshot is damaged. The original file was kept: /Users/me/notes/.folio/history.json',
  );
  assert.equal(ui.t('本地搜索线程已退出：1'), 'The local search worker stopped: 1');
  // An unknown sentence keeps both halves rather than losing the part it can read.
  assert.equal(ui.t('未知前缀：/tmp/x'), '未知前缀：/tmp/x');
  assert.equal(load('zh-CN').t('本地搜索线程已退出：1'), '本地搜索线程已退出：1');
});

test('storage failures and invalid saved language keep the UI usable', () => {
  const ui = load('unexpected');
  assert.equal(ui.getLocale(), 'zh-CN');
  const restricted = load(undefined, true);
  restricted.setLocale('en');
  assert.equal(restricted.t('取消'), 'Cancel');
});

test('the update screen uses English controls without translating release notes', async () => {
  const bundled = (
    await build({
      stdin: {
        contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { UpdatePanel } from './src/UpdatePanel'; export function render(status) { return renderToStaticMarkup(React.createElement(UpdatePanel, { status, installing:false, onInstall:async()=>{} })); }`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      plugins: [
        {
          name: 'isolated-bridge',
          setup(b) {
            b.onResolve({ filter: /^\.\/bridge$/ }, () => ({ path: 'bridge', namespace: 'test' }));
            b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
              contents: 'export const bridge = {};',
              loader: 'js',
            }));
          },
        },
      ],
    })
  ).outputFiles[0].text;
  const context = {
    module: { exports: {} },
    exports: {},
    require,
    process,
    queueMicrotask,
    setImmediate,
    clearImmediate,
    TextEncoder,
    TextDecoder,
    Buffer,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => 'en' },
  };
  vm.runInNewContext(bundled, context);
  const html = context.module.exports.render({
    phase: 'available',
    currentVersion: '0.4.0',
    supported: true,
    message: '发现新版本。',
    available: { version: '0.5.0', notes: '原始中文发布说明与公式 $x^2$' },
  });
  assert.match(html, /Download update/);
  assert.match(html, /Current version/);
  assert.match(html, /A new version is available\./);
  assert.match(html, /原始中文发布说明与公式 \$x\^2\$/);
  assert.doesNotMatch(html, /下载更新|当前版本|发现新版本/);
});

test('both dictionaries translate shared messages the same way', () => {
  const main = require('../electron/translations.en.cjs');
  const renderer = require('../src/translations.en.json');
  const conflicts = Object.keys(main)
    .filter((key) => Object.prototype.hasOwnProperty.call(renderer, key))
    .filter((key) => main[key] !== renderer[key]);
  assert.deepEqual(conflicts, [], 'the same Chinese message must read the same in English');
});

// Include installer diagnostics as well: UPDATE_* failures retain their message
// when they reach the UI. No runtime module is exempt from translation coverage.
const runtime = analyzeFiles(sourceFiles(['core', 'electron']));

test('the AST scanner covers error signatures, constants, templates and dynamic prefixes', () => {
  const result = analyzeSource(`
    const NOTICE = '文件尚未下载。';
    const ALIAS = NOTICE;
    Error("双引号消息。");
    new UpdateError('CODE', ALIAS);
    new DingTalkError('CODE', '钉钉消息。');
    new CloudError('CODE', '云端消息。');
    fail('CODE', '代码在前。');
    failure('消息在前。', 'CODE');
    Error(\`模板消息。\`);
    Error(\`读取失败：\${file}\`);
    Error('保存失败：' + reason);
    Error('完整' + '消息。');
    const state = { message: ready ? '已经就绪。' : '仍在等待。' };
    send('notice', NOTICE);
    view.executeJavaScript("throw Error('嵌入窗口消息。')");
    // Error('注释不是消息。');
    function shadow(NOTICE) { Error(NOTICE); }
  `);
  assert.deepEqual(
    [...result.messages.keys()].sort(),
    [
      '文件尚未下载。',
      '双引号消息。',
      '钉钉消息。',
      '云端消息。',
      '代码在前。',
      '消息在前。',
      '模板消息。',
      '读取失败：',
      '保存失败：',
      '完整消息。',
      '已经就绪。',
      '仍在等待。',
      '嵌入窗口消息。',
    ].sort(),
  );
  assert.equal(result.messages.get('读取失败：').prefix, true);
  assert.equal(result.messages.get('完整消息。').prefix, false);
  assert.equal(
    analyzeSource("const TEXT = '外部消息。'; function f(TEXT) { Error(TEXT); }").messages.size,
    0,
  );
});

test('critical constant and second-argument messages remain in source coverage', () => {
  for (const message of [
    '文件尚未下载到本机，已跳过本轮处理。',
    '一侧的内容变为空，请确认要保留哪个版本。',
    '已有新版本，但适合此设备的完整安装包尚未就绪，请稍后重试。',
    '请先将 Folio 安装到可写的应用程序目录。',
    '更新准备已取消，文档保持原样。你可以重试安装。',
    '安装包未通过安全校验，原应用保持不变。请重新下载更新；若仍失败，请查看发布页面。',
  ])
    assert(runtime.messages.has(message), message);
});

test('the AST scanner covers presenter assignments before sanitizing a message', () => {
  const { messages } = analyzeSource(`
    function presentation(code, error) {
      let message = '一般失败。';
      if (code === 'BUSY') message = '请稍候。';
      else message = error.message || '没有错误说明。';
      const state = {};
      state.message = '状态消息。';
      return { message: String(message).replace(/secret/g, 'hidden').slice(0, 400) };
    }
  `);
  assert.deepEqual(
    [...messages.keys()].sort(),
    ['一般失败。', '请稍候。', '没有错误说明。', '状态消息。'].sort(),
  );
});

test('statically collected runtime messages have English wording in both dictionaries', () => {
  const main = require('../electron/translations.en.cjs');
  const renderer = require('../src/translations.en.json');
  const missing = [...runtime.messages]
    .filter(([message]) => renderer[message] === undefined || main[message] === undefined)
    .map(([message, location]) => `${location.file}:${location.line}: ${message}`);
  assert.deepEqual(missing, [], 'these read as Chinese in an English window');
});

test('the dictionary carries no wording the product has stopped using', () => {
  const renderer = require('../src/translations.en.json');
  const main = require('../electron/translations.en.cjs');
  const { used } = analyzeFiles(sourceFiles(['src', 'core', 'electron', 'cli']));
  const unused = [...new Set([...Object.keys(renderer), ...Object.keys(main)])].filter(
    (key) => CHINESE.test(key) && !used.has(key),
  );
  assert.deepEqual(unused, [], 'an unused entry is wording that no longer matches the product');
});

test('usage detection requires a complete literal or a parsed dynamic prefix', () => {
  const { used } = analyzeSource(`
    const label = '正在打开项目…';
    const warning = '读取失败：' + path;
    const shortcut = '快捷键\\\\';
    const assembled = '完整' + '句子。';
    // '注释中的词条';
  `);
  assert(used.has('正在打开项目…'));
  assert(used.has('读取失败：'));
  assert(used.has('完整句子。'));
  assert(used.has('快捷键\\'));
  assert(!used.has('打开项目'));
  assert(!used.has('注释中的词条'));
});

test('document placeholders follow the interface language and never the fallback table', () => {
  const chinese = load('zh-CN');
  assert.equal(chinese.documentText('文字', 'text'), '文字');
  assert.equal(chinese.documentText('链接文字', 'link text'), '链接文字');
  const english = load('en');
  // These strings are written into the user's Markdown. `t()` returns its Chinese
  // argument whenever a key is missing, which is right for a label and wrong for
  // document content, so they take a separate path.
  assert.equal(english.documentText('文字', 'text'), 'text');
  assert.equal(english.documentText('链接文字', 'link text'), 'link text');
  english.setLocale('zh-CN');
  assert.equal(english.documentText('文字', 'text'), '文字');
});

test('a failed call reads as its message, without the IPC wrapper', () => {
  const { errorMessage } = load('en');
  assert.equal(
    errorMessage(
      Error("Error invoking remote method 'project-open': Error: The project is unavailable."),
    ),
    'The project is unavailable.',
  );
  assert.equal(errorMessage(Error('Plain failure.')), 'Plain failure.');
  assert.equal(errorMessage('a string'), 'a string');
  // The unwrapped message is what the dictionary is keyed on.
  const wrapped = Error(
    "Error invoking remote method 'read': Error: 只允许打开 Markdown 或文本文件。",
  );
  const { t } = load('en');
  assert.equal(t(errorMessage(wrapped)), 'Only Markdown and text files can be opened.');
});
