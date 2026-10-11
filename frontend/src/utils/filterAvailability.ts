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
  // The catalogue's 150-session SMA default is not published, but the same
  // filter supports the snapshot's other SMA periods. Start on a usable one.
  if (definition.id === 'PRICE_VS_SMA') {
    const supported = {...parameters, period: 50, persistDays: 1};
    if (isAvailableCondition({...condition, parameters: supported})) return supported;
  }
  return null;
}

export function isAvailableFilter(definition: ConditionDef): boolean {
  return availableFilterParameters(definition) !== null;
}
