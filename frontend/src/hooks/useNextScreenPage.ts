import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import type { ScreenerRunRequest, ScreenerRunResponse } from '../types/screener';

// Pinned releases are immutable; page-only navigation must not refetch them.
export const screenPageStaleTime = (request: ScreenerRunRequest) => request.datasetRevision ? Infinity : 30_000;

/** Warm only one adjacent snapshot page, never a backend/text-query request. */
export function useNextScreenPage(key: string, request: ScreenerRunRequest, data: ScreenerRunResponse | undefined, ready: boolean) {
  const next = {...request, page: request.page + 1};
  useQuery({
    queryKey: [key, next],
    queryFn: () => screenerApi.runScreen(next),
    enabled: ready && Boolean(request.datasetRevision) && !request.textQuery?.trim()
      && !request.announcementFilter && data?.page === request.page
      && data.pageSize === request.pageSize && request.page * request.pageSize < data.matchCount,
    staleTime: screenPageStaleTime(next),
    retry: false,
    // Background completion should not repaint the current 100-row table.
    notifyOnChangeProps: [],
  });
}
