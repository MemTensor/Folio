import { useSyncExternalStore } from 'react';
import { t } from './i18n';
import type { Heading } from './markdown';

export function createCursorPosition() {
  let position = { line: 1, column: 1 };
  const listeners = new Set<() => void>();
  return {
    get: () => position,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (line: number, column: number) => {
      if (position.line === line && position.column === column) return;
      position = { line, column };
      listeners.forEach((listener) => listener());
    },
  };
}
type Cursor = ReturnType<typeof createCursorPosition>;
export function CursorPosition({ cursor }: { cursor: Cursor }) {
  const position = useSyncExternalStore(cursor.subscribe, cursor.get);
  return <span>{t('第 {line} 行，第 {column} 列', position)}</span>;
}
export function OutlineItems({
  cursor,
  headings,
  jump,
}: {
  cursor: Cursor;
  headings: Heading[];
  jump: (line: number) => void;
}) {
  const line = useSyncExternalStore(cursor.subscribe, () => cursor.get().line);
  return headings.map((h) => (
    <button
      key={h.id}
      className={'outline-item ' + (line === h.line ? 'selected' : '')}
      style={{ paddingLeft: 18 + (h.level - 1) * 13 }}
      title={h.text}
      aria-label={`H${h.level} ${h.text}`}
      onClick={() => jump(h.line)}
    >
      <span className="heading-number" aria-hidden="true">
        H{h.level}
      </span>
      <span>{h.text}</span>
    </button>
  ));
}
