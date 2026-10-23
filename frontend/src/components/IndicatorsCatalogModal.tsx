import { useState, useMemo } from 'react';
import { Search, X, Settings, Check } from 'lucide-react';
import type { ChartStudies } from '../chart/studies';
import type { ChartAppearance } from '../chart/ChartEngine';
import type { EmaLine, Interval } from '../chart/model';
import { ChartDialog } from './ChartDialog';
import { EXTRA_STUDIES, studyParams, studyTitle, type ExtraStudies, type ExtraStudyDef } from '../chart/extraStudies';

export interface IndicatorsCatalogModalProps {
  studies: ChartStudies;
  emaLines: EmaLine[];
  interval: Interval;
  appearance?: ChartAppearance;
  onApplyStudies: (next: ChartStudies) => void;
  onApplyEmaLines: (next: EmaLine[]) => void;
  onApplyAppearance?: (next: Partial<ChartAppearance>) => void;
  onOpenIndicatorSettings: (indicatorId: string) => void;
  extras?: ExtraStudies;
  onApplyExtras?: (next: ExtraStudies) => void;
  onClose: () => void;
}

interface CatalogItem {
  id: keyof ChartStudies | 'ema' | 'volume' | ExtraStudyDef['id'];
  extra?: ExtraStudyDef;
  name: string;
  shortName: string;
  category: 'Trend' | 'Oscillators' | 'Volatility' | 'Volume';
  type: 'Overlay' | 'Sub-pane';
  ariaLabel: string;
  description?: string;
  disabled?: boolean;
}

const CATEGORIES = ['Trend', 'Oscillators', 'Volatility', 'Volume'] as const;
const DESCRIPTIONS: Record<string, string> = {
  ema: 'Up to six exponential averages that weight recent prices more.',
  sma: 'The plain average of the last 50 closes.',
  supertrend: 'ATR-based trailing line that flips with the trend.',
  vwap: 'Monthly volume-weighted average price. Daily bars only.',
  rsi: 'Momentum from 0 to 100; above 70 is overbought, below 30 oversold.',
  macd: 'Gap between two EMAs, with a signal line and histogram.',
  stochastic: 'Where the close sits in the recent high–low range.',
  bollinger: 'A 20-bar average with bands two standard deviations away.',
  atr: 'Average daily range, a gauge of volatility.',
  volume: 'Traded volume per bar, coloured by direction.',
};

export function IndicatorsCatalogModal({
  studies,
  emaLines,
  interval,
  appearance = { horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' },
  onApplyStudies,
  onApplyEmaLines,
  onApplyAppearance,
  onOpenIndicatorSettings,
  extras = {},
  onApplyExtras,
  onClose,
}: IndicatorsCatalogModalProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'All' | 'Active' | typeof CATEGORIES[number]>('All');
  const [hovered, setHovered] = useState<CatalogItem | null>(null);

  const catalog: CatalogItem[] = [
    {
      id: 'ema',
      name: 'Exponential Moving Average',
      shortName: 'EMA',
      category: 'Trend',
      type: 'Overlay',
      ariaLabel: 'EMA lines',
    },
    {
      id: 'sma',
      name: 'Simple Moving Average',
      shortName: 'SMA 50',
      category: 'Trend',
      type: 'Overlay',
      ariaLabel: 'SMA · 50',
    },
    {
      id: 'supertrend',
      name: 'Supertrend',
      shortName: 'ST 10/3',
      category: 'Trend',
      type: 'Overlay',
      ariaLabel: 'Supertrend 10 3',
    },
    {
      id: 'vwap',
      name: 'Volume Weighted Average Price',
      shortName: 'VWAP',
      category: 'Trend',
      type: 'Overlay',
      ariaLabel: 'Monthly VWAP · daily bars',
      disabled: interval !== 'D',
    },
    {
      id: 'rsi',
      name: 'Relative Strength Index',
      shortName: 'RSI 14',
      category: 'Oscillators',
      type: 'Sub-pane',
      ariaLabel: 'RSI 14',
    },
    {
      id: 'macd',
      name: 'Moving Average Convergence Divergence',
      shortName: 'MACD 12/26/9',
      category: 'Oscillators',
      type: 'Sub-pane',
      ariaLabel: 'MACD 12/26/9',
    },
    {
      id: 'stochastic',
      name: 'Stochastic Oscillator',
      shortName: 'Stoch 14/3',
      category: 'Oscillators',
      type: 'Sub-pane',
      ariaLabel: 'Stochastic · 14 / 3',
    },
    {
      id: 'bollinger',
      name: 'Bollinger Bands',
      shortName: 'BB 20, 2σ',
      category: 'Volatility',
      type: 'Overlay',
      ariaLabel: 'Bollinger Bands · 20, 2σ',
    },
    {
      id: 'atr',
      name: 'Average True Range',
      shortName: 'ATR 14',
      category: 'Volatility',
      type: 'Sub-pane',
      ariaLabel: 'ATR · 14',
    },
    {
      id: 'volume',
      name: 'Volume',
      shortName: 'Vol',
      category: 'Volume',
      type: 'Sub-pane',
      ariaLabel: 'Volume histogram',
    },
  ];

  const extraItems: CatalogItem[] = EXTRA_STUDIES.map(def => ({
    id: def.id,
    extra: def,
    name: def.label,
    shortName: studyTitle(def, studyParams(def, extras[def.id])),
    category: def.category === 'Momentum' ? 'Oscillators' : def.category === 'Relative strength' ? 'Trend' : def.category,
    type: def.pane === 'price' ? 'Overlay' : 'Sub-pane',
    ariaLabel: def.label,
    description: def.description,
  }));
  catalog.splice(1, 0, ...extraItems.filter(item => item.id === 'rs'));
  catalog.push(...extraItems.filter(item => item.id !== 'rs'));
  for (const item of catalog) item.description ??= DESCRIPTIONS[item.id];

  const isOn = (item: CatalogItem) => item.extra
    ? !!extras[item.extra.id]?.enabled
    : item.id === 'ema'
      ? emaLines.some(l => l.enabled)
      : item.id === 'volume'
      ? !!appearance.volume
      : !!studies[item.id as keyof ChartStudies];
  const activeCount = catalog.filter(isOn).length;

  const filtered = useMemo(() => {
    return catalog.filter(item => {
      if (category === 'Active' && !isOn(item)) return false;
      if (category !== 'All' && category !== 'Active' && item.category !== category) return false;
      if (search.trim()) {
        const query = search.toLowerCase();
        return (
          item.name.toLowerCase().includes(query) ||
          item.shortName.toLowerCase().includes(query) ||
          item.category.toLowerCase().includes(query)
        );
      }
      return true;
    });
  }, [category, search, extras, studies, emaLines, appearance]);

  const handleToggle = (item: CatalogItem, checked: boolean) => {
    if (item.extra) {
      onApplyExtras?.({...extras, [item.extra.id]: {...extras[item.extra.id], enabled: checked}});
    } else if (item.id === 'ema') {
      if (checked) {
        const hasEnabled = emaLines.some(l => l.enabled);
        onApplyEmaLines(
          hasEnabled ? emaLines : emaLines.map((l, i) => (i < 2 ? { ...l, enabled: true } : l))
        );
      } else {
        onApplyEmaLines(emaLines.map(l => ({ ...l, enabled: false })));
      }
    } else if (item.id === 'volume') {
      onApplyAppearance?.({ ...appearance, volume: checked });
    } else {
      onApplyStudies({
        ...studies,
        [item.id as keyof ChartStudies]: checked,
      });
    }
  };

  return (
    <ChartDialog title="Indicators" className="indicators-catalog-dialog" onClose={onClose}>
      <div className="ic-search">
        <Search size={15} className="ic-search-icon" aria-hidden="true" />
        <input
          type="search"
          placeholder="Search indicators"
          aria-label="Search indicators"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="ic-search-input"
          autoFocus
        />
        {search && <button type="button" className="ic-search-clear" onClick={() => setSearch('')} aria-label="Clear search" title="Clear search"><X size={12} /></button>}
      </div>

      <div className="ic-body">
        <nav className="ic-nav" role="tablist" aria-label="Indicator category" aria-orientation="vertical">
          {(['All', 'Active', ...CATEGORIES] as const).map(cat => {
            const count = cat === 'All' ? catalog.length : cat === 'Active' ? activeCount : catalog.filter(item => item.category === cat).length;
            return <button key={cat} type="button" role="tab" aria-label={cat} aria-selected={category === cat} className={`ic-nav-btn${category === cat ? ' active' : ''}`} onClick={() => setCategory(cat)}>
              <span>{cat}</span><span className="ic-nav-count">{count}</span>
            </button>;
          })}
        </nav>

        <div className="ic-list" onMouseLeave={() => setHovered(null)}>
          {filtered.length === 0 && <p className="ic-empty">{category === 'Active' && !search ? 'No indicators on this chart yet.' : `No indicators match “${search}”.`}</p>}
          {CATEGORIES.map(group => {
            const rows = filtered.filter(item => item.category === group);
            if (!rows.length) return null;
            return <section key={group} aria-label={group}>
              {(category === 'All' || category === 'Active') && <h3 className="ic-group">{group}</h3>}
              {rows.map(item => {
                const on = isOn(item);
                return <div key={item.id} className={`ic-row${on ? ' is-on' : ''}${item.disabled ? ' is-disabled' : ''}`}
                  onMouseEnter={() => setHovered(item)} onFocus={() => setHovered(item)}>
                  <label className="ic-main" title={item.description}>
                    <input type="checkbox" role="switch" aria-label={item.ariaLabel} checked={on} disabled={item.disabled}
                      onChange={e => handleToggle(item, e.target.checked)} />
                    <span className="ic-check" aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
                    <span className="ic-name">{item.name}</span>
                    <span className="ic-short">{item.shortName}</span>
                  </label>
                  <span className="ic-kind">{item.type === 'Overlay' ? 'Price' : 'Pane'}</span>
                  <button type="button" className="ic-settings" aria-label={`Customize ${item.name}`} title={`Customize ${item.name}`}
                    onClick={() => onOpenIndicatorSettings(item.id)}>
                    <Settings size={13} />
                  </button>
                </div>;
              })}
            </section>;
          })}
        </div>
      </div>

      <footer className="ic-footer" aria-live="polite">
        {hovered ? <><b>{hovered.name}</b><span>{hovered.description}</span></>
          : <span>{activeCount} active · click a row to add or remove it</span>}
      </footer>
    </ChartDialog>
  );
}
