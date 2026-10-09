const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const punctuation = /\p{P}/u;
const fullwidthPunctuation = /[\u3001-\u303f\uff01-\uff65]/u;

// Reuse MarkdownIt's delimiter pairing and nested inline parsing. Only relax
// double-asterisk flanking around CJK text/punctuation and a short trailing
// horizontal-space run. Source, code spans, escapes and math are untouched.
export function cjkEmphasis(md) {
  md.inline.ruler.before('emphasis', 'folio-cjk-emphasis', (state, silent) => {
    if (silent || state.src.slice(state.pos, state.pos + 2) !== '**') return false;
    const scanned = state.scanDelims(state.pos, true);
    const before = state.src.slice(Math.max(0, state.pos - 2), state.pos);
    const after = state.src.slice(state.pos + scanned.length, state.pos + scanned.length + 2);
    let open = scanned.can_open,
      close = scanned.can_close;
    if (!open && cjk.test(before) && punctuation.test(after[0] || '')) open = true;
    if (!close && cjk.test(after) && punctuation.test(before.slice(-1))) close = true;
    if (!close && /[\t ]$/.test(before)) {
      const trailing = state.src.slice(Math.max(0, state.pos - 34), state.pos);
      const match = /([^\t \n\r])[\t ]{1,32}$/.exec(trailing);
      if (match && (cjk.test(match[1]) || fullwidthPunctuation.test(match[1]))) close = true;
    }
    if (open === scanned.can_open && close === scanned.can_close) return false;
    for (let i = 0; i < scanned.length; i++) {
      const token = state.push('text', '', 0);
      token.content = '*';
      state.delimiters.push({
        marker: 0x2a,
        length: scanned.length,
        token: state.tokens.length - 1,
        end: -1,
        open,
        close,
      });
    }
    state.pos += scanned.length;
    return true;
  });
}
