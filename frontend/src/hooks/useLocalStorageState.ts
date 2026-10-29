import { useStoredState } from '../storage/useStoredState';

/** Stores small user choices only; market data stays in immutable snapshots. Shared by every reader of the key. */
export const useLocalStorageState = useStoredState;

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
