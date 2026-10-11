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
  return <div role="alert" className="notice">
    <p>{UNAVAILABLE_CONDITIONS_MESSAGE}</p>
    <div className="active-filters">{unavailable.map(([key, condition]) => {
      const label = RETIRED_TECHNICAL_LABELS[condition.conditionId]
        ?? NEXUS_CONDITION_CATALOG.find(def => def.id === condition.conditionId)?.label ?? condition.conditionId;
      return <span className="filter-chip" key={key}>{label} · Unavailable
        <button type="button" aria-label={`Remove unavailable ${label}`} onClick={() => onRemove(key)}>Remove</button>
      </span>;
    })}</div>
  </div>;
}
