import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';

const read = <T,>(key: string, fallback: T): T => {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored == null) return fallback;
    const parsed = JSON.parse(stored) as unknown;
    if (parsed === null || parsed === undefined) return fallback;
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T;
    if (typeof fallback === 'object') return (typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback) as T;
    if (typeof parsed !== typeof fallback) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
};

/** Stores small user choices only; market data stays in immutable snapshots. */
export const useLocalStorageState = <T,>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] => {
  const [value, setValue] = useState<T>(() => typeof window === 'undefined' ? fallback : read(key, fallback));
  const latest = useRef(value);
  const setStoredValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const resolved = typeof next === 'function' ? (next as (current: T) => T)(latest.current) : next;
    latest.current = resolved;
    try {
      window.localStorage.setItem(key, JSON.stringify(resolved));
    } catch {
      // Browser privacy settings or quota must not stop a screen from running.
    }
    setValue(resolved);
  }, [key]);
  return [value, setStoredValue];
};

export function useSavedPagination(key: string, revision: string | undefined, defaultPageSize: 15 | 50) {
  const [saved, setSaved] = useLocalStorageState<{revision?: string; page: number; pageSize: number}>(key, {page: 1, pageSize: defaultPageSize});
  const pageSize = [15, 50, 100].includes(saved.pageSize) ? saved.pageSize : defaultPageSize;
  const page = saved.revision === revision && Number.isInteger(saved.page) && saved.page > 0 ? saved.page : 1;
  const targetRevision = revision || saved.revision;
  return {
    page, pageSize,
    setPage: (next: number) => setSaved({revision: targetRevision, page: next, pageSize}),
    setPageSize: (next: number) => setSaved({revision: targetRevision, page: 1, pageSize: next}),
  };
}
