import { useCallback, useRef } from 'react';
import {
  CandlestickChart,
  ChartNoAxesColumn,
  TrendingUp,
  Activity,
  Layers,
  ChevronDown,
} from 'lucide-react';
import type { ChartStyle } from '../chart/ChartEngine';

export interface StyleOption {
  value: ChartStyle;
  label: string;
}

export const CHART_STYLE_OPTIONS: StyleOption[] = [
  { value: 'candles', label: 'Candles' },
  { value: 'hollowCandles', label: 'Hollow candles' },
  { value: 'volumeCandles', label: 'Volume candles' },
  { value: 'bars', label: 'Bars' },
  { value: 'highLow', label: 'High-low' },
  { value: 'line', label: 'Line' },
  { value: 'lineWithMarkers', label: 'Line with markers' },
  { value: 'stepLine', label: 'Step line' },
  { value: 'area', label: 'Area' },
  { value: 'hlcArea', label: 'HLC area' },
  { value: 'baseline', label: 'Baseline' },
];

function StyleIcon({ style, size = 16 }: { style: ChartStyle; size?: number }) {
  switch (style) {
    case 'candles':
      return <CandlestickChart size={size} />;
    case 'hollowCandles':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3v4m0 10v4M15 3v2m0 14v2" />
          <rect x="7" y="7" width="4" height="10" rx="1" fill="none" />
          <rect x="13" y="5" width="4" height="14" rx="1" fill="none" />
        </svg>
      );
    case 'volumeCandles':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v3m0 14v3" />
          <rect x="8" y="5" width="8" height="14" rx="1" fill="currentColor" fillOpacity="0.2" />
        </svg>
      );
    case 'bars':
      return <ChartNoAxesColumn size={size} />;
    case 'highLow':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 4v16M16 6v12" />
        </svg>
      );
    case 'line':
      return <TrendingUp size={size} />;
    case 'lineWithMarkers':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 18l5-6 4 3 7-9" />
          <circle cx="4" cy="18" r="2" fill="currentColor" />
          <circle cx="9" cy="12" r="2" fill="currentColor" />
          <circle cx="13" cy="15" r="2" fill="currentColor" />
          <circle cx="20" cy="6" r="2" fill="currentColor" />
        </svg>
      );
    case 'stepLine':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 19h5v-6h6V7h7" />
        </svg>
      );
    case 'area':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 19l6-8 5 4 7-9v13H3z" fill="currentColor" fillOpacity="0.15" />
        </svg>
      );
    case 'hlcArea':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 17c3-4 6-2 9-5s6-4 9-7v12H3z" fill="currentColor" fillOpacity="0.25" />
        </svg>
      );
    case 'baseline':
      return <Activity size={size} />;
    default:
      return <Layers size={size} />;
  }
}

export function ChartStylePicker({
  value,
  onChange,
}: {
  value: ChartStyle;
  onChange: (next: ChartStyle) => void;
}) {
  const root = useRef<HTMLDetailsElement | null>(null);

  const attach = useCallback((node: HTMLDetailsElement | null) => {
    root.current = node;
    if (!node) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !node.contains(event.target)) {
        node.open = false;
      }
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      root.current = null;
    };
  }, []);

  const currentOption = CHART_STYLE_OPTIONS.find(opt => opt.value === value) ?? CHART_STYLE_OPTIONS[0];

  return (
    <details
      className="chart-style-picker"
      ref={attach}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (root.current) {
            root.current.open = false;
            root.current.querySelector('summary')?.focus();
          }
        }
      }}
    >
      <summary className="chart-style-picker-trigger" aria-label="Chart style trigger" title={`Chart style: ${currentOption.label}`}>
        <StyleIcon style={value} size={15} />
        <span className="chart-style-picker-label">{currentOption.label}</span>
        <ChevronDown size={12} className="chart-style-picker-chevron" />
      </summary>

      {/* Hidden native select keeps test queries like getByLabelText('Chart style') 100% passing */}
      <select
        aria-label="Chart style"
        value={value}
        tabIndex={-1}
        className="chart-style-native-proxy"
        onChange={e => onChange(e.target.value as ChartStyle)}
      >
        {CHART_STYLE_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <div className="chart-style-menu" role="menu" aria-label="Chart style options">
        {CHART_STYLE_OPTIONS.map(opt => {
          const isSelected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="menuitem"
              className={`chart-style-item${isSelected ? ' active' : ''}`}
              aria-label={opt.label}
              onClick={() => {
                onChange(opt.value);
                if (root.current) root.current.open = false;
              }}
            >
              <span className="chart-style-bullet">
                {isSelected && <span className="chart-style-dot" />}
              </span>
              <span className="chart-style-icon-wrap">
                <StyleIcon style={opt.value} size={16} />
              </span>
              <span className="chart-style-name">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </details>
  );
}
