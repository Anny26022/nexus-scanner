import type { ActiveCondition } from '../types/screener';
import { RETIRED_TECHNICAL_LABELS, isRetiredTechnicalCondition } from '../data/conditionCatalog';

export const UNAVAILABLE_CONDITIONS_MESSAGE = 'Saved filters are unavailable. Remove them explicitly before running this scan.';

export function hasUnavailableConditions(conditions: Record<string, ActiveCondition>) {
  return Object.values(conditions).some(condition => isRetiredTechnicalCondition(condition.conditionId));
}

export function UnavailableConditions({ conditions, onRemove }: {
  conditions: Record<string, ActiveCondition>; onRemove: (key: string) => void;
}) {
  const unavailable = Object.entries(conditions).filter(([, condition]) => isRetiredTechnicalCondition(condition.conditionId));
  if (!unavailable.length) return null;
  return <div role="alert" className="notice">
    <p>{UNAVAILABLE_CONDITIONS_MESSAGE}</p>
    <div className="active-filters">{unavailable.map(([key, condition]) => {
      const label = RETIRED_TECHNICAL_LABELS[condition.conditionId];
      return <span className="filter-chip" key={key}>{label} · Unavailable
        <button type="button" aria-label={`Remove unavailable ${label}`} onClick={() => onRemove(key)}>Remove</button>
      </span>;
    })}</div>
  </div>;
}
