import { memo, useState, useMemo, useCallback, useRef, useEffect, type RefObject, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  X,
  Plus,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Bookmark,
  Trash2,
  ChevronDown,
} from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import type { StockRow } from '../types/screener';
import { readChartStorage, writeChartStorage } from '../chart/storage';
import { SymbolWithLogo } from './SymbolWithLogo';

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
  const chunks = text.split(/\r?\n/).flatMap(line => line.includes('\t') ? [line] : line.split(/[;,]/));
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
  activeSymbol?: string;
  onSelectSymbol: (symbol: string) => void;
  onClose?: () => void;
}

type SortColumn = 'symbol' | 'last' | 'changePct';
type SortDirection = 'asc' | 'desc';
const ROW_HEIGHT = 40;
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
  activeSymbol,
  onSelectSymbol,
  onClose,
}: WatchlistDockProps) {
  const [items, setItems] = useState<string[]>(() => {
    const saved = readChartStorage('watchlist.v2');
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [];
  });
  const symbols = useMemo(() => items.filter(item => !isSection(item)), [items]);

  // Search filter
  const [filterQuery, setFilterQuery] = useState('');

  // Sort state
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  // New symbol input state
  const [showAddForm, setShowAddForm] = useState(false);
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
    queryKey: ['watchlist-quotes-all', datasetRevision, quoteSymbolsKey],
    queryFn: async () => {
      if (!symbols.length) return new Map<string, StockRow>();
      const rows = await screenerApi.getExportRows({
        datasetRevision,
        universe: 'custom',
        customSymbols: symbols,
        asOfDate: '',
        page: 1,
        pageSize: 100,
        expressionTree: { type: 'group', operator: 'all', children: [] },
      });
      const map = new Map<string, StockRow>();
      for (const row of rows) {
        map.set(row.symbol, row);
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
  const handleAddSymbols = (e: React.FormEvent) => {
    e.preventDefault();
    const extracted = extractWatchlistItemsFromInput(addSymbolInput);
    const pastedSymbols = extracted.filter(item => !isSection(item));
    if (extracted.length === 0) {
      setAddError('No valid symbols or headings found. Paste NSE:INFY or a ###Heading followed by symbols.');
      setAddSuccess('');
      return;
    }
    setAddError('');
    setItems(prev => {
      const existing = new Set(prev.filter(item => !isSection(item)));
      const hasSections = extracted.some(isSection);
      const toAdd = pastedSymbols.filter(symbol => !existing.has(symbol));
      const pastedSet = new Set(pastedSymbols);
      const next = hasSections
        ? [...extracted, ...prev.filter(item => isSection(item) || !pastedSet.has(item))]
        : [...toAdd, ...prev];
      writeChartStorage('watchlist.v2', next);
      setAddSuccess(
        `Added ${toAdd.length} symbol${toAdd.length === 1 ? '' : 's'}${hasSections ? ` and ${extracted.length - pastedSymbols.length} heading${extracted.length - pastedSymbols.length === 1 ? '' : 's'}` : ''}${pastedSymbols.length > toAdd.length ? ` (${pastedSymbols.length - toAdd.length} already existed)` : ''}`
      );
      return next;
    });
    setAddSymbolInput('');
    setTimeout(() => {
      setAddSuccess('');
      setShowAddForm(false);
    }, 1200);
  };

  // Remove symbol from watchlist
  const handleRemoveSymbol = (sym: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setItems(prev => {
      const next = prev.filter(s => s !== sym);
      writeChartStorage('watchlist.v2', next);
      return next;
    });
  };

  // Clear entire list
  const handleClearEntireList = () => {
    setItems([]);
    writeChartStorage('watchlist.v2', []);
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
        onSelectSymbol(targetSym);
        scrollToRow(filteredItems.indexOf(targetSym));
        requestAnimationFrame(() => rowRefs.current.get(targetSym)?.focus());
      }
    },
    [filteredSymbols, filteredItems, currentEffectiveSymbol, onSelectSymbol]
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
      className="chart-watchlist-dock"
      aria-label="Watchlist panel"
      onKeyDown={handleContainerKeyDown}
    >
      {/* 1. Header with title, count badge, and actions */}
      <div className="watchlist-header">
        <div className="watchlist-title-group">
          <Bookmark size={15} className="watchlist-title-icon" />
          <h2 className="watchlist-title">Watchlist</h2>
          <span className="watchlist-badge" title={`${filteredSymbols.length} symbols`}>
            {filteredSymbols.length}
          </span>
          <details className="watchlist-menu-dropdown">
            <summary
              className="watchlist-dropdown-trigger"
              aria-label="Watchlist options"
              title="Watchlist options"
            >
              <ChevronDown size={12} />
            </summary>
            <div className="watchlist-dropdown-menu">
              <button
                type="button"
                className="watchlist-menu-item is-danger"
                disabled={items.length === 0}
                onClick={e => {
                  (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                  handleClearEntireList();
                }}
              >
                <Trash2 size={13} />
                <span>Clear entire list</span>
              </button>
            </div>
          </details>
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
              handleAddSymbols(e as any);
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
                onSelectSymbol(filteredSymbols[0]);
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
          <span>SYMBOL</span>
          {renderSortIndicator('symbol')}
        </button>
        <button
          type="button"
          className={`watchlist-col-header col-last ${sortColumn === 'last' ? 'is-sorted' : ''}`}
          onClick={() => toggleSort('last')}
          title="Sort by Last Traded Price"
        >
          <span>LAST</span>
          {renderSortIndicator('last')}
        </button>
        <button
          type="button"
          className={`watchlist-col-header col-chg ${sortColumn === 'changePct' ? 'is-sorted' : ''}`}
          onClick={() => toggleSort('changePct')}
          title="Sort by Percentage Change"
        >
          <span>CHG %</span>
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
                <div key={`section-${rowIndex}`} className="watchlist-section-row" role="row">
                  <div className="watchlist-section-header" role="cell">
                    <span className="watchlist-section-title">{sectionTitle(item)}</span>
                    <span className="watchlist-section-count">{sectionCounts.get(rowIndex) ?? 0}</span>
                    <span className="watchlist-section-rule" aria-hidden="true" />
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
                className={`watchlist-row ${isSelected ? 'is-selected' : ''}`}
                onClick={() => {
                  setLocalActiveSymbol(sym);
                  onSelectSymbol(sym);
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
                    onSelectSymbol(sym);
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRemoveSymbol(sym, e as any);
                  }
                }}
              >
                {/* SYMBOL column with logo + symbol name */}
                <div className="watchlist-cell cell-symbol" role="cell">
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
    </aside>
  );
});
