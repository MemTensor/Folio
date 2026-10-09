const english = require('./translations.en.cjs');

function wordExportMessage({ fallbackCount, warnings = '' }, language) {
  const translate = (message) =>
    language === 'en' && Object.hasOwn(english, message) ? english[message] : message;
  const parts = [translate('Word 已导出。')];
  if (fallbackCount) {
    const vars = { count: fallbackCount };
    parts.push(
      translate('{count} 条特殊公式使用矢量图，其余公式可编辑。').replace(
        /\{(\w+)(?:\|([^{}|]*)\|([^{}|]*))?\}/g,
        (token, key, one, many) => {
          if (!Object.hasOwn(vars, key)) return token;
          if (one === undefined) return String(vars[key]);
          return Number(vars[key]) === 1 ? one : many;
        },
      ),
    );
  }
  if (warnings.includes('rsvg-convert'))
    parts.push(translate('矢量插图请使用支持 SVG 的 Word 版本。'));
  else if (warnings) parts.push(translate('转换提示：') + warnings.slice(0, 180));
  // Translate each sentence before joining. English needs a word boundary even
  // when a dictionary entry has no trailing whitespace; Chinese punctuation does not.
  return parts.map((part) => part.trim()).join(language === 'en' ? ' ' : '');
}

module.exports = { wordExportMessage };
