/**
 * The one place the app reads and writes browser storage.
 *
 * Every preference lives in localStorage as JSON under a versioned key. Readers of the same key share
 * one parsed value and are notified of every write, from this tab or another, so two components can never hold
 * diverging copies or overwrite each other with stale state. Market data never lives here: it stays in immutable
 * snapshots (worker memory) and the TanStack Query cache. React components use `useStoredState`; this file stays
 * free of React so the small startup entry can read preferences too.
 */
type Listener = () => void;
const keyListeners = new Map<string, Set<Listener>>();
const allListeners = new Set<Listener>();
// Parsed values memoised by their raw text, so a snapshot is stable until the stored text itself changes.
const parsed = new Map<string, {raw: string; value: unknown}>();
// Values the browser refused to store (private mode, quota): kept for this page so the app keeps working.
const unsaved = new Map<string, unknown>();

const storage = (): Storage | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};
const rawOf = (key: string): string | null => {
  try { return storage()?.getItem(key) ?? null; } catch { return null; }
};
const notify = (key: string | null) => {
  for (const listener of key === null ? [...keyListeners.values()].flatMap(set => [...set]) : keyListeners.get(key) ?? []) listener();
  for (const listener of allListeners) listener();
};

let warning = '';
const healthListeners = new Set<Listener>();
const setWarning = (next: string) => {
  if (next === warning) return;
  warning = next;
  for (const listener of healthListeners) listener();
};
/** Empty while saving works; a sentence for the user when the browser refuses writes. */
export const storageHealth = {
  subscribe: (listener: Listener) => { healthListeners.add(listener); return () => { healthListeners.delete(listener); }; },
  getSnapshot: () => warning,
};

/** The stored value, or `fallback` when the key is missing or unreadable. Never throws. */
export function readStored<T>(key: string, fallback: T): T {
  if (unsaved.has(key)) return unsaved.get(key) as T;
  const raw = rawOf(key);
  if (raw === null) return fallback;
  const memo = parsed.get(key);
  if (memo?.raw === raw) return memo.value as T;
  try {
    const value = JSON.parse(raw) as unknown;
    parsed.set(key, {raw, value});
    return value as T;
  } catch {
    return fallback;
  }
}

/** Stores `value` as JSON and tells every reader. Returns false when the browser refuses the write. */
export function writeStored(key: string, value: unknown): boolean {
  const target = storage();
  try {
    if (!target) throw new Error('Storage unavailable');
    const raw = JSON.stringify(value);
    if (target.getItem(key) !== raw) target.setItem(key, raw);
    unsaved.delete(key);
    setWarning('');
    notify(key);
    return true;
  } catch {
    unsaved.set(key, value);
    setWarning('Browser storage is unavailable or full. Changes are not being saved.');
    notify(key);
    return false;
  }
}

export function removeStored(key: string): void {
  try { storage()?.removeItem(key); } catch { /* nothing stored to remove */ }
  parsed.delete(key);
  unsaved.delete(key);
  notify(key);
}

export function subscribeStored(key: string, listener: Listener): () => void {
  const set = keyListeners.get(key) ?? new Set();
  set.add(listener);
  keyListeners.set(key, set);
  return () => { set.delete(listener); if (!set.size) keyListeners.delete(key); };
}

// Another tab wrote, removed or cleared storage: refresh the readers of what changed.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.storageArea && event.storageArea !== storage()) return;
    if (event.key === null) parsed.clear(); else parsed.delete(event.key);
    notify(event.key);
  });
}
