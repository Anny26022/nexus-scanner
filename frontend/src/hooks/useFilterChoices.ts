import {useQuery} from '@tanstack/react-query';
import {screenerApi} from '../api/screenerApi';

export function useFilterChoices(open: boolean, revision?: string) {
  return useQuery({queryKey:['filterChoices', revision], queryFn:() => screenerApi.getFilterChoices(revision),
    enabled:open, staleTime:revision ? Infinity : 60000});
}
