import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowsDownUp, Check } from '@phosphor-icons/react';
import { FILE_SORT_OPTIONS, type FileSortMode } from './sidebar-order.mjs';
import { t } from './i18n';

export function FileSortControl({
  value,
  onChange,
}: {
  value: FileSortMode;
  onChange: (value: FileSortMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const selected = FILE_SORT_OPTIONS.find((option) => option.value === value)!;
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!control.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || [],
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
  return (
    <div className="file-sort-control" ref={control}>
      <button
        ref={trigger}
        className="file-sort-button"
        aria-label={t('文件排序')}
        title={t(selected.label)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ArrowsDownUp size={13} />
        <span>{t('排序')}</span>
      </button>
      {open && (
        <div
          className="file-sort-menu"
          role="menu"
          aria-label={t('文件排序方式')}
          ref={menu}
          onKeyDown={keyboard}
        >
          {FILE_SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{t(option.label)}</span>
              <Check
                size={13}
                aria-hidden="true"
                style={{ visibility: value === option.value ? 'visible' : 'hidden' }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
