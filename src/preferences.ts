export interface Prefs {
  theme: 'light' | 'sepia' | 'dark';
  font: 'sans' | 'serif';
  fontSize: number;
  width: number;
  autoSave: boolean;
  focus: boolean;
  typewriter: boolean;
  spellcheck: boolean;
  remoteImages: boolean;
  lineNumbers: boolean;
  reviewExternal: boolean;
  readingCopy: 'source' | 'rich';
  restoreTabs: 'always' | 'never' | 'ask';
}

export const defaults: Prefs = {
  theme: 'light',
  font: 'sans',
  fontSize: 16,
  width: 860,
  autoSave: true,
  focus: false,
  typewriter: false,
  spellcheck: true,
  remoteImages: false,
  lineNumbers: true,
  reviewExternal: false,
  readingCopy: 'rich',
  restoreTabs: 'ask',
};
