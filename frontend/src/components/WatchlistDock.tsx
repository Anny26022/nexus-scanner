import { memo, useState, useMemo, useCallback, useRef, useEffect, type RefObject, type Dispatch, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { prefetchCharts } from '../chart/chartQuery';
import {
  Search,
  X,
  Plus,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Bookmark,
  Trash2,
  Flag,
  Check,
  GripVertical,
} from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { screenerApi } from '../api/screenerApi';
import type { ChartRow } from '../api/realAdapter';
import { readChartStorage, writeChartStorage } from '../chart/storage';
import {
  FLAGS_KEY, FLAG_BY_ID, FLAG_COLORS, activeList, createList, deleteList, flaggedSymbols, loadFlags, loadWatchlistStore,
  moveItem, renameList, saveWatchlistStore, setFlag, switchList, withActiveItems, type FlagColor, type WatchlistFlags, type WatchlistStore,
} from '../chart/watchlists';
import { WatchlistMenu } from './WatchlistMenu';
import { useMountEffect } from '../hooks/useMountEffect';
import { SymbolWithLogo } from './SymbolWithLogo';
import { portalContainer, themeElement } from '../embedding';

const isSection = (item: string) => item.startsWith('###');
const sectionTitle = (item: string) => item.slice(3);

export function sanitizeSymbols(tokens: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    let clean = token.trim();
    if (!clean) continue;

    // Headings are parsed separately; this helper accepts symbols only.
    if (clean.startsWith('#') || clean.startsWith('//')) continue;

    // Strip surrounding quotes, brackets, parentheses
    clean = clean.replace(/^[([{"']+|[)\]}"',]+$/g, '');

    // Strip exchange prefixes: "NSE:", "BSE:", "MCX:", "INDEX:"
    clean = clean.replace(/^(NSE|BSE|MCX|INDEX):/i, '');

    // Strip exchange suffixes: ".NS", ".BO"
    clean = clean.replace(/\.(NS|BO)$/i, '');

    clean = clean.toUpperCase();

    // Verify valid Indian equity symbol pattern
    if (/^[A-Z0-9_&.\-]{1,30}$/.test(clean)) {
      if (!seen.has(clean)) {
        seen.add(clean);
        result.push(clean);
      }
    }
  }

  return result;
}

export function extractWatchlistItemsFromInput(raw: string): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];

  // 1. Try parsing JSON array format
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const found: string[] = [];
        for (const item of parsed) {
          if (typeof item === 'string') found.push(item);
          else if (item && typeof item === 'object' && typeof (item as any).symbol === 'string') {
            found.push((item as any).symbol);
          }
        }
        if (found.length > 0) return extractWatchlistItemsFromInput(found.join('\n'));
      }
    } catch {
      // not JSON, fallback to text tokens
    }
  }

  // Preserve ### headings from scanner/TradingView-style lists in their original order.
  const chunks = text.split(/\r?\n/).flatMap(line => {
    if (line.includes('\t')) return [line];
    if (!line.trimStart().startsWith('###')) return line.split(/[;,]/);
    // A heading may contain commas; split only where its symbol list begins.
    const split = line.match(/^(\s*###.*?\(\d+\))\s*[,;]\s*(.*)$/)
      ?? line.match(/^(\s*###.*?)[,;]\s*((?:(?:NSE|BSE|MCX|INDEX):|###).*)$/i);
    return split ? [split[1], ...split[2].split(/[;,]/)] : [line];
  });
  const items: string[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const line = chunk.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('###')) {
      const title = line.slice(3).trim().replace(/\s*\(\d+\)$/, '').trim();
      if (title) items.push(`###${title.slice(0, 80)}`);
      continue;
    }
    if (line.startsWith('#')) continue;

    // Tab-delimited (copied table rows)
    const tokens = line.includes('\t') ? [line.split('\t')[0]] : line.split(/\s+/);
    for (const token of tokens) {
      const symbol = sanitizeSymbols([token])[0];
      if (symbol && !seen.has(symbol)) {
        seen.add(symbol);
        items.push(symbol);
      }
    }
  }

  return items;
}

export function extractSymbolsFromInput(raw: string): string[] {
  return extractWatchlistItemsFromInput(raw).filter(item => !isSection(item));
}

export interface WatchlistDockProps {
  datasetRevision?: string;
  sessionDate?: string;
  activeSymbol?: string;
  onSelectSymbol: (symbol: string) => void;
  onClose?: () => void;
}

type SortColumn = 'symbol' | 'last' | 'changePct';
type SortDirection = 'asc' | 'desc';
const ROW_HEIGHT = 32;
const WIDTH_KEY = 'watchlist-width.v1';
const DEFAULT_WIDTH = 300;
const clampWidth = (width: number) => Math.round(Math.max(220, Math.min(560, width)));
const OVERSCAN = 6;

function useScrollToActiveItem(ref: RefObject<HTMLDivElement | null>, items: readonly string[], active: string | undefined, setTop: Dispatch<SetStateAction<number>>) {
  const previousActive = useRef(active);
  useEffect(() => {
    if (active === previousActive.current) return;
    previousActive.current = active;
    const index = active ? items.indexOf(active) : -1;
    const container = ref.current;
    if (!container || index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + ROW_HEIGHT > container.scrollTop + container.clientHeight)
      container.scrollTop = top + ROW_HEIGHT - container.clientHeight;
    setTop(container.scrollTop);
  }, [ref, items, active, setTop]);
}

export const WatchlistDock = memo(function WatchlistDock({
  datasetRevision,
  sessionDate,
  activeSymbol,
  onSelectSymbol,
  onClose,
}: WatchlistDockProps) {
  const [store, setStore] = useState<WatchlistStore>(loadWatchlistStore);
  const [width, setWidth] = useState(() => {
    const saved = readChartStorage(WIDTH_KEY);
    return typeof saved === 'number' && Number.isFinite(saved) ? clampWidth(saved) : DEFAULT_WIDTH;
  });
  // The expanded chart workspace also leaves room for the dock, so the width lives on the root too.
  const applyWidth = (next: number) => { setWidth(next); themeElement().style.setProperty('--watchlist-width', `${next}px`); };
  const saveWidth = (next: number) => { applyWidth(next); writeChartStorage(WIDTH_KEY, next); };
  useMountEffect(() => {
    const root = themeElement();
    root.style.setProperty('--watchlist-width', `${width}px`);
    return () => root.style.removeProperty('--watchlist-width');
  });
  // Dragging the left edge resizes the dock, like TradingView's right panel.
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    const move = (moveEvent: PointerEvent) => { latest = clampWidth(startWidth + startX - moveEvent.clientX); applyWidth(latest); };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      themeElement().classList.remove('is-resizing-dock');
      saveWidth(latest);
    };
    themeElement().classList.add('is-resizing-dock');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const storeChoice = useRef(store);
  const [flags, setFlags] = useState<WatchlistFlags>(loadFlags);
  // null shows the active named list; a colour shows that flag's list.
  const [view, setView] = useState<FlagColor | null>(null);
  const items = useMemo(() => view ? flaggedSymbols(flags, view) : activeList(store).items, [view, flags, store]);
  const commitStore = (next: WatchlistStore) => {
    storeChoice.current = next;
    setStore(next);
    saveWatchlistStore(next);
  };
  const updateFlags = (next: WatchlistFlags) => {
    setFlags(next);
    writeChartStorage(FLAGS_KEY, next);
  };
  const saveItems = (next: string[]) => {
    if (view) {
      // In a flag list, removing a symbol clears its flag.
      updateFlags(items.filter(item => !next.includes(item)).reduce((current, symbol) => setFlag(current, symbol, null), flags));
      return;
    }
    commitStore(withActiveItems(storeChoice.current, next));
  };
  const flagSymbol = (symbol: string, color: FlagColor | null) => updateFlags(setFlag(flags, symbol, color));
  const [drag, setDrag] = useState<{from: number; over: number} | null>(null);
  const [menuFor, setMenuFor] = useState<{symbol: string; x: number; y: number} | null>(null);
  const copyToList = (symbol: string, id: string) => commitStore({
    ...storeChoice.current,
    lists: storeChoice.current.lists.map(list => list.id === id && !list.items.includes(symbol) ? {...list, items: [...list.items, symbol]} : list),
  });
  const listTitle = view ? `${FLAG_BY_ID.get(view)!.label} list` : activeList(store).name;
  const symbols = useMemo(() => items.filter(item => !isSection(item)), [items]);

  // Search filter
  const [filterQuery, setFilterQuery] = useState('');

  // Sort state
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  // New symbol input state
  const [showAddForm, setShowAddForm] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [addSymbolInput, setAddSymbolInput] = useState('');
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');
  const previewItems = useMemo(() => extractWatchlistItemsFromInput(addSymbolInput), [addSymbolInput]);
  const previewSymbols = useMemo(() => previewItems.filter(item => !isSection(item)), [previewItems]);

  // Row and container DOM references for smooth keyboard navigation
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [localActiveSymbol, setLocalActiveSymbol] = useState<string | null>(activeSymbol ?? null);

  const currentEffectiveSymbol = activeSymbol ?? localActiveSymbol ?? undefined;
  const quoteSymbolsKey = useMemo(() => symbols.slice().sort().join(','), [symbols]);

  // Read every matched row from the pinned scanner snapshot, not just page one.
  const { data: quoteMap, isPending: quotesPending, isError: quotesError, refetch: retryQuotes } = useQuery({
    queryKey: ['watchlist-quotes-all', datasetRevision, quoteSymbolsKey, sessionDate],
    queryFn: async () => {
      if (!symbols.length) return new Map<string, ChartRow>();
      const rows = await screenerApi.getChartRows(datasetRevision, sessionDate);
      const selected = new Set(symbols);
      const map = new Map<string, ChartRow>();
      for (const row of rows) {
        if (selected.has(row.symbol)) map.set(row.symbol, row);
      }
      return map;
    },
    enabled: Boolean(datasetRevision && symbols.length > 0),
    staleTime: 60_000,
  });

  // Cycle column sorting: none -> desc -> asc -> none
  const toggleSort = useCallback((col: SortColumn) => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    setScrollTop(0);
    if (sortColumn !== col) {
      setSortColumn(col);
      setSortDir('desc');
    } else if (sortDir === 'desc') {
      setSortDir('asc');
    } else {
      setSortColumn(null);
    }
  }, [sortColumn, sortDir]);

  // Add symbol(s) to watchlist (supports single ticker or batch scanner output)
  const handleAddSymbols = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const extracted = extractWatchlistItemsFromInput(addSymbolInput);
    const pastedSymbols = extracted.filter(item => !isSection(item));
    if (extracted.length === 0) {
      setAddError('No valid symbols or headings found. Paste NSE:INFY or a ###Heading followed by symbols.');
      setAddSuccess('');
      return;
    }
    setAddError('');
    setView(null);
    const previous = activeList(storeChoice.current).items;
    const existing = new Set(previous.filter(item => !isSection(item)));
    const hasSections = extracted.some(isSection);
    const toAdd = pastedSymbols.filter(symbol => !existing.has(symbol));
    const pastedSet = new Set(pastedSymbols);
    const next = hasSections
      ? [...extracted, ...previous.filter(item => isSection(item) || !pastedSet.has(item))]
      : [...toAdd, ...previous];
    commitStore(withActiveItems(storeChoice.current, next));
    setAddSuccess(
      `Added ${toAdd.length} symbol${toAdd.length === 1 ? '' : 's'}${hasSections ? ` and ${extracted.length - pastedSymbols.length} heading${extracted.length - pastedSymbols.length === 1 ? '' : 's'}` : ''}${pastedSymbols.length > toAdd.length ? ` (${pastedSymbols.length - toAdd.length} already existed)` : ''}`
    );
    setAddSymbolInput('');
    setTimeout(() => {
      setAddSuccess('');
      setShowAddForm(false);
    }, 1200);
  };

  // Remove symbol from watchlist
  const handleRemoveSymbol = (sym: string, e: React.SyntheticEvent) => {
    e.stopPropagation();
    saveItems(items.filter(item => item !== sym));
  };

  // Clear entire list
  const handleClearEntireList = () => {
    saveItems([]);
  };

  // Sort within each section, so headings stay attached to their symbols.
  const filteredItems = useMemo(() => {
    const groups: {heading?: string; symbols: string[]}[] = [{symbols: []}];
    for (const item of items) {
      if (isSection(item)) groups.push({heading: item, symbols: []});
      else groups.at(-1)!.symbols.push(item);
    }
    const query = filterQuery.trim().toUpperCase();
    const compare = (a: string, b: string) => {
      const quoteA = quoteMap?.get(a);
      const quoteB = quoteMap?.get(b);
      if (sortColumn === 'symbol') {
        const diff = a.localeCompare(b);
        return sortDir === 'asc' ? diff : -diff;
      }
      const valueA = sortColumn === 'last' ? quoteA?.close : quoteA?.changePct;
      const valueB = sortColumn === 'last' ? quoteB?.close : quoteB?.changePct;
      const validA = typeof valueA === 'number' && Number.isFinite(valueA);
      const validB = typeof valueB === 'number' && Number.isFinite(valueB);
      if (validA !== validB) return validA ? -1 : 1;
      if (!validA || !validB) return 0;
      const diff = valueA - valueB;
      return sortDir === 'asc' ? diff : -diff;
    };
    return groups.flatMap(group => {
      const matchHeading = Boolean(query && group.heading?.toUpperCase().includes(query));
      const matches = group.symbols.filter(sym => {
        if (!query || matchHeading) return true;
        const quote = quoteMap?.get(sym);
        return sym.includes(query) || Boolean(quote?.name?.toUpperCase().includes(query));
      });
      if (sortColumn) matches.sort(compare);
      return group.heading && (!query || matches.length || matchHeading) ? [group.heading, ...matches] : matches;
    });
  }, [items, filterQuery, quoteMap, sortColumn, sortDir]);
  const filteredSymbols = useMemo(() => filteredItems.filter(item => !isSection(item)), [filteredItems]);
  const queryClient = useQueryClient();
  // Warm the next name once the selected chart has loaded.
  const selectSymbol = useCallback((symbol: string, direction: 1 | -1 = 1) => {
    onSelectSymbol(symbol);
    prefetchCharts(queryClient, filteredSymbols, symbol, datasetRevision, sessionDate, direction);
  }, [onSelectSymbol, queryClient, filteredSymbols, datasetRevision, sessionDate]);
  const sectionCounts = useMemo(() => {
    const counts = new Map<number, number>();
    let sectionIndex = -1;
    filteredItems.forEach((item, index) => {
      if (isSection(item)) {sectionIndex = index;counts.set(index, 0);}
      else if (sectionIndex >= 0) counts.set(sectionIndex, (counts.get(sectionIndex) ?? 0) + 1);
    });
    return counts;
  }, [filteredItems]);
  const unmatchedCount = useMemo(() => quoteMap ? symbols.filter(sym => !quoteMap.has(sym)).length : 0, [quoteMap, symbols]);

  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const startIndex = Math.max(0, Math.min(Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN, filteredItems.length - visibleCount));
  const visibleItems = filteredItems.slice(startIndex, startIndex + visibleCount);
  const scrollToRow = (index: number) => {
    const container = scrollContainerRef.current;
    if (!container || index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + ROW_HEIGHT > container.scrollTop + container.clientHeight)
      container.scrollTop = top + ROW_HEIGHT - container.clientHeight;
    setScrollTop(container.scrollTop);
  };
  // Drag-to-reorder only when the rows on screen are the list's own order.
  const canReorder = !view && !sortColumn && !filterQuery.trim();
  const dragProps = (rowIndex: number) => canReorder ? {
    draggable: true,
    onDragStart: (event: React.DragEvent) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', filteredItems[rowIndex]); setDrag({from: rowIndex, over: rowIndex}); },
    onDragOver: (event: React.DragEvent) => { if (!drag) return; event.preventDefault(); if (drag.over !== rowIndex) setDrag({...drag, over: rowIndex}); },
    onDrop: (event: React.DragEvent) => { event.preventDefault(); if (drag) saveItems(moveItem(items, drag.from, drag.over)); setDrag(null); },
    onDragEnd: () => setDrag(null),
  } : {};
  const dropClass = (rowIndex: number) => drag && drag.over === rowIndex && drag.from !== rowIndex ? (drag.from < rowIndex ? ' is-drop-after' : ' is-drop-before') : '';
  const resetScroll = () => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    setScrollTop(0);
  };
  const attachScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    if (!node) return;
    const measure = () => setViewportHeight(node.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useScrollToActiveItem(scrollContainerRef, filteredItems, currentEffectiveSymbol, setScrollTop);

  // Navigate through list via keyboard and immediately change active chart symbol
  const navigateSymbol = useCallback(
    (action: 'next' | 'prev' | 'first' | 'last' | 'jumpDown' | 'jumpUp') => {
      if (!filteredSymbols.length) return;
      const currentIdx = currentEffectiveSymbol ? filteredSymbols.indexOf(currentEffectiveSymbol) : -1;
      let nextIdx = 0;

      if (action === 'first') {
        nextIdx = 0;
      } else if (action === 'last') {
        nextIdx = filteredSymbols.length - 1;
      } else if (action === 'next') {
        nextIdx = currentIdx === -1 ? 0 : Math.min(filteredSymbols.length - 1, currentIdx + 1);
      } else if (action === 'prev') {
        nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
      } else if (action === 'jumpDown') {
        nextIdx = Math.min(filteredSymbols.length - 1, (currentIdx === -1 ? 0 : currentIdx) + 5);
      } else if (action === 'jumpUp') {
        nextIdx = Math.max(0, (currentIdx === -1 ? 0 : currentIdx) - 5);
      }

      const targetSym = filteredSymbols[nextIdx];
      if (targetSym) {
        setLocalActiveSymbol(targetSym);
        selectSymbol(targetSym, nextIdx < currentIdx ? -1 : 1);
        scrollToRow(filteredItems.indexOf(targetSym));
        requestAnimationFrame(() => rowRefs.current.get(targetSym)?.focus());
      }
    },
    [filteredSymbols, filteredItems, currentEffectiveSymbol, selectSymbol]
  );

  const handleContainerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      e.stopPropagation();
      navigateSymbol('next');
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      e.stopPropagation();
      navigateSymbol('prev');
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      navigateSymbol('first');
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      navigateSymbol('last');
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      e.stopPropagation();
      navigateSymbol('jumpDown');
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      e.stopPropagation();
      navigateSymbol('jumpUp');
    }
  };

  const renderSortIndicator = (col: SortColumn) => {
    if (sortColumn !== col) return <ArrowUpDown size={11} className="watchlist-sort-icon" />;
    return sortDir === 'asc' ? (
      <ArrowUp size={11} className="watchlist-sort-icon is-active" />
    ) : (
      <ArrowDown size={11} className="watchlist-sort-icon is-active" />
    );
  };

  return (
    <aside
      className={`chart-watchlist-dock${mobileOpen ? ' is-mobile-open' : ''}`}
      aria-label="Watchlist panel"
      style={{'--watchlist-width': `${width}px`} as React.CSSProperties}
    >
      <div
        className="watchlist-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize watchlist"
        aria-valuemin={220}
        aria-valuemax={560}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => saveWidth(DEFAULT_WIDTH)}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            saveWidth(clampWidth(width + (event.key === 'ArrowLeft' ? 16 : -16)));
          }
        }}
      />
      <button
        type="button"
        className="watchlist-mobile-toggle"
        aria-label={mobileOpen ? 'Close watchlist panel' : 'Open watchlist panel'}
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(open => !open)}
      >
        {mobileOpen ? <X size={16} /> : <Bookmark size={16} />}
      </button>
      {/* 1. Header with title, count badge, and actions */}
      <div className="watchlist-header">
        <div className="watchlist-title-group">
          <WatchlistMenu
            store={store} flags={flags} view={view} title={listTitle} count={filteredSymbols.length}
            onSwitch={id => { setView(null); resetScroll(); commitStore(switchList(storeChoice.current, id)); }}
            onView={flag => { setView(flag); resetScroll(); }}
            onCreate={name => { setView(null); resetScroll(); commitStore(createList(storeChoice.current, name)); }}
            onRename={name => commitStore(renameList(storeChoice.current, storeChoice.current.activeId, name))}
            onAddSection={name => commitStore(withActiveItems(storeChoice.current, [`###${name.trim().slice(0, 80)}`, ...activeList(storeChoice.current).items]))}
            onClear={handleClearEntireList}
            onDelete={() => storeChoice.current.lists.length > 1 ? commitStore(deleteList(storeChoice.current, storeChoice.current.activeId)) : handleClearEntireList()}
          />
        </div>
        <div className="watchlist-header-actions">
          <button
            type="button"
            className="watchlist-icon-btn"
            aria-label="Add symbol to watchlist"
            title="Add symbol to watchlist"
            onClick={() => {
              setShowAddForm(prev => !prev);
              setAddError('');
              setAddSuccess('');
            }}
          >
            <Plus size={16} />
          </button>
          {onClose && (
            <button
              type="button"
              className="watchlist-icon-btn"
              aria-label="Close watchlist"
              title="Close watchlist"
              onClick={onClose}
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Inline Add / Paste Symbol Form */}
      {showAddForm && (
        <form
          className="watchlist-add-form"
          onSubmit={handleAddSymbols}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setShowAddForm(false);
              setAddError('');
              setAddSuccess('');
            } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handleAddSymbols(e);
            }
          }}
        >
          <div className="watchlist-add-header">
            <span className="watchlist-add-heading">
              <Plus size={13} /> Add Symbols
            </span>
            <button
              type="button"
              className="watchlist-add-close-btn"
              onClick={() => {
                setShowAddForm(false);
                setAddError('');
                setAddSuccess('');
              }}
              title="Close"
              aria-label="Close add symbol form"
            >
              <X size={13} />
            </button>
          </div>

          <div className="watchlist-add-textarea-wrap">
            <textarea
              rows={2}
              placeholder="Add ticker or paste scanner output (e.g. NSE:TCS, RELIANCE, ###Sector...)"
              value={addSymbolInput}
              onChange={e => setAddSymbolInput(e.target.value)}
              autoFocus
              className="watchlist-add-textarea"
            />
          </div>

          {previewItems.length > 0 && (
            <div className="watchlist-add-preview">
              <div className="watchlist-add-preview-header">
                <span>{previewSymbols.length} symbol{previewSymbols.length === 1 ? '' : 's'}{previewItems.length > previewSymbols.length ? ` · ${previewItems.length - previewSymbols.length} heading${previewItems.length - previewSymbols.length === 1 ? '' : 's'}` : ''} ready to add:</span>
              </div>
              <div className="watchlist-add-chips">
                {previewItems.slice(0, 8).map((item, index) => (
                  <span key={`${item}-${index}`} className={`watchlist-chip ${isSection(item) ? 'is-heading' : ''}`}>
                    {isSection(item) ? sectionTitle(item) : item}
                  </span>
                ))}
                {previewItems.length > 8 && (
                  <span className="watchlist-chip is-more">+{previewItems.length - 8} more</span>
                )}
              </div>
            </div>
          )}

          <div className="watchlist-add-hint">
            Tip: Supports comma lists, NSE/BSE prefix, &amp; scanner exports.
          </div>

          {addError && (
            <div className="watchlist-feedback-pill is-error">
              <span>{addError}</span>
            </div>
          )}
          {addSuccess && (
            <div className="watchlist-feedback-pill is-success">
              <span>{addSuccess}</span>
            </div>
          )}

          <div className="watchlist-add-actions">
            <button
              type="button"
              className="watchlist-btn-secondary"
              onClick={() => {
                setShowAddForm(false);
                setAddError('');
                setAddSuccess('');
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="watchlist-btn-primary"
              disabled={previewItems.length === 0}
            >
              <Plus size={13} />
              <span>
                {previewItems.length > 0 ? 'Add to watchlist' : 'Add Symbols'}
              </span>
            </button>
          </div>
        </form>
      )}

      {/* 2. Top Filter Bar */}
      <div className="watchlist-filter-bar">
        <div className="watchlist-search-wrap">
          <Search size={14} className="watchlist-search-icon" />
          <input
            type="text"
            placeholder="Filter symbol..."
            value={filterQuery}
            onChange={e => { setFilterQuery(e.target.value); resetScroll(); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                navigateSymbol('first');
              } else if (e.key === 'Enter' && filteredSymbols.length > 0) {
                e.preventDefault();
                selectSymbol(filteredSymbols[0]);
              }
            }}
            className="watchlist-search-input"
            aria-label="Filter symbols"
          />
          {filterQuery && (
            <button
              type="button"
              className="watchlist-search-clear"
              onClick={() => { setFilterQuery(''); resetScroll(); }}
              title="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {symbols.length > 0 && (quotesError || quotesPending || unmatchedCount > 0) && (
        <div className="watchlist-quote-status" role="status">
          {quotesError ? <><span>Prices could not load.</span><button type="button" onClick={() => void retryQuotes()}>Retry</button></>
            : quotesPending ? <span>{datasetRevision ? 'Loading snapshot prices…' : 'Waiting for scanner snapshot…'}</span>
            : <span>{unmatchedCount.toLocaleString('en-IN')} symbol{unmatchedCount === 1 ? '' : 's'} not in this snapshot</span>}
        </div>
      )}

      {/* 3. Sortable Table Header - uses CSS grid matching rows for pixel-perfect vertical alignment */}
      <div className="watchlist-table-header" role="row">
        <button
          type="button"
          className={`watchlist-col-header col-symbol ${sortColumn === 'symbol' ? 'is-sorted' : ''}`}
          onClick={() => toggleSort('symbol')}
          title="Sort by Symbol"
        >
          <span>Symbol</span>
          {renderSortIndicator('symbol')}
        </button>
        <button
          type="button"
          className={`watchlist-col-header col-last ${sortColumn === 'last' ? 'is-sorted' : ''}`}
          onClick={() => toggleSort('last')}
          title="Sort by Last Traded Price"
        >
          <span>Last</span>
          {renderSortIndicator('last')}
        </button>
        <button
          type="button"
          className={`watchlist-col-header col-chg ${sortColumn === 'changePct' ? 'is-sorted' : ''}`}
          onClick={() => toggleSort('changePct')}
          title="Sort by Percentage Change"
        >
          <span>Chg %</span>
          {renderSortIndicator('changePct')}
        </button>
        <div className="watchlist-col-spacer" aria-hidden="true" />
      </div>

      {/* 4. Symbol Rows Scroll Area with full keyboard arrow navigation */}
      <div
        ref={attachScrollContainer}
        tabIndex={0}
        className="watchlist-content-scroll"
        role="table"
        aria-label="Watchlist stocks"
        onKeyDown={handleContainerKeyDown}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      >
        {filteredItems.length === 0 ? (
          <div className="watchlist-empty-state">
            {filterQuery ? (
              <p>No symbols match "{filterQuery}"</p>
            ) : (
              <>
                <p className="watchlist-empty-title">Your watchlist is empty</p>
                <p className="watchlist-empty-subtitle">
                  Click <strong>+</strong> above or paste your scanner output to add symbols.
                </p>
              </>
            )}
          </div>
        ) : (
          <div style={{height: filteredItems.length * ROW_HEIGHT, position: 'relative'}}>
          <div style={{position: 'absolute', top: startIndex * ROW_HEIGHT, left: 0, right: 0}}>
          {visibleItems.map((item, visibleIndex) => {
            if (isSection(item)) {
              const rowIndex = startIndex + visibleIndex;
              return (
                <div key={`section-${rowIndex}`} className={`watchlist-section-row${dropClass(rowIndex)}`} role="row" {...dragProps(rowIndex)}>
                  <div className="watchlist-section-header" role="cell">
                    {canReorder && <GripVertical size={12} className="watchlist-grip" aria-hidden="true" />}
                    <span className="watchlist-section-title">{sectionTitle(item)}</span>
                    <span className="watchlist-section-count">{sectionCounts.get(rowIndex) ?? 0}</span>
                    <span className="watchlist-section-rule" aria-hidden="true" />
                    {!view && <button type="button" className="watchlist-row-delete-btn" aria-label={`Remove section ${sectionTitle(item)}`} title="Remove section (keeps its symbols)"
                      onClick={() => saveItems(items.filter((_, index) => index !== items.indexOf(item)))}><X size={12} /></button>}
                  </div>
                </div>
              );
            }
            const sym = item;
            const quote = quoteMap?.get(sym);
            const lastPrice = quote?.close;
            const changePct = quote?.changePct;
            const unavailable = quoteMap ? 'Not in the current scanner snapshot' : quotesError ? 'Prices could not load' : 'Loading snapshot prices';
            const isUp = typeof changePct === 'number' && changePct >= 0;
            const isSelected = (currentEffectiveSymbol || activeSymbol) === sym;
            const rowIndex = startIndex + visibleIndex;
            const flag = flags[sym];

            return (
              <div
                key={sym}
                ref={el => {
                  if (el) rowRefs.current.set(sym, el);
                  else rowRefs.current.delete(sym);
                }}
                role="row"
                tabIndex={0}
                aria-selected={isSelected}
                className={`watchlist-row${isSelected ? ' is-selected' : ''}${dropClass(rowIndex)}`}
                style={flag ? {'--flag': FLAG_BY_ID.get(flag)!.color} as React.CSSProperties : undefined}
                {...dragProps(rowIndex)}
                onContextMenu={event => { event.preventDefault(); setMenuFor({symbol: sym, x: event.clientX, y: event.clientY}); }}
                onClick={() => {
                  setLocalActiveSymbol(sym);
                  selectSymbol(sym);
                }}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown' || e.key === 'j') {
                    e.preventDefault();
                    e.stopPropagation();
                    navigateSymbol('next');
                  } else if (e.key === 'ArrowUp' || e.key === 'k') {
                    e.preventDefault();
                    e.stopPropagation();
                    navigateSymbol('prev');
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    e.stopPropagation();
                    navigateSymbol('first');
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    e.stopPropagation();
                    navigateSymbol('last');
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    setLocalActiveSymbol(sym);
                    selectSymbol(sym);
                  } else if (e.altKey && e.code === 'KeyF') {
                    e.preventDefault();
                    e.stopPropagation();
                    flagSymbol(sym, flag ? null : 'red');
                  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenuFor({symbol: sym, x: rect.left + 24, y: rect.bottom});
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRemoveSymbol(sym, e);
                  }
                }}
              >
                {/* SYMBOL column with logo + symbol name */}
                <div className="watchlist-cell cell-symbol" role="cell">
                  <FlagPicker symbol={sym} flag={flag} onFlag={color => flagSymbol(sym, color)} />
                  <SymbolWithLogo symbol={sym} showText={false} size="sm" className="watchlist-symbol-logo" />
                  <span className="watchlist-symbol-name" title={sym}>{sym}</span>
                </div>

                {/* LAST price column */}
                <div className="watchlist-cell cell-last" role="cell">
                  {typeof lastPrice === 'number' ? (
                    <span className="watchlist-price-value">
                      {lastPrice.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  ) : (
                    <span className="watchlist-dash" title={unavailable}>{quoteMap ? 'No data' : '…'}</span>
                  )}
                </div>

                {/* CHG % column - sits directly aligned with CHG % header */}
                <div className="watchlist-cell cell-chg" role="cell">
                  {typeof changePct === 'number' ? (
                    <span className={`watchlist-chg-pill ${isUp ? 'is-up' : 'is-down'}`}>
                      {isUp ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`}
                    </span>
                  ) : (
                    <span className="watchlist-dash" title={unavailable}>{quoteMap ? '—' : '…'}</span>
                  )}
                </div>

                {/* Actions column: dedicated cell for delete button */}
                <div className="watchlist-cell cell-actions" role="cell">
                  <button
                    type="button"
                    className="watchlist-row-delete-btn"
                    aria-label={`Remove ${sym}`}
                    title={`Remove ${sym}`}
                    onClick={e => handleRemoveSymbol(sym, e)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
          </div>
          </div>
        )}
      </div>
      {menuFor && <WatchlistRowMenu
        {...menuFor}
        flag={flags[menuFor.symbol]}
        inList={!view}
        otherLists={store.lists.filter(list => view || list.id !== store.activeId)}
        onClose={() => setMenuFor(null)}
        onFlag={color => flagSymbol(menuFor.symbol, color)}
        onMove={where => {
          const from = items.indexOf(menuFor.symbol);
          saveItems(moveItem(items, from, where === 'top' ? 0 : items.length - 1));
        }}
        onCopy={id => copyToList(menuFor.symbol, id)}
        onRemove={() => saveItems(items.filter(item => item !== menuFor.symbol))}
      />}
    </aside>
  );
});

function FlagSwatches({flag, onFlag}: {flag?: FlagColor; onFlag: (color: FlagColor | null) => void}) {
  return <div className="watchlist-flag-swatches" role="group" aria-label="Flag colour">
    {FLAG_COLORS.map(option => <button key={option.id} type="button" className="watchlist-flag-swatch" aria-pressed={flag === option.id}
      aria-label={`${option.label} flag`} title={`${option.label} flag`} style={{'--flag': option.color} as React.CSSProperties}
      onClick={() => onFlag(flag === option.id ? null : option.id)} />)}
    <button type="button" className="watchlist-flag-swatch is-none" aria-label="Remove flag" title="Remove flag" disabled={!flag} onClick={() => onFlag(null)}><X size={11} /></button>
  </div>;
}

/** The flag in a row's gutter: shows the colour when set, a faint outline on hover otherwise. */
function FlagPicker({symbol, flag, onFlag}: {symbol: string; flag?: FlagColor; onFlag: (color: FlagColor | null) => void}) {
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" className={`watchlist-flag-btn${flag ? ' is-flagged' : ''}`} aria-label={flag ? `${symbol} flagged ${flag}, change flag` : `Flag ${symbol}`}
        title={flag ? 'Change flag' : 'Flag'} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <Flag size={11} fill={flag ? 'currentColor' : 'none'} />
      </button>
    </Popover.Trigger>
    <Popover.Portal container={portalContainer()}>
      <Popover.Content side="right" align="center" sideOffset={6} collisionPadding={12} className="watchlist-menu is-compact" onClick={event => event.stopPropagation()}>
        <FlagSwatches flag={flag} onFlag={color => { onFlag(color); setOpen(false); }} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

/** Right-click menu for a symbol row. */
function WatchlistRowMenu({symbol, x, y, flag, inList, otherLists, onClose, onFlag, onMove, onCopy, onRemove}: {
  symbol: string; x: number; y: number; flag?: FlagColor; inList: boolean;
  otherLists: {id: string; name: string; items: string[]}[];
  onClose: () => void;
  onFlag: (color: FlagColor | null) => void;
  onMove: (where: 'top' | 'bottom') => void;
  onCopy: (id: string) => void;
  onRemove: () => void;
}) {
  const act = (fn: () => void) => () => { fn(); onClose(); };
  return <Popover.Root open onOpenChange={next => { if (!next) onClose(); }}>
    <Popover.Anchor asChild><span style={{position: 'fixed', left: x, top: y, width: 0, height: 0}} /></Popover.Anchor>
    <Popover.Portal container={portalContainer()}>
      <Popover.Content align="start" side="bottom" sideOffset={2} collisionPadding={12} className="watchlist-menu" aria-label={`${symbol} actions`}>
        <div className="watchlist-menu-label">{symbol}</div>
        <FlagSwatches flag={flag} onFlag={color => { onFlag(color); onClose(); }} />
        <div className="watchlist-menu-divider" />
        {inList && <>
          <button type="button" className="watchlist-menu-row" onClick={act(() => onMove('top'))}><ArrowUp size={13} /><span className="watchlist-menu-name">Move to top</span></button>
          <button type="button" className="watchlist-menu-row" onClick={act(() => onMove('bottom'))}><ArrowDown size={13} /><span className="watchlist-menu-name">Move to bottom</span></button>
        </>}
        {otherLists.length > 0 && <>
          <div className="watchlist-menu-label">Add to list</div>
          {otherLists.map(list => <button key={list.id} type="button" className="watchlist-menu-row" disabled={list.items.includes(symbol)} onClick={act(() => onCopy(list.id))}>
            <span className="watchlist-menu-check">{list.items.includes(symbol) && <Check size={13} />}</span>
            <span className="watchlist-menu-name">{list.name}</span>
          </button>)}
        </>}
        <div className="watchlist-menu-divider" />
        <button type="button" className="watchlist-menu-row is-danger" onClick={act(onRemove)}>
          <Trash2 size={13} /><span className="watchlist-menu-name">{inList ? 'Remove from list' : 'Remove flag'}</span>
        </button>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
