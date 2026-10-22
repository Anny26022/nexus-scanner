import { useMemo, useRef, useState, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Bookmark, CandlestickChart, CornerDownLeft, Gauge, Moon, Rocket, ScanSearch, Search, Sun } from 'lucide-react';
import { rankSymbols, useSymbolDirectory } from '../hooks/useSymbolDirectory';
import { parseSavedScreens, SAVED_SCREENS_KEY, type ScreenDefinition } from '../utils/savedScreens';
import { describeScreen } from './SavedScreensMenu';
import type { AppTab } from './Navbar';

interface PaletteItem {
  id: string;
  group: 'Pages' | 'Saved screens' | 'Symbols' | 'Appearance';
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  onClose: () => void;
  onNavigate: (tab: AppTab) => void;
  onLoadScreen: (screen: ScreenDefinition) => void;
  onOpenSymbol: (symbol: string) => void;
  onThemeChange: (theme: 'light' | 'dark') => void;
  datasetRevision?: string;
  sessionDate?: string;
}

const PAGES: {tab: AppTab; label: string; keywords: string; Icon: typeof ScanSearch}[] = [
  {tab: 'screener', label: 'Screener', keywords: 'scan filter stocks', Icon: ScanSearch},
  {tab: 'market', label: 'Market overview', keywords: 'breadth sectors indices nifty', Icon: Gauge},
  {tab: 'ipo', label: 'IPO Catalogue', keywords: 'listings new ipos', Icon: Rocket},
  {tab: 'charts', label: 'Charts', keywords: 'chart watchlist drawing', Icon: CandlestickChart},
];
const MAX_SYMBOLS = 8;

function readSavedScreens() {
  try { return parseSavedScreens(JSON.parse(localStorage.getItem(SAVED_SCREENS_KEY) ?? '[]')); } catch { return []; }
}

/** ⌘K / Ctrl+K launcher for pages, saved screens, symbols and appearance. Mounted only while open. */
export function CommandPalette({onClose, onNavigate, onLoadScreen, onOpenSymbol, onThemeChange, datasetRevision, sessionDate}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const savedScreens = useMemo(readSavedScreens, []);
  const inputRef = useRef<HTMLInputElement>(null);

  const symbols = useSymbolDirectory(datasetRevision, sessionDate);

  const items = useMemo<PaletteItem[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
    const pages: PaletteItem[] = PAGES.filter(page => matches(`${page.label} ${page.keywords}`)).map(page => ({
      id: `page:${page.tab}`, group: 'Pages', label: page.label, hint: 'Go to page', icon: <page.Icon size={15} />, run: () => onNavigate(page.tab),
    }));
    const screens: PaletteItem[] = savedScreens.filter(item => matches(item.name)).map(item => ({
      id: `screen:${item.id}`, group: 'Saved screens', label: item.name, hint: describeScreen(item.screen), icon: <Bookmark size={15} />,
      run: () => onLoadScreen(item.screen),
    }));
    const symbolItems: PaletteItem[] = rankSymbols(symbols.data ?? [], needle, MAX_SYMBOLS).map(row => ({
      id: `symbol:${row.symbol}`, group: 'Symbols', label: row.symbol, hint: row.name, icon: <CandlestickChart size={15} />,
      run: () => onOpenSymbol(row.symbol),
    }));
    const appearance: PaletteItem[] = [
      {id: 'theme:light', group: 'Appearance', label: 'Light appearance', keywords: 'theme mode', icon: <Sun size={15} />, run: () => onThemeChange('light')},
      {id: 'theme:dark', group: 'Appearance', label: 'Dark appearance', keywords: 'theme mode night', icon: <Moon size={15} />, run: () => onThemeChange('dark')},
    ].filter(item => matches(`${item.label} ${item.keywords}`)) as PaletteItem[];
    return [...pages, ...screens, ...symbolItems, ...appearance];
  }, [query, savedScreens, symbols.data, onNavigate, onLoadScreen, onOpenSymbol, onThemeChange]);

  const selected = Math.min(active, Math.max(items.length - 1, 0));
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <RadixDialog.Root open onOpenChange={open => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-(--z-dialog) bg-black/25 backdrop-blur-[6px] animate-in fade-in duration-150" />
        <RadixDialog.Content
          aria-label="Command palette"
          onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}
          className="fixed left-1/2 top-[14vh] z-[calc(var(--z-dialog)+1)] w-[min(620px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-(--radius-xl) bg-surface text-text shadow-(--shadow-dialog) outline-none animate-in fade-in zoom-in-95 duration-150"
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search size={17} className="shrink-0 text-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-list"
              aria-activedescendant={items[selected] ? `palette-${items[selected].id}` : undefined}
              aria-label="Search pages, saved screens and symbols"
              placeholder="Search pages, screens or symbols…"
              value={query}
              onChange={event => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setActive((selected + 1) % Math.max(items.length, 1)); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((selected - 1 + items.length) % Math.max(items.length, 1)); }
                else if (event.key === 'Enter') { event.preventDefault(); choose(items[selected]); }
              }}
              className="h-14 min-w-0 flex-1 bg-transparent text-[16px] text-text outline-none placeholder:text-muted focus-visible:shadow-none"
            />
            <kbd className="rounded-md bg-field px-1.5 py-0.5 text-[11px] font-medium text-muted">esc</kbd>
          </div>
          <div id="command-palette-list" role="listbox" aria-label="Results" className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
            {items.length === 0
              ? <p className="px-3 py-8 text-center text-[13px] text-muted">{symbols.isPending && query ? 'Loading symbols…' : 'No matches'}</p>
              : items.map((item, index) => {
                const first = index === 0 || items[index - 1].group !== item.group;
                const isActive = index === selected;
                return <div key={item.id}>
                  {first && <div className="px-3 pb-1 pt-2.5 text-[11.5px] font-medium text-muted">{item.group}</div>}
                  <div
                    id={`palette-${item.id}`}
                    role="option"
                    aria-selected={isActive}
                    ref={element => { if (isActive) element?.scrollIntoView({block: 'nearest'}); }}
                    onMouseMove={() => setActive(index)}
                    onClick={() => choose(item)}
                    className={`flex cursor-pointer items-center gap-3 rounded-(--radius-md) px-3 py-2 ${isActive ? 'bg-surface-hover text-text' : 'text-text'}`}
                  >
                    <span className={isActive ? 'text-text' : 'text-muted'} aria-hidden="true">{item.icon}</span>
                    <span className="truncate text-[13.5px] font-medium">{item.label}</span>
                    {item.hint && <span className={`truncate text-[12.5px] text-muted`}>{item.hint}</span>}
                    {isActive && <CornerDownLeft size={13} className="ml-auto shrink-0 text-muted" aria-hidden="true" />}
                  </div>
                </div>;
              })}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
