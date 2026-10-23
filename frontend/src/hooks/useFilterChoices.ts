import {useQuery} from '@tanstack/react-query';
import {screenerApi} from '../api/screenerApi';

export function useFilterChoices(open: boolean, revision?: string, sessionDate?: string, etf = false) {
  return useQuery({queryKey:['filterChoices', revision, sessionDate, etf], queryFn:() => screenerApi.getFilterChoices(revision, sessionDate, etf),
    enabled:open, staleTime:revision ? Infinity : 60000});
}
