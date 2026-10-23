import { WATCHLIST_KEY, readChartStorage, validSymbol, writeChartStorage } from './storage';

/**
 * Named watchlists and colour flags. `watchlist.v2` always holds the active
 * list's items, so code that adds to "the watchlist" keeps working; the other
 * lists live in `watchlists.v1`. Flags are per symbol across all lists.
 */
export const LISTS_KEY = 'watchlists.v1';
export const FLAGS_KEY = 'watchlist-flags.v1';
const MAX_LISTS = 30;
const MAX_NAME = 40;

export const FLAG_COLORS = [
  {id: 'red', label: 'Red', color: '#f23645'},
  {id: 'orange', label: 'Orange', color: '#ff9800'},
  {id: 'green', label: 'Green', color: '#22ab94'},
  {id: 'blue', label: 'Blue', color: '#2962ff'},
  {id: 'purple', label: 'Purple', color: '#9c27b0'},
  {id: 'cyan', label: 'Cyan', color: '#00bcd4'},
  {id: 'pink', label: 'Pink', color: '#e91e63'},
] as const;
export type FlagColor = typeof FLAG_COLORS[number]['id'];
export const FLAG_BY_ID = new Map(FLAG_COLORS.map(flag => [flag.id, flag]));

export interface Watchlist { id: string; name: string; items: string[] }
export interface WatchlistStore { activeId: string; lists: Watchlist[] }
export type WatchlistFlags = Partial<Record<string, FlagColor>>;

const isItem = (item: unknown): item is string => typeof item === 'string' && (item.startsWith('###') ? item.length > 3 && item.length <= 83 : validSymbol(item));
const cleanItems = (value: unknown) => Array.isArray(value) ? value.filter(isItem) : [];
export const cleanListName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

export function loadWatchlistStore(): WatchlistStore {
  const raw = readChartStorage(LISTS_KEY) as Partial<WatchlistStore> | null;
  const lists = Array.isArray(raw?.lists)
    ? raw.lists.flatMap(list => list && typeof list.id === 'string' && typeof list.name === 'string'
      ? [{id: list.id, name: cleanListName(list.name) || 'Watchlist', items: cleanItems(list.items)}] : []).slice(0, MAX_LISTS)
    : [];
  if (!lists.length) lists.push({id: 'default', name: 'Watchlist', items: []});
  const activeId = lists.some(list => list.id === raw?.activeId) ? raw!.activeId! : lists[0].id;
  // The active list's items are owned by watchlist.v2.
  const active = cleanItems(readChartStorage(WATCHLIST_KEY));
  return {activeId, lists: lists.map(list => list.id === activeId ? {...list, items: active} : list)};
}

export function saveWatchlistStore(store: WatchlistStore): boolean {
  const active = activeList(store);
  return writeChartStorage(LISTS_KEY, store) && writeChartStorage(WATCHLIST_KEY, active.items);
}

export const activeList = (store: WatchlistStore) => store.lists.find(list => list.id === store.activeId) ?? store.lists[0];

export function withActiveItems(store: WatchlistStore, items: string[]): WatchlistStore {
  return {...store, lists: store.lists.map(list => list.id === store.activeId ? {...list, items} : list)};
}

export function createList(store: WatchlistStore, name: string, now = Date.now()): WatchlistStore {
  const clean = cleanListName(name);
  if (!clean || store.lists.length >= MAX_LISTS) return store;
  const id = `list-${now.toString(36)}-${store.lists.length}`;
  return {activeId: id, lists: [...store.lists, {id, name: clean, items: []}]};
}

export function renameList(store: WatchlistStore, id: string, name: string): WatchlistStore {
  const clean = cleanListName(name);
  return clean ? {...store, lists: store.lists.map(list => list.id === id ? {...list, name: clean} : list)} : store;
}

export function deleteList(store: WatchlistStore, id: string): WatchlistStore {
  if (store.lists.length <= 1) return {...store, lists: store.lists.map(list => ({...list, items: []}))};
  const lists = store.lists.filter(list => list.id !== id);
  return {activeId: store.activeId === id ? lists[0].id : store.activeId, lists};
}

export const switchList = (store: WatchlistStore, id: string): WatchlistStore =>
  store.lists.some(list => list.id === id) ? {...store, activeId: id} : store;

export function loadFlags(): WatchlistFlags {
  const raw = readChartStorage(FLAGS_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([symbol, color]) => validSymbol(symbol) && FLAG_BY_ID.has(color as FlagColor))) as WatchlistFlags;
}

export function setFlag(flags: WatchlistFlags, symbol: string, color: FlagColor | null): WatchlistFlags {
  const next = {...flags};
  if (color) next[symbol] = color; else delete next[symbol];
  return next;
}

export const flaggedSymbols = (flags: WatchlistFlags, color: FlagColor) =>
  Object.entries(flags).filter(([, value]) => value === color).map(([symbol]) => symbol);

/** Moves one item (symbol or section) to a new index; other items keep their order. */
export function moveItem(items: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}
