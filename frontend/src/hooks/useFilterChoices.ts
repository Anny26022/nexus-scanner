import {useQuery} from '@tanstack/react-query';
import {screenerApi} from '../api/screenerApi';

export function useFilterChoices(open: boolean, revision?: string, sessionDate?: string) {
  return useQuery({queryKey:['filterChoices', revision, sessionDate], queryFn:() => screenerApi.getFilterChoices(revision, sessionDate),
    enabled:open, staleTime:revision ? Infinity : 60000});
}
