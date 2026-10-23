import type { ActiveCondition, MatchMode, UniverseType } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import {etfGroups} from '../data/etfFields';
import { PRESET_CATALOG } from '../data/presetCatalog';

/** Everything that defines a screen; results, pages and sessions are derived. */
export interface ScreenDefinition {
  universe: UniverseType;
  matchMode: MatchMode;
  conditions: Record<string, ActiveCondition>;
  query: string;
  sort: {field: string; direction: 'asc' | 'desc'};
}

export interface SavedScreen {
  id: string;
  name: string;
  savedAt: string;
  screen: ScreenDefinition;
}

export const SAVED_SCREENS_KEY = 'nexus-scanner.screener.saved-screens.v1';
export const SCREEN_URL_PARAM = 'screen';
export const MAX_SAVED_SCREENS = 50;
const SCREEN_URL_VERSION = 1;
const MAX_CONDITIONS = 40;
const MAX_QUERY_LENGTH = 500;
const MAX_NAME_LENGTH = 60;

// The Screener persists its working state in these keys; a loaded screen replaces them.
export const SCREEN_STORAGE_KEYS = {
  universe: 'nexus-scanner.screener.universe.v1',
  matchMode: 'nexus-scanner.screener.match-mode.v1',
  conditions: 'nexus-scanner.screener.conditions.v1',
  query: 'nexus-scanner.screener.query.v1',
  sort: 'nexus-scanner.screener.sort.v1',
  pagination: 'nexus-scanner.screener.pagination.v1',
  activeTab: 'nexus-scanner.ui.active-tab.v1',
} as const;

const SHAREABLE_UNIVERSES: readonly UniverseType[] = ['etf', 'mainboard', 'nifty50', 'nifty500', 'midsmall400'];
const KNOWN_CONDITIONS = new Set([...NEXUS_CONDITION_CATALOG, ...PRESET_CATALOG].map(def => def.id));
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isPrimitive = (value: unknown) => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));
const isParameterValue = (value: unknown) => isPrimitive(value) || (Array.isArray(value) && value.length <= 50 && value.every(isPrimitive));

function parseCondition(value: unknown): ActiveCondition | null {
  if (!isRecord(value) || typeof value.conditionId !== 'string' || !KNOWN_CONDITIONS.has(value.conditionId)
      || typeof value.instanceId !== 'string' || value.instanceId.length > 80 || !isRecord(value.parameters)) return null;
  const entries = Object.entries(value.parameters);
  if (entries.length > 30 || !entries.every(([key, item]) => key.length <= 60 && isParameterValue(item))) return null;
  return {
    instanceId: value.instanceId,
    conditionId: value.conditionId,
    parameters: Object.fromEntries(entries),
    ...(value.isNegated === true ? {isNegated: true} : {}),
  };
}

/** Accepts only well-formed screens built from catalog conditions; anything else is rejected. */
export function parseScreenDefinition(value: unknown): ScreenDefinition | null {
  if (!isRecord(value) || !isRecord(value.conditions) || !isRecord(value.sort)) return null;
  const universe = value.universe as UniverseType;
  if (!SHAREABLE_UNIVERSES.includes(universe)) return null;
  if (value.matchMode !== 'all' && value.matchMode !== 'any') return null;
  if (typeof value.query !== 'string' || value.query.length > MAX_QUERY_LENGTH) return null;
  const {field, direction} = value.sort;
  if (typeof field !== 'string' || !(/^[A-Za-z0-9_.]{1,60}$/.test(field) || field.startsWith('etf.') && etfGroups.some(group => group.fields.includes(field.slice(4)))) || (direction !== 'asc' && direction !== 'desc')) return null;
  const entries = Object.entries(value.conditions);
  if (entries.length > MAX_CONDITIONS) return null;
  const conditions: Record<string, ActiveCondition> = {};
  for (const [key, raw] of entries) {
    const condition = parseCondition(raw);
    if (!condition || key.length > 80) return null;
    conditions[key] = condition;
  }
  return {universe, matchMode: value.matchMode, conditions, query: value.query, sort: {field, direction}};
}

export function parseSavedScreens(value: unknown): SavedScreen[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.savedAt !== 'string') return [];
    const screen = parseScreenDefinition(item.screen);
    return screen ? [{id: item.id, name: item.name.slice(0, MAX_NAME_LENGTH), savedAt: item.savedAt, screen}] : [];
  }).slice(0, MAX_SAVED_SCREENS);
}

export function normalizeScreenName(name: string) {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/** Saves under a name, replacing an existing screen with the same name (case-insensitive). */
export function upsertSavedScreen(list: SavedScreen[], name: string, screen: ScreenDefinition, now = new Date()): SavedScreen[] {
  const clean = normalizeScreenName(name);
  if (!clean) return list;
  const existing = list.find(item => item.name.toLowerCase() === clean.toLowerCase());
  const entry: SavedScreen = {id: existing?.id ?? `screen-${now.getTime().toString(36)}-${list.length}`, name: clean, savedAt: now.toISOString(), screen};
  return [entry, ...list.filter(item => item !== existing)].slice(0, MAX_SAVED_SCREENS);
}

const toBase64Url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (text: string) => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
};

export function encodeScreen(screen: ScreenDefinition): string {
  return toBase64Url(JSON.stringify({v: SCREEN_URL_VERSION, ...screen}));
}

export function decodeScreen(param: string | null | undefined): ScreenDefinition | null {
  if (!param || param.length > 12_000 || !/^[A-Za-z0-9_-]+$/.test(param)) return null;
  try {
    const value: unknown = JSON.parse(fromBase64Url(param));
    if (!isRecord(value) || value.v !== SCREEN_URL_VERSION) return null;
    return parseScreenDefinition(value);
  } catch {
    return null;
  }
}

export function screenShareUrl(screen: ScreenDefinition, location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return `${location.origin}${location.pathname}?${SCREEN_URL_PARAM}=${encodeScreen(screen)}`;
}

/** Makes a screen the Screener's working state; the Screener reads these keys when it mounts. */
export function writeScreenToStorage(screen: ScreenDefinition, storage: Storage = window.localStorage): boolean {
  try {
    storage.setItem(SCREEN_STORAGE_KEYS.universe, JSON.stringify(screen.universe));
    storage.setItem(SCREEN_STORAGE_KEYS.matchMode, JSON.stringify(screen.matchMode));
    storage.setItem(SCREEN_STORAGE_KEYS.conditions, JSON.stringify(screen.conditions));
    storage.setItem(SCREEN_STORAGE_KEYS.query, JSON.stringify(screen.query));
    storage.setItem(SCREEN_STORAGE_KEYS.sort, JSON.stringify(screen.sort));
    storage.removeItem(SCREEN_STORAGE_KEYS.pagination);
    storage.setItem(SCREEN_STORAGE_KEYS.activeTab, JSON.stringify('screener'));
    return true;
  } catch {
    return false;
  }
}

/** Applies a shared `?screen=` link before the app renders, then removes it from the address bar. */
export function applySharedScreenFromUrl(
  location: Pick<Location, 'search' | 'pathname' | 'hash'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
  storage: Storage = window.localStorage,
): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has(SCREEN_URL_PARAM)) return false;
  const screen = decodeScreen(params.get(SCREEN_URL_PARAM));
  params.delete(SCREEN_URL_PARAM);
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  return screen ? writeScreenToStorage(screen, storage) : false;
}
