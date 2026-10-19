import { useEffect, useRef, useState } from 'react';
import { scheduleBounded, cancelBounded } from './bounded-debounce.mjs';
// Reading metadata may lag briefly while typing. The editor and persistence
// always use the current source; navigation resolves headings against it again.
export function useDocumentAnalysis(path: string, content: string) {
  const [snapshot, setSnapshot] = useState({ path, content });
  const previousPath = useRef(path);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (previousPath.current !== path) {
      previousPath.current = path;
      cancelBounded(timers.current, 'analysis');
      setSnapshot({ path, content });
    } else
      scheduleBounded(timers.current, 'analysis', () => setSnapshot({ path, content }), 200, 1000);
  }, [path, content]);
  useEffect(() => () => cancelBounded(timers.current, 'analysis'), []);
  return snapshot.path === path ? snapshot.content : content;
}
