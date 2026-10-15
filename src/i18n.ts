import english from './translations.en.json';

export type Locale = 'zh-CN' | 'en';
const storageKey = 'folio-language';
const listeners = new Set<() => void>();
const normalize = (value: unknown): Locale => (value === 'en' ? 'en' : 'zh-CN');
function readLocale(): Locale {
  try {
    return normalize(globalThis.localStorage?.getItem(storageKey));
  } catch {
    return 'zh-CN';
  }
}
let locale: Locale = readLocale();
export function getLocale(): Locale {
  return locale;
}
export function localeTag(): string {
  return locale === 'en' ? 'en-US' : 'zh-CN';
}
function publishLocale(next: Locale) {
  if (locale === next) return;
  locale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
export function setLocale(next: Locale): void {
  const value = normalize(next);
  try {
    globalThis.localStorage?.setItem(storageKey, value);
  } catch {
    // Language switching remains available when browser storage is unavailable.
  }
  publishLocale(value);
}
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/**
 * The message from a failed call, ready to be translated and shown.
 * Electron wraps a rejected `ipcRenderer.invoke` as
 * `Error invoking remote method 'channel': Error: <message>`. Displaying that
 * leaks the channel name, and the wrapper also stops the message from matching
 * any dictionary entry, so an already-translated error comes back Chinese.
 */
export { errorMessage } from './error-message.mjs';

/**
 * Placeholder text that is written into the user's Markdown, not shown as UI.
 * It deliberately does not go through the translation table: `t()` falls back to
 * its Chinese argument on a missing key, which is right for a label and wrong for
 * document content.
 */
export function documentText(chinese: string, english: string): string {
  return locale === 'en' ? english : chinese;
}
const known = (message: string) => Object.prototype.hasOwnProperty.call(english, message);
/**
 * `{name}` inserts a value. `{name|one|many}` picks the singular or plural wording
 * English needs and Chinese does not, from the number in `name`; a Chinese message
 * never carries that form, so it fills the same way either way.
 */
function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(
    /\{(\w+)(?:\|([^{}|]*)\|([^{}|]*))?\}/g,
    (token, key: string, one?: string, many?: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return token;
      if (one === undefined) return String(vars[key]);
      return Number(vars[key]) === 1 ? one : (many as string);
    },
  );
}
/** Only UI messages are translated. Document text is never passed through this function. */
export function t(message: string, vars?: Record<string, string | number>): string {
  if (locale !== 'en') return fill(message, vars);
  if (known(message)) return fill((english as Record<string, string>)[message], vars);
  // Several messages read `<sentence>：<path or system reason>`. The tail is assembled
  // where the failure happens and cannot be translated, which also stops the whole
  // string from matching a key. Translating the sentence alone keeps the tail intact.
  const cut = message.indexOf('：');
  const head = cut < 0 ? '' : message.slice(0, cut + 1);
  if (head && known(head))
    return (english as Record<string, string>)[head] + message.slice(cut + 1);
  return fill(message, vars);
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) publishLocale(readLocale());
  });
  document.documentElement.lang = locale;
}
