import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

const read = <T,>(key: string, fallback: T): T => {
  try {
    const stored = window.localStorage.getItem(key);
    return stored == null ? fallback : JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
};

/** Stores small user choices only; market data stays in immutable snapshots. */
export const useLocalStorageState = <T,>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] => {
  const [value, setValue] = useState<T>(() => typeof window === 'undefined' ? fallback : read(key, fallback));
  const setStoredValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue(previous => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(previous) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Browser privacy settings or quota must not stop a screen from running.
      }
      return resolved;
    });
  }, [key]);
  return [value, setStoredValue];
};

type SavedPagination = {revision?: string; page: number; pageSize: number};

function paginationValue(value: unknown, defaultPageSize: 15 | 50): SavedPagination {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {page: 1, pageSize: defaultPageSize};
  const saved = value as Partial<SavedPagination>;
  return {
    revision: typeof saved.revision === 'string' ? saved.revision : undefined,
    page: typeof saved.page === 'number' && Number.isInteger(saved.page) && saved.page > 0 ? saved.page : 1,
    pageSize: typeof saved.pageSize === 'number' && [15, 50, 100].includes(saved.pageSize) ? saved.pageSize : defaultPageSize,
  };
}

export function useSavedPagination(key: string, revision: string | undefined, defaultPageSize: 15 | 50) {
  const [stored, setSaved] = useLocalStorageState<SavedPagination>(key, {page: 1, pageSize: defaultPageSize});
  const saved = paginationValue(stored, defaultPageSize);
  const {pageSize} = saved;
  const page = saved.revision === revision ? saved.page : 1;
  const targetRevision = revision || saved.revision;
  return {
    page, pageSize,
    setPage: (next: number) => setSaved({revision: targetRevision, page: next, pageSize}),
    setPageSize: (next: number) => setSaved({revision: targetRevision, page: 1, pageSize: next}),
  };
}
