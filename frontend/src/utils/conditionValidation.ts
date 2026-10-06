import type { ActiveCondition } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';

export function conditionValidationError(map: Record<string, ActiveCondition>): string | null {
  for (const condition of Object.values(map)) {
    const def = NEXUS_CONDITION_CATALOG.find(item => item.id === condition.conditionId);
    if (!def) continue;
    if (condition.conditionId === 'MA_CONVERGENCE') {
      const parts = String(condition.parameters.periods ?? '').split(',').map(value => value.trim());
      const periods = parts.map(Number);
      if (parts.length < 2 || parts.some(value => !/^\d+$/.test(value))
          || periods.some(value => !Number.isSafeInteger(value) || value <= 0)
          || new Set(periods).size !== periods.length) {
        return 'MA Convergence: enter at least two distinct positive integer periods.';
      }
    }
    for (const parameter of def.parameters) {
      if (parameter.type !== 'number' || parameter.step !== 1) continue;
      const value = condition.parameters[parameter.id] ?? parameter.defaultValue;
      if (value === '' || !Number.isSafeInteger(Number(value))
          || (parameter.min !== undefined && Number(value) < parameter.min)
          || (parameter.max !== undefined && Number(value) > parameter.max)) {
        return `${def.label}: ${parameter.label} must be a whole number within its limits.`;
      }
    }
  }
  return null;
}
