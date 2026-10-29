import type { ActiveCondition, MatchMode } from '../types/screener';
import { normalizeScreenName, parseCondition } from './savedScreens';

/** A named filter, or a named set of filters with its AND/OR mode, kept in the user's scan library. */
export interface SavedScan {
  id: string;
  name: string;
  savedAt: string;
  matchMode: MatchMode;
  conditions: ActiveCondition[];
}

export const SAVED_SCANS_KEY = 'nexus-scanner.screener.saved-scans.v1';
export const MAX_SAVED_SCANS = 100;
const MAX_CONDITIONS = 40;

export function parseSavedScans(value: unknown): SavedScan[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const {id, name, savedAt, matchMode, conditions} = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof savedAt !== 'string'
      || (matchMode !== 'all' && matchMode !== 'any') || !Array.isArray(conditions)
      || !conditions.length || conditions.length > MAX_CONDITIONS) return [];
    const parsed = conditions.map(parseCondition);
    if (parsed.some(condition => !condition)) return [];
    const clean = normalizeScreenName(name);
    return clean ? [{id, name: clean, savedAt, matchMode: matchMode as MatchMode, conditions: parsed as ActiveCondition[]}] : [];
  }).slice(0, MAX_SAVED_SCANS);
}

/** Saves under a name, replacing a scan with the same name (case-insensitive). */
export function upsertSavedScan(list: SavedScan[], name: string, conditions: ActiveCondition[], matchMode: MatchMode, now = new Date()): SavedScan[] {
  const clean = normalizeScreenName(name);
  if (!clean || !conditions.length) return list;
  const existing = list.find(item => item.name.toLowerCase() === clean.toLowerCase());
  const entry: SavedScan = {id: existing?.id ?? `scan-${now.getTime().toString(36)}-${list.length}`, name: clean,
    savedAt: now.toISOString(), matchMode, conditions: conditions.map(({instanceId: _, ...condition}) => ({instanceId: condition.conditionId, ...condition}))};
  return [entry, ...list.filter(item => item !== existing)].slice(0, MAX_SAVED_SCANS);
}

/** Fresh copies for a screen, so the same saved filter can be added twice without colliding. */
export const scanInstances = (scan: SavedScan): Record<string, ActiveCondition> => Object.fromEntries(scan.conditions.map(condition => {
  const instanceId = crypto.randomUUID();
  return [instanceId, {...condition, instanceId}];
}));
