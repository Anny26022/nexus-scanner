import {
  parseWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspacePayload,
  type WorkspaceSlot,
  type WorkspacePane,
} from 'openalgo-charts/workspace';
import { DrawingBook, anchors, validDrawing, validDrawingStyle, type DrawingStyleMemory } from './drawings';
import { validEmaLine, type EmaLine, type Interval } from './model';
import { defaultStudies, type ChartStudies } from './studies';
import type { ChartAppearance, ChartStyle } from './ChartEngine';
import { chartLayout, CHART_LAYOUTS, MAX_CHARTS, type SyncOptions } from './layouts';

import { readStored, removeStored, storageHealth, writeStored } from '../storage/store';

/** Chart preferences share the app's one storage module, under their own prefix. */
export const CHART_PREFIX = 'nexus.chart.';
export const chartStorage = storageHealth;

export function readChartStorage(key: string): unknown {
  return readStored<unknown>(CHART_PREFIX + key, null);
}

export function writeChartStorage(key: string, value: unknown): boolean {
  return writeStored(CHART_PREFIX + key, value);
}

export function removeChartStorage(key: string): void {
  removeStored(CHART_PREFIX + key);
}

export const validSymbol = (symbol: unknown): symbol is string =>
  typeof symbol === 'string' && /^[A-Z0-9_&.\-]{1,40}$/.test(symbol);

export const WATCHLIST_KEY = 'watchlist.v2';

/** Appends unseen symbols to the watchlist, optionally under a `###` section heading. */
export function addSymbolsToWatchlist(symbols: readonly string[], heading?: string): {added: number; total: number} | null {
  const stored = readChartStorage(WATCHLIST_KEY);
  const items = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [];
  const existing = new Set(items.filter(item => !item.startsWith('###')));
  const fresh = [...new Set(symbols.map(symbol => symbol.trim().toUpperCase()))].filter(symbol => validSymbol(symbol) && !existing.has(symbol));
  const total = existing.size + fresh.length;
  if (!fresh.length) return {added: 0, total};
  const section = heading ? `###${heading.slice(0, 80)}` : undefined;
  const next = [...items, ...(section && !items.includes(section) ? [section] : []), ...fresh];
  return writeChartStorage(WATCHLIST_KEY, next) ? {added: fresh.length, total} : null;
}

export type TileSettings = { symbol: string; interval: Interval };
export type GridSettings = { count: number; layout: string; links: SyncOptions; tiles: TileSettings[] };

export function loadGrid(input: unknown = readChartStorage('grid.v1')): GridSettings {
  const defaults: GridSettings = {
    count: 1,
    layout: '1',
    links: { dates: false, crosshair: false, symbol: false, interval: false },
    tiles: ['RELIANCE','TCS','INFY','HDFCBANK','SBIN','ITC','LT','MARUTI','AXISBANK','ICICIBANK','BHARTIARTL','HINDUNILVR','KOTAKBANK','SUNPHARMA','TATASTEEL','WIPRO'].map(symbol => ({ symbol, interval: 'D' }))
  };
  const raw = input as Partial<GridSettings> & { linked?: boolean } | null;
  if (!raw || !Array.isArray(raw.tiles) || ![4, 8, MAX_CHARTS].includes(raw.tiles.length) || !raw.tiles.every(tile => tile && validSymbol(tile.symbol) && ['D', 'W', 'M'].includes(tile.interval))) {
    return defaults;
  }
  const layout = raw.layout && CHART_LAYOUTS.some(l => l.id === raw.layout)
    ? raw.layout
    : raw.count === 2 ? '2H' : raw.count === 4 ? '4G' : '1';
  const links = { ...defaults.links, dates: raw.linked === true, crosshair: raw.linked === true };
  if (raw.links) {
    for (const key of Object.keys(links) as (keyof SyncOptions)[]) {
      if (typeof raw.links[key] === 'boolean') links[key] = raw.links[key];
    }
  }
  return { layout, count: chartLayout(layout).count, links, tiles: [...raw.tiles, ...defaults.tiles.slice(raw.tiles.length)] };
}

/** Points the first chart tile at a symbol; the Charts tab reads it when it opens. */
export function openSymbolInCharts(symbol: string): boolean {
  if (!validSymbol(symbol)) return false;
  const grid = loadGrid();
  return writeChartStorage('grid.v1', {...grid, tiles: [{...grid.tiles[0], symbol}, ...grid.tiles.slice(1)]});
}

import type { StudyConfigs } from './studyConfigs';

export type SceneSettings = {
  style: ChartStyle;
  appearance: ChartAppearance;
  studies: ChartStudies;
  studyConfigs?: StudyConfigs;
  emaLines: EmaLine[];
  range?: number | null;
  comparison?: { symbol: string; separate: boolean } | null;
  view?: { from: string; to: string };
  paneWeights?: number[];
};

export function loadScene(id: string, input: unknown = readChartStorage(`scene.${id}.v1`)): Partial<SceneSettings> {
  const raw = input as Partial<SceneSettings> | null;
  if (!raw || typeof raw !== 'object') return {};
  const result: Partial<SceneSettings> = {};
  if (['candles', 'hollowCandles', 'volumeCandles', 'bars', 'highLow', 'line', 'lineWithMarkers', 'stepLine', 'area', 'hlcArea', 'baseline'].includes(raw.style!)) result.style = raw.style;
  if (Array.isArray(raw.emaLines) && raw.emaLines.length <= 5 && raw.emaLines.every(validEmaLine) && new Set(raw.emaLines.map(line => line.id)).size === raw.emaLines.length) result.emaLines = raw.emaLines;
  if (raw.studies && typeof raw.studies === 'object') result.studies = Object.fromEntries(Object.keys(defaultStudies()).map(key => [key, raw.studies![key as keyof ChartStudies] === true])) as ChartStudies;
  if (raw.studyConfigs && typeof raw.studyConfigs === 'object') result.studyConfigs = raw.studyConfigs;
  // Missing basics take their defaults, so one absent flag never discards the user's colours and other choices.
  const a = raw.appearance && typeof raw.appearance === 'object'
    ? {horizontalGrid: false, verticalGrid: false, crosshair: true, volume: true, scaleMode: 'normal' as const, ...(raw.appearance as Partial<ChartAppearance>)} as ChartAppearance : undefined;
  if (a && ['normal', 'logarithmic', 'percentage', 'indexed'].includes(a.scaleMode) && ['horizontalGrid', 'verticalGrid', 'crosshair', 'volume'].every(key => typeof a[key as keyof ChartAppearance] === 'boolean')
    && (a.crosshairMode === undefined || ['normal', 'magnet', 'ohlc'].includes(a.crosshairMode)) && ['volumePane', 'events', 'conflation'].every(key => a[key as keyof ChartAppearance] === undefined || typeof a[key as keyof ChartAppearance] === 'boolean')) result.appearance = a;
  if (raw.range === null || [1, 3, 6, 12, 24].includes(raw.range!)) result.range = raw.range;
  if (raw.comparison === null || (raw.comparison && validSymbol(raw.comparison.symbol) && typeof raw.comparison.separate === 'boolean')) result.comparison = raw.comparison;
  const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (raw.view && date(raw.view.from) && date(raw.view.to) && raw.view.from <= raw.view.to) result.view = raw.view;
  if (Array.isArray(raw.paneWeights) && raw.paneWeights.length <= 10 && raw.paneWeights.every(value => Number.isFinite(value) && value > 0 && value <= 100)) result.paneWeights = raw.paneWeights;
  return result;
}

export interface SavedLayout {
  id: string;
  name: string;
  grid: GridSettings;
  scenes: Partial<SceneSettings>[];
  createdAt: number;
  updatedAt: number;
}

/** Converts Nexus grid & scenes to a standard OpenAlgo Workspace Document. */
export function gridToWorkspaceDocument(name: string, grid: GridSettings, scenes: Partial<SceneSettings>[], id?: string): WorkspaceDocument {
  const now = Date.now();
  const docId = id ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ws-${now}-${Math.random().toString(36).slice(2, 8)}`);
  const layoutDef = chartLayout(grid.layout);
  const rows = layoutDef.rows.map(r => r.split(' '));
  const slots: WorkspaceSlot[] = [];

  for (let index = 0; index < grid.count; index++) {
    const key = String.fromCharCode(97 + index);
    const cells = rows.flatMap((row, y) => row.flatMap((cell, x) => cell === key ? [{ x, y }] : []));
    if (cells.length > 0) {
      const minX = Math.min(...cells.map(c => c.x));
      const maxX = Math.max(...cells.map(c => c.x));
      const minY = Math.min(...cells.map(c => c.y));
      const maxY = Math.max(...cells.map(c => c.y));
      slots.push({
        paneId: `pane-${index}`,
        row: minY,
        column: minX,
        rowSpan: maxY - minY + 1,
        columnSpan: maxX - minX + 1,
      });
    }
  }

  const panes: WorkspacePane[] = grid.tiles.slice(0, grid.count).map((tile, index) => {
    const scene = scenes[index] ?? {};
    return {
      id: `pane-${index}`,
      symbol: tile.symbol,
      exchange: 'NSE',
      interval: tile.interval,
      chartType: scene.style ?? 'candles',
      chart: { version: 1 },
      settings: {
        studies: JSON.stringify(scene.studies ?? {}),
        studyConfigs: JSON.stringify(scene.studyConfigs ?? {}),
        appearance: JSON.stringify(scene.appearance ?? {}),
        emaLines: JSON.stringify(scene.emaLines ?? []),
        range: scene.range === undefined ? 'custom' : scene.range === null ? 'all' : scene.range,
        comparison: JSON.stringify(scene.comparison ?? null),
        view: JSON.stringify(scene.view ?? null),
        paneWeights: JSON.stringify(scene.paneWeights ?? []),
      },
      volume: scene.appearance?.volume ?? true,
      magnet: scene.appearance?.crosshairMode === 'magnet' ? 'strong' : 'off',
      stay: false,
      comparisons: scene.comparison ? [{
        id: scene.comparison.symbol,
        symbol: scene.comparison.symbol,
        exchange: 'NSE',
        visible: true,
      }] : [],
      comparisonMode: 'price',
    };
  });

  const payload: WorkspacePayload = {
    layout: {
      rows: layoutDef.rows.length,
      columns: layoutDef.columns,
      slots,
      preset: grid.layout,
    },
    panes,
    activePaneId: 'pane-0',
    sync: {
      crosshair: grid.links.crosshair,
      viewport: grid.links.dates,
      symbol: grid.links.symbol,
      interval: grid.links.interval,
    },
  };

  return {
    kind: 'workspace',
    version: 1,
    id: docId,
    name,
    createdAt: now,
    updatedAt: now,
    ...payload,
  };
}

function parseSetting(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Parses an OpenAlgo Workspace Document back into a Nexus SavedLayout. */
export function workspaceDocumentToLayout(doc: unknown): SavedLayout | null {
  try {
    const parsed = parseWorkspaceDocument(doc);
    const layout = parsed.layout.preset && CHART_LAYOUTS.some(l => l.id === parsed.layout.preset)
      ? parsed.layout.preset
      : '1';
    const count = chartLayout(layout).count;
    const defaults = loadGrid();
    const tiles: TileSettings[] = Array.from({ length: MAX_CHARTS }, (_, index) => {
      const pane = parsed.panes[index];
      if (pane && validSymbol(pane.symbol) && ['D', 'W', 'M'].includes(pane.interval)) {
        return { symbol: pane.symbol, interval: pane.interval as Interval };
      }
      return defaults.tiles[index];
    });

    const scenes: Partial<SceneSettings>[] = Array.from({ length: MAX_CHARTS }, (_, index) => {
      const pane = parsed.panes[index];
      if (!pane) return {};
      const s = pane.settings || {};
      const scene: Partial<SceneSettings> = {};
      if (['candles', 'hollowCandles', 'volumeCandles', 'bars', 'highLow', 'line', 'lineWithMarkers', 'stepLine', 'area', 'hlcArea', 'baseline'].includes(pane.chartType)) {
        scene.style = pane.chartType as ChartStyle;
      }
      scene.studies = parseSetting(s.studies) as ChartStudies;
      scene.studyConfigs = parseSetting(s.studyConfigs) as StudyConfigs;
      scene.appearance = parseSetting(s.appearance) as ChartAppearance;
      scene.emaLines = parseSetting(s.emaLines) as EmaLine[];
      if (s.range === 'all' || s.range === -1) scene.range = null;
      else if (typeof s.range === 'number') scene.range = s.range;
      scene.comparison = parseSetting(s.comparison) as SceneSettings['comparison'];
      scene.view = parseSetting(s.view) as SceneSettings['view'];
      scene.paneWeights = parseSetting(s.paneWeights) as number[];
      return loadScene('', scene);
    });

    return {
      id: parsed.id,
      name: parsed.name,
      grid: {
        count,
        layout,
        links: {
          dates: parsed.sync.viewport,
          crosshair: parsed.sync.crosshair,
          symbol: parsed.sync.symbol,
          interval: parsed.sync.interval,
        },
        tiles,
      },
      scenes,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

const WORKSPACE_STORAGE_KEY = 'workspaces.v2';

export function loadNamedLayouts(): SavedLayout[] {
  const raw = readChartStorage(WORKSPACE_STORAGE_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(doc => workspaceDocumentToLayout(doc))
    .filter((layout): layout is SavedLayout => layout !== null && layout.name.length > 0 && layout.name.length <= 40)
    .slice(0, 10);
}

export function saveNamedLayouts(layouts: SavedLayout[]): boolean {
  const docs = layouts.map(layout =>
    gridToWorkspaceDocument(layout.name, layout.grid, layout.scenes, layout.id)
  );
  return writeChartStorage(WORKSPACE_STORAGE_KEY, docs);
}

export function exportWorkspaceDocumentJson(layout: SavedLayout): string {
  const doc = gridToWorkspaceDocument(layout.name, layout.grid, layout.scenes, layout.id);
  return JSON.stringify(doc, null, 2);
}

export function importWorkspaceDocumentJson(jsonString: string): SavedLayout | null {
  try {
    const raw = JSON.parse(jsonString);
    return workspaceDocumentToLayout(raw);
  } catch {
    return null;
  }
}

const books = new Map<string, DrawingBook>();
const STYLE_KEY = 'drawing-styles.v1';
/** The colour, width and dash last chosen for each drawing tool, applied to the next drawing of that kind. */
export const drawingStyles: DrawingStyleMemory = {
  get: kind => {
    const saved = (readChartStorage(STYLE_KEY) as Record<string, unknown> | null)?.[kind];
    return validDrawingStyle(saved) ? saved : undefined;
  },
  set: (kind, style) => {
    const all = readChartStorage(STYLE_KEY);
    writeChartStorage(STYLE_KEY, {...(all && typeof all === 'object' ? all : {}), [kind]: style});
  },
};
export function savedDrawingBook(symbol: string): DrawingBook {
  let book = books.get(symbol);
  if (!book) {
    const stored = readChartStorage(`drawings.${symbol}.v2`);
    const raw = (stored as { version?: unknown; drawings?: unknown } | null)?.version === 2
      ? (stored as { drawings: unknown }).drawings
      : null;
    const drawings = Array.isArray(raw) && raw.length <= 500 && raw.every(validDrawing) && new Set(raw.map(d => d.id)).size === raw.length
      ? raw.map(d => ({ ...d, version: 2 as const, points: [...anchors(d)] }))
      : [];
    // A symbol with no drawings keeps no key, so storage does not fill with empty books.
    book = new DrawingBook(drawings, d => d.length ? writeChartStorage(`drawings.${symbol}.v2`, { version: 2, drawings: d })
      : removeChartStorage(`drawings.${symbol}.v2`), drawingStyles);
    books.set(symbol, book);
  }
  return book;
}
