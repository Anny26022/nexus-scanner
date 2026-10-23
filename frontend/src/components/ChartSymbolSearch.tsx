import { useId, useImperativeHandle, useMemo, useState, type Ref } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Clock, CornerDownLeft, Search } from 'lucide-react';
import { WATCHLIST_KEY, readChartStorage, validSymbol, writeChartStorage } from '../chart/storage';
import { rankSymbols, useSymbolDirectory, type SymbolEntry } from '../hooks/useSymbolDirectory';
import { SymbolWithLogo } from './SymbolWithLogo';

const RECENTS_KEY = 'recent-symbols.v1';
const MAX_RECENTS = 8;
const MAX_RESULTS = 50;
const WATCHLIST_ROWS = 12;

function readRecents(): string[] {
  const stored = readChartStorage(RECENTS_KEY);
  return Array.isArray(stored) ? stored.filter(validSymbol).slice(0, MAX_RECENTS) : [];
}

export interface ChartSymbolSearchHandle {
  /** Opens the palette, optionally with the first typed character already in the box. */
  open: (initial?: string) => void;
}

type Row = SymbolEntry & {recent?: boolean};

/** Toolbar symbol button that opens a command-palette symbol search. */
export function ChartSymbolSearch({symbol, datasetRevision, sessionDate, onSelect, onError, handleRef}: {
  symbol: string;
  datasetRevision?: string;
  sessionDate?: string;
  onSelect: (symbol: string) => void;
  onError: (message: string) => void;
  handleRef?: Ref<ChartSymbolSearchHandle>;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const directory = useSymbolDirectory(datasetRevision, sessionDate, open);
  const entries = directory.data ?? [];
  const names = useMemo(() => new Map(entries.map(entry => [entry.symbol, entry.name])), [entries]);
  const query = draft.trim();

  // Typing shows ranked matches; an empty box shows recents, then the active watchlist.
  const groups = useMemo((): {label: string; rows: Row[]}[] => {
    if (query) return [{label: 'Symbols', rows: rankSymbols(entries, query, MAX_RESULTS)}];
    const recents = readRecents().filter(item => item !== symbol);
    const stored = readChartStorage(WATCHLIST_KEY);
    const watchlist = (Array.isArray(stored) ? stored : []).filter((item): item is string => typeof item === 'string' && validSymbol(item))
      .filter(item => item !== symbol && !recents.includes(item)).slice(0, WATCHLIST_ROWS);
    return [
      {label: 'Recent', rows: recents.map(item => ({symbol: item, name: names.get(item) ?? '', recent: true}))},
      {label: 'Watchlist', rows: watchlist.map(item => ({symbol: item, name: names.get(item) ?? ''}))},
    ].filter(group => group.rows.length);
  }, [query, entries, names, symbol, open]);
  const rows = groups.flatMap(group => group.rows);
  const selected = Math.min(active, Math.max(rows.length - 1, 0));

  const show = (initial = '') => { setDraft(initial); setActive(0); setError(''); setOpen(true); };
  useImperativeHandle(handleRef, () => ({open: show}));
  const close = () => { setOpen(false); setDraft(''); setError(''); };

  const choose = (next: string) => {
    const clean = next.trim().toUpperCase();
    if (!validSymbol(clean)) {
      const message = 'Enter a scanner symbol, such as RELIANCE.';
      setError(message); onError(message); return;
    }
    onError('');
    writeChartStorage(RECENTS_KEY, [clean, ...readRecents().filter(item => item !== clean)].slice(0, MAX_RECENTS));
    close();
    onSelect(clean);
  };
  const move = (delta: number) => {
    if (!rows.length) return;
    const next = (selected + delta + rows.length) % rows.length;
    setActive(next);
    document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({block: 'nearest'});
  };

  let index = -1;
  return <RadixDialog.Root open={open} onOpenChange={next => next ? show() : close()}>
    <RadixDialog.Trigger asChild>
      <button type="button" className="chart-symbol-trigger" aria-label={`Search symbol · ${symbol}`} title="Search symbol (/ or start typing)">
        <SymbolWithLogo symbol={symbol} showText={false} className="chart-symbol-logo" />
        <span className="chart-symbol-trigger-name">{symbol}</span>
        <Search size={13} className="chart-symbol-trigger-icon" aria-hidden="true" />
      </button>
    </RadixDialog.Trigger>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="symbol-palette-backdrop animate-in fade-in duration-150" />
      <RadixDialog.Content className="symbol-palette animate-in fade-in zoom-in-95 duration-150" aria-label="Symbol search"
        onOpenAutoFocus={event => { event.preventDefault(); (event.currentTarget as HTMLElement).querySelector('input')?.focus(); }}>
        <RadixDialog.Title className="sr-only">Symbol search</RadixDialog.Title>
        <form className="symbol-palette-search" role="search" onSubmit={event => {
          event.preventDefault();
          choose(query && rows[selected] ? rows[selected].symbol : draft);
        }}>
          <Search size={17} className="symbol-palette-search-icon" aria-hidden="true" />
          <input
            aria-label="Chart symbol"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[selected] ? `${listId}-${selected}` : undefined}
            placeholder="Search symbol or company"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            onChange={event => { setDraft(event.target.value); setActive(0); setError(''); }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
              else if (event.key === 'Enter' && !query && rows[selected]) { event.preventDefault(); choose(rows[selected].symbol); }
            }}
          />
          <RadixDialog.Close asChild><button type="button" className="symbol-palette-esc" aria-label="Close symbol search">Esc</button></RadixDialog.Close>
        </form>

        <div id={listId} role="listbox" aria-label={query ? 'Matching symbols' : 'Recent symbols'} className="symbol-palette-list">
          {error ? <p className="symbol-palette-empty is-error" role="alert">{error}</p>
            : directory.isPending && sessionDate && !rows.length ? <p className="symbol-palette-empty">Loading symbols…</p>
            : !rows.length ? <p className="symbol-palette-empty">{query ? <>No symbols match “{query}”. Press <kbd>↵</kbd> to open {query.toUpperCase()} anyway.</> : 'Start typing a ticker or company name.'}</p>
            : groups.map(group => <div key={group.label} role="group" aria-label={group.label}>
              <div className="symbol-palette-group" role="presentation">{group.label}</div>
              {group.rows.map(row => {
                index += 1;
                const rowIndex = index;
                return <div
                  key={`${group.label}-${row.symbol}`}
                  id={`${listId}-${rowIndex}`}
                  role="option"
                  aria-selected={rowIndex === selected}
                  className={`symbol-palette-option${rowIndex === selected ? ' is-active' : ''}`}
                  onMouseDown={event => { event.preventDefault(); choose(row.symbol); }}
                  onMouseMove={() => { if (active !== rowIndex) setActive(rowIndex); }}
                >
                  {row.recent ? <span className="symbol-palette-recent" aria-hidden="true"><Clock size={14} /></span>
                    : <SymbolWithLogo symbol={row.symbol} showText={false} className="symbol-palette-logo" />}
                  <span className="symbol-palette-symbol">{row.symbol}</span>
                  <span className="symbol-palette-name">{row.name}</span>
                  <span className="symbol-palette-exchange">NSE</span>
                  {rowIndex === selected && <CornerDownLeft size={13} className="symbol-palette-enter" aria-hidden="true" />}
                </div>;
              })}
            </div>)}
        </div>

        <footer className="symbol-palette-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open chart</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
