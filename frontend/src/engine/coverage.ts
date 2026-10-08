import type { ScreenerRunResponse } from '../types/screener';
import type { EngineCondition, Truth } from './expression';

export type Coverage = Pick<ScreenerRunResponse,'perConditionCoverage' | 'unavailableDiagnostics'>;
export function createCoverage(leaves: EngineCondition[], universeCount: number) {
  const counts = leaves.map(() => ({evaluated:0,matched:0,unavailable:0}));
  return {
    account(values: Truth[]) {
      values.forEach((value,index) => {
        if (value === null) counts[index].unavailable++;
        else { counts[index].evaluated++; if (value) counts[index].matched++; }
      });
    },
    result(): Coverage {
      return {
        perConditionCoverage:Object.fromEntries(leaves.map((leaf,index) => [leaf.instanceId ?? `${leaf.conditionId}:${index}`,{
          conditionId:leaf.conditionId,evaluated:counts[index].evaluated,matched:counts[index].matched,
          coveragePct:universeCount ? Math.round(counts[index].evaluated / universeCount * 10000) / 100 : 0,
        }])),
        unavailableDiagnostics:leaves.flatMap((leaf,index) => counts[index].unavailable ? [{
          conditionId:leaf.conditionId,reason:'required data unavailable',affectedCount:counts[index].unavailable,
        }] : []),
      };
    },
  };
}
