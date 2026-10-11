import type { ActiveCondition, ConditionDef } from '../types/screener';
import { isRetiredTechnicalCondition } from '../data/conditionCatalog';
import { supportsSnapshotCondition } from '../api/snapshotScreen';

export function isAvailableCondition(condition: ActiveCondition): boolean {
  return !isRetiredTechnicalCondition(condition.conditionId) && supportsSnapshotCondition(condition);
}

export function isAvailableFilter(definition: ConditionDef): boolean {
  return isAvailableCondition({
    instanceId: definition.id,
    conditionId: definition.id,
    parameters: Object.fromEntries(definition.parameters.map(parameter => [parameter.id, parameter.defaultValue])),
  });
}
