const key = 'folio-tab-session';
const legacyKey = 'folio-open-tabs';

/** @returns {'always'|'never'|'ask'} */
export function restoreTabsPreference(value) {
  return value === 'always' || value === 'never' ? value : 'ask';
}

function paths(value) {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')),
        ),
      ]
    : [];
}

/** A null session means first launch; an empty session means explicitly closed tabs. */
export function readTabSession(storage) {
  try {
    const raw = storage.getItem(key);
    if (raw !== null) {
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.paths)) return null;
      const tabs = paths(value.paths);
      return {
        paths: tabs,
        active: tabs.includes(value.active) ? value.active : '',
        restore: value.restore !== false,
        resumeOnce: value.resumeOnce === true,
      };
    }
    const legacy = storage.getItem(legacyKey);
    if (legacy !== null)
      return { paths: paths(JSON.parse(legacy)), active: '', restore: true, resumeOnce: false };
  } catch {
    /* Corrupt browser state must not prevent opening a document. */
  }
  return null;
}

export function writeTabSession(storage, tabs, active, restore, resumeOnce = false) {
  const list = paths(tabs);
  storage.setItem(
    key,
    JSON.stringify({
      version: 1,
      paths: restore ? list : [],
      active: restore && list.includes(active) ? active : '',
      restore,
      resumeOnce,
    }),
  );
  storage.removeItem(legacyKey);
}

export function startupTabs(session, preference) {
  if (!session || !session.restore || (preference === 'never' && !session.resumeOnce)) return [];
  return session.paths;
}

export function needsClosePrompt(preference, count, unsaved) {
  return unsaved || (count > 0 && preference === 'ask');
}
