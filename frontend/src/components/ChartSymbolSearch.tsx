import { useId, useMemo, useState, type Ref } from 'react';
import { ArrowRight, Clock } from 'lucide-react';
import { readChartStorage, validSymbol, writeChartStorage } from '../chart/storage';
import { rankSymbols, useSymbolDirectory, type SymbolEntry } from '../hooks/useSymbolDirectory';
import { SymbolWithLogo } from './SymbolWithLogo';

const RECENTS_KEY = 'recent-symbols.v1';
const MAX_RECENTS = 8;

function readRecents(): string[] {
  const stored = readChartStorage(RECENTS_KEY);
  return Array.isArray(stored) ? stored.filter(validSymbol).slice(0, MAX_RECENTS) : [];
}

/** Chart symbol box with ticker/company autocomplete and recent symbols. */
export function ChartSymbolSearch({symbol, datasetRevision, sessionDate, onSelect, onError, inputRef}: {
  symbol: string;
  datasetRevision?: string;
  sessionDate?: string;
  onSelect: (symbol: string) => void;
  onError: (message: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const listId = useId();
  const [draft, setDraft] = useState(symbol);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const directory = useSymbolDirectory(datasetRevision, sessionDate, open);
  const names = useMemo(() => new Map((directory.data ?? []).map(entry => [entry.symbol, entry.name])), [directory.data]);
  const typed = draft.trim() && draft.trim().toUpperCase() !== symbol;
  const options: SymbolEntry[] = typed
    ? rankSymbols(directory.data ?? [], draft, 8)
    : readRecents().filter(item => item !== symbol).map(item => ({symbol: item, name: names.get(item) ?? ''}));
  const selected = Math.min(active, Math.max(options.length - 1, 0));

  const choose = (next: string) => {
    const clean = next.trim().toUpperCase();
    if (!validSymbol(clean)) { onError('Enter a scanner symbol, such as RELIANCE.'); return; }
    onError('');
    writeChartStorage(RECENTS_KEY, [clean, ...readRecents().filter(item => item !== clean)].slice(0, MAX_RECENTS));
    setDraft(clean);
    setOpen(false);
    onSelect(clean);
  };

  return <form className="chart-symbol-search" role="search" onSubmit={event => {
    event.preventDefault();
    choose(open && typed && options[selected] ? options[selected].symbol : draft);
  }}>
    <SymbolWithLogo symbol={symbol} showText={false} className="chart-symbol-logo" />
    <input
      ref={inputRef}
      aria-label="Chart symbol"
      role="combobox"
      aria-expanded={open && options.length > 0}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={open && options[selected] ? `${listId}-${options[selected].symbol}` : undefined}
      placeholder="Symbol..."
      value={draft}
      autoComplete="off"
      spellCheck={false}
      onFocus={event => { setOpen(true); event.currentTarget.select(); }}
      onBlur={() => { setOpen(false); setDraft(symbol); }}
      onChange={event => { setDraft(event.target.value); setActive(0); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((selected + 1) % Math.max(options.length, 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((selected - 1 + options.length) % Math.max(options.length, 1)); }
        else if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); }
      }}
    />
    <button type="submit" className="chart-load-btn" aria-label="Load" title="Load symbol"><ArrowRight size={13}/></button>
    {open && options.length > 0 && <ul id={listId} role="listbox" aria-label={typed ? 'Matching symbols' : 'Recent symbols'} className="chart-symbol-menu">
      {!typed && <li role="presentation" className="chart-symbol-menu-label">Recent</li>}
      {options.map((option, index) => <li
        key={option.symbol}
        id={`${listId}-${option.symbol}`}
        role="option"
        aria-selected={index === selected}
        className={`chart-symbol-option${index === selected ? ' is-active' : ''}`}
        onMouseDown={event => { event.preventDefault(); choose(option.symbol); }}
        onMouseMove={() => setActive(index)}
      >
        {typed ? <SymbolWithLogo symbol={option.symbol} showText={false} className="chart-symbol-option-logo" /> : <Clock size={13} className="text-muted" aria-hidden="true" />}
        <span className="chart-symbol-option-symbol">{option.symbol}</span>
        <span className="chart-symbol-option-name">{option.name}</span>
      </li>)}
    </ul>}
  </form>;
}
