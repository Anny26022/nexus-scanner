import { useState, useMemo } from 'react';
import { Search, X, Settings } from 'lucide-react';
import type { ChartStudies } from '../chart/studies';
import type { ChartAppearance } from '../chart/ChartEngine';
import type { EmaLine, Interval } from '../chart/model';
import { ChartDialog } from './ChartDialog';

export interface IndicatorsCatalogModalProps {
  studies: ChartStudies;
  emaLines: EmaLine[];
  interval: Interval;
  appearance?: ChartAppearance;
  onApplyStudies: (next: ChartStudies) => void;
  onApplyEmaLines: (next: EmaLine[]) => void;
  onApplyAppearance?: (next: Partial<ChartAppearance>) => void;
  onOpenIndicatorSettings: (indicatorId: string) => void;
  onClose: () => void;
}

interface CatalogItem {
  id: keyof ChartStudies | 'ema' | 'volume';
  name: string;
  shortName: string;
  category: 'Trend' | 'Oscillators' | 'Volatility' | 'Volume';
  type: 'Overlay' | 'Sub-pane';
  ariaLabel: string;
  disabled?: boolean;
}

export function IndicatorsCatalogModal({
  studies,
  emaLines,
  interval,
  appearance = { horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' },
  onApplyStudies,
  onApplyEmaLines,
  onApplyAppearance,
  onOpenIndicatorSettings,
  onClose,
}: IndicatorsCatalogModalProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'All' | 'Trend' | 'Oscillators' | 'Volatility' | 'Volume'>('All');

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

  const filtered = useMemo(() => {
    return catalog.filter(item => {
      if (category !== 'All' && item.category !== category) return false;
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
  }, [category, search]);

  const handleToggle = (item: CatalogItem, checked: boolean) => {
    if (item.id === 'ema') {
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
      {/* Sleek Search & Category Filter */}
      <div className="catalog-toolbar">
        <div className="catalog-search-wrap">
          <Search size={14} className="catalog-search-icon" />
          <input
            type="text"
            placeholder="Search indicators..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="catalog-search-input"
            autoFocus
          />
          {search && (
            <button
              type="button"
              className="catalog-search-clear"
              onClick={() => setSearch('')}
              title="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="catalog-tabs" role="tablist">
          {(['All', 'Trend', 'Oscillators', 'Volatility', 'Volume'] as const).map(cat => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={category === cat}
              className={`catalog-tab${category === cat ? ' active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Clean, Sleek Indicators List */}
      <div className="catalog-list-scroll">
        <div className="catalog-list">
          {filtered.map(item => {
            const isChecked =
              item.id === 'ema'
                ? emaLines.some(l => l.enabled)
                : item.id === 'volume'
                ? !!appearance.volume
                : !!studies[item.id as keyof ChartStudies];

            return (
              <div
                key={item.id}
                className={`catalog-item-row${isChecked ? ' is-active' : ''}`}
              >
                <div className="catalog-item-left">
                  <div className="catalog-item-title-group">
                    <span className="catalog-item-name">{item.name}</span>
                    <span className="catalog-item-short">{item.shortName}</span>
                  </div>
                  <span className="catalog-type-tag">{item.type}</span>
                </div>

                <div className="catalog-item-actions">
                  <button
                    type="button"
                    className="catalog-item-settings-btn"
                    title={`Customize ${item.name}`}
                    onClick={() => onOpenIndicatorSettings(item.id)}
                  >
                    <Settings size={13} />
                  </button>
                  <label className="catalog-switch" title={isChecked ? 'Disable' : 'Enable'}>
                    <input
                      type="checkbox"
                      aria-label={item.ariaLabel}
                      checked={isChecked}
                      disabled={item.disabled}
                      onChange={e => handleToggle(item, e.target.checked)}
                    />
                    <span className="catalog-switch-slider" />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="catalog-footer">
        <button
          type="button"
          className="catalog-btn-done"
          onClick={onClose}
        >
          Done
        </button>
      </footer>
    </ChartDialog>
  );
}
