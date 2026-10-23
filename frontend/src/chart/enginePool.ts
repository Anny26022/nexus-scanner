import type { ChartEngine } from './ChartEngine';

/**
 * Keeps each chart tile's engine alive across symbol and interval switches. A scene parks its engine when it
 * unmounts, and the tile's next scene adopts it, so a switch replaces data instead of destroying and
 * rebuilding every pane and series. An engine nobody adopts (the tile closed, the tab changed) is destroyed.
 */
const IDLE_MS = 15_000; // covers loading the next symbol's data on a slow connection
const parked = new Map<string, {engine: ChartEngine; host: HTMLDivElement; timer: ReturnType<typeof setTimeout>}>();

export function parkEngine(tile: string, engine: ChartEngine, host: HTMLDivElement) {
  // Test doubles and older engines without adoption are simply destroyed.
  if (typeof engine.adopt !== 'function' || typeof engine.park !== 'function') { engine.destroy(); host.remove(); return; }
  const previous = parked.get(tile);
  if (previous && previous.engine !== engine) { clearTimeout(previous.timer); previous.engine.destroy(); previous.host.remove(); }
  engine.park();
  host.remove();
  const timer = setTimeout(() => {
    if (parked.get(tile)?.engine !== engine) return;
    parked.delete(tile);
    engine.destroy();
  }, IDLE_MS);
  parked.set(tile, {engine, host, timer});
}

/** The tile's parked engine and its canvas host, if one is waiting. */
export function adoptEngine(tile: string) {
  const entry = parked.get(tile);
  if (!entry) return null;
  clearTimeout(entry.timer);
  parked.delete(tile);
  return {engine: entry.engine, host: entry.host};
}
