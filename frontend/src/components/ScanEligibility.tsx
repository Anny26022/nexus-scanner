import { X } from 'lucide-react';
import type { ActiveCondition } from '../types/screener';
import { PRESET_ELIGIBILITY } from '../data/presetEligibility';
import { numericInputValue } from '../utils/conditionValidation';

const SHORT: Record<string, string> = {minMarketCapCr: 'Mcap', minPrice: 'Price', minTurnoverCr: 'Turnover 50d'};

/** One compact line per selected pipeline scan: its eligibility floors as small toggleable chips. */
export function ScanEligibility({scans, nameOf, onChange, onRemove}: {
  scans: [string, ActiveCondition][];
  nameOf: (id: string) => string;
  onChange: (key: string, ruleId: string, value: unknown) => void;
  onRemove: (key: string) => void;
}) {
  if (!scans.length) return null;
  return <section className="scan-elig" aria-label="Eligibility for selected scans">
    <span className="scan-elig-title">Eligibility</span>
    {scans.map(([key, condition]) => {
      const name = nameOf(condition.conditionId);
      return <div key={key} className="scan-elig-row">
        <span className="scan-elig-name" title={name}>{name}</span>
        <div className="scan-elig-rules">{PRESET_ELIGIBILITY.map(rule => {
          const value = condition.parameters[rule.id] === undefined ? rule.defaultValue : condition.parameters[rule.id];
          const on = value !== null;
          return <span key={rule.id} className="scan-elig-chip" data-on={on}>
            <label>
              <input type="checkbox" aria-label={`Use ${rule.label}`} checked={on}
                onChange={event => onChange(key, rule.id, event.target.checked ? rule.defaultValue : null)} />
              <span>{SHORT[rule.id] ?? rule.label} &gt;</span>
            </label>
            <input type="number" min="0" step="any" aria-label={`${rule.label} minimum`} disabled={!on} value={value ?? ''}
              onChange={event => onChange(key, rule.id, numericInputValue(event.target.value))} />
            <span className="scan-elig-unit">{rule.unit.replace('₹ ', '')}</span>
          </span>;
        })}</div>
        <button type="button" className="scan-elig-remove" aria-label={`Remove ${name}`} title="Remove" onClick={() => onRemove(key)}>
          <X size={12} strokeWidth={2} />
        </button>
      </div>;
    })}
  </section>;
}
