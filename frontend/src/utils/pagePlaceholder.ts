import type { ScreenerRunRequest, ScreenerRunResponse } from '../types/screener';

/** Keep the previous page only while paging within the exact same screen/release. */
export function pagePlaceholder(previous: ScreenerRunResponse | undefined, prior: unknown, next: ScreenerRunRequest) {
  if (!previous || !prior || typeof prior !== 'object') return undefined;
  return JSON.stringify({...prior, page: 1}) === JSON.stringify({...next, page: 1}) ? previous : undefined;
}
