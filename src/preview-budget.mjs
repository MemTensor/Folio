export const PREVIEW_LIMITS = Object.freeze({
  characters: 256_000,
  lines: 5_000,
  lineLength: 20_000,
});

/** Check before parsing Markdown or constructing preview DOM. @param {string} content */
export function previewBudget(content) {
  if (content.length > PREVIEW_LIMITS.characters) return { allowed: false, reason: 'characters' };
  let lines = 1,
    lineStart = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 10 && index - lineStart >= PREVIEW_LIMITS.lineLength)
      return { allowed: false, reason: 'lineLength' };
    if (content.charCodeAt(index) === 10) {
      // A trailing newline ends the last line, it does not start another one.
      // Counting it made the real ceiling 4,999 lines for any file that ends the
      // way text files normally do.
      if (index + 1 < content.length && ++lines > PREVIEW_LIMITS.lines)
        return { allowed: false, reason: 'lines' };
      lineStart = index + 1;
    }
  }
  return { allowed: true, reason: null };
}
