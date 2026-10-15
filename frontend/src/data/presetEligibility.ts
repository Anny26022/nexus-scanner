import rules from './presetEligibility.json';
export const PRESET_ELIGIBILITY = rules;

// Missing settings preserve old scans. Null explicitly removes a restriction.
export function presetEligibilityTargets(parameters: Record<string, unknown>): (number | null)[] | null {
  const targets = rules.map(rule => parameters[rule.id] === undefined ? rule.defaultValue : parameters[rule.id]);
  if (targets.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) return null;
  return targets as (number | null)[];
}

export function hasCustomPresetEligibility(parameters: Record<string, unknown>): boolean {
  return rules.some(rule => parameters[rule.id] !== undefined && parameters[rule.id] !== rule.defaultValue);
}

export function presetEligibilitySummary(parameters: Record<string, unknown>): string {
  const targets = presetEligibilityTargets(parameters);
  if (!targets) return 'Enter a non-negative eligibility threshold or remove the rule.';
  return rules.flatMap((rule, i) => targets[i] === null ? [] : [`${rule.label} > ${targets[i]} ${rule.unit}`]).join(' AND ') || 'No eligibility restrictions';
}
