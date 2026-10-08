import type { ActiveCondition, ParameterSpec } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';

export function isIntegerParameter(parameter: ParameterSpec): boolean {
  return parameter.type === 'number' && (parameter.step === 1
    || ['d', 'days', 'p', 'bars'].includes(parameter.unit ?? '')
    || ['minDaysAboveEMA', 'reclaimedWithin', 'minConsecutiveDays', 'shortPeriod', 'consecutive', 'minLegs'].includes(parameter.id));
}

export function numericInputValue(value: string): number | string {
  return value === '' ? '' : Number(value);
}

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
      if (parameter.type !== 'number') continue;
      const value = condition.parameters[parameter.id] ?? parameter.defaultValue;
      const integer = isIntegerParameter(parameter);
      if (String(value).trim() === '' || !Number.isFinite(Number(value))
          || (integer && !Number.isSafeInteger(Number(value)))
          || (parameter.min !== undefined && Number(value) < parameter.min)
          || (parameter.max !== undefined && Number(value) > parameter.max)) {
        return `${def.label}: ${parameter.label} must be a ${integer ? 'whole number' : 'finite number'} within its limits.`;
      }
    }
  }
  return null;
}
