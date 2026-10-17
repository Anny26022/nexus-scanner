import type { ActiveCondition, ConditionDef } from '../types/screener';
import { isRetiredTechnicalCondition } from '../data/conditionCatalog';
import { supportsSnapshotCondition } from '../api/snapshotScreen';

export function isAvailableCondition(condition: ActiveCondition): boolean {
  return !isRetiredTechnicalCondition(condition.conditionId) && supportsSnapshotCondition(condition);
}

export function availableFilterParameters(definition: ConditionDef): ActiveCondition['parameters'] | null {
  const parameters = Object.fromEntries(definition.parameters.map(parameter => [parameter.id, parameter.defaultValue]));
  const condition = {
    instanceId: definition.id,
    conditionId: definition.id,
    parameters,
  };
  if (isAvailableCondition(condition)) return parameters;
  // Only the front-weighted RS horizon is published; preserve saved settings.
  if (definition.id === 'RS_RATING') {
    const supported = {...parameters, window:'FRONT_WEIGHTED'};
    if (isAvailableCondition({...condition, parameters: supported})) return supported;
  }
  if (definition.id === 'AVG_VOLUME_RATIO') {
    const supported = {...parameters, recentDays:10, baseDays:30};
    if (isAvailableCondition({...condition, parameters:supported})) return supported;
  }
  return null;
}

export function isAvailableFilter(definition: ConditionDef): boolean {
  return availableFilterParameters(definition) !== null;
}
