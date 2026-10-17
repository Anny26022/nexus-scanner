import type { ActiveCondition } from '../types/screener';
import { NEXUS_CONDITION_CATALOG, RETIRED_TECHNICAL_LABELS } from '../data/conditionCatalog';
import { isAvailableCondition } from '../utils/filterAvailability';

export const UNAVAILABLE_CONDITIONS_MESSAGE = 'Saved filters are unavailable with these settings. Change their settings or remove them before running this scan. Backend-dependent filters are temporarily disabled.';

export function hasUnavailableConditions(conditions: Record<string, ActiveCondition>) {
  return Object.values(conditions).some(condition => !isAvailableCondition(condition));
}

export function UnavailableConditions({ conditions, onRemove }: {
  conditions: Record<string, ActiveCondition>; onRemove: (key: string) => void;
}) {
  const unavailable = Object.entries(conditions).filter(([, condition]) => !isAvailableCondition(condition));
  if (!unavailable.length) return null;

  return (
    <div role="alert" className="unavailable-notice-inline">
      <span className="unavailable-text">Unavailable in snapshot:</span>
      <div className="unavailable-chips">
        {unavailable.map(([key, condition]) => {
          const label = RETIRED_TECHNICAL_LABELS[condition.conditionId]
            ?? NEXUS_CONDITION_CATALOG.find(def => def.id === condition.conditionId)?.label ?? condition.conditionId;
          return (
            <span className="filter-chip filter-chip--unavailable" key={key}>
              <span>{label}</span>
              <button type="button" aria-label={`Remove unavailable ${label}`} onClick={() => onRemove(key)}>
                ×
              </button>
            </span>
          );
        })}
        {unavailable.length > 1 && (
          <button 
            type="button" 
            className="unavailable-clear-all"
            onClick={() => unavailable.forEach(([key]) => onRemove(key))}
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
