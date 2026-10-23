import { useState, type ReactNode } from 'react';
import {
  CalendarDays,
  CandlestickChart,
  Eye,
  MoveUpRight,
  Palette,
  SlidersHorizontal,
} from 'lucide-react';
import { type ChartAppearance, type ChartStyle, type ScaleMode } from '../chart/ChartEngine';
import { ChartDialog } from './ChartDialog';
import { CHART_STYLE_OPTIONS } from './ChartStylePicker';

const DEFAULT_UP = '#089981';
const DEFAULT_DOWN = '#ef5350';

export type Section = 'price' | 'readout' | 'axes' | 'appearance' | 'trading' | 'navigation';
export type Comparison = { symbol: string; separate: boolean } | null;

export type Props = {
  appearance: ChartAppearance;
  chartStyle: ChartStyle;
  symbol: string;
  comparison: Comparison;
  firstDate: string;
  lastDate: string;
  onClose: () => void;
  onApply: (appearance: ChartAppearance, style: ChartStyle, comparison: Comparison) => void;
  onGoToDate: (date: string) => boolean;
  onEvents: () => void;
};

const sections: readonly { id: Section; label: string; Icon: typeof CandlestickChart }[] = [
  { id: 'price', label: 'Symbol', Icon: CandlestickChart },
  { id: 'readout', label: 'Status line', Icon: Eye },
  { id: 'axes', label: 'Scales and lines', Icon: MoveUpRight },
  { id: 'appearance', label: 'Canvas', Icon: Palette },
  { id: 'trading', label: 'Events', Icon: CalendarDays },
  { id: 'navigation', label: 'Navigation', Icon: SlidersHorizontal },
];

/** What "Reset" returns colours and layout to; data-shaping choices (volume, scale mode, comparison) are kept. */
const RESET_KEYS: readonly (keyof ChartAppearance)[] = [
  'upColor', 'downColor', 'borderUpColor', 'borderDownColor', 'wickUpColor', 'wickDownColor', 'bodyVisible', 'borderVisible', 'wickVisible',
  'colorByPreviousClose', 'lineColor', 'lineWidth', 'backgroundColor', 'scaleTextColor', 'scaleFontSize', 'vertGridColor', 'horzGridColor',
  'vertGridStyle', 'horzGridStyle', 'crosshairColor', 'crosshairStyle', 'crosshairTransparency', 'watermarkVisible', 'watermarkText',
  'watermarkColor', 'watermarkOpacity', 'topMargin', 'bottomMargin', 'statusBackground', 'statusBackgroundColor', 'statusBackgroundOpacity',
];

const CANDLE_STYLES: readonly ChartStyle[] = ['candles', 'hollowCandles', 'volumeCandles'];
const BAR_STYLES: readonly ChartStyle[] = ['bars', 'highLow'];
const LINE_STYLE_CHARTS: readonly ChartStyle[] = ['line', 'lineWithMarkers', 'stepLine', 'area', 'hlcArea'];

const TIMEZONES: readonly { label: string; value: string }[] = [
  { label: 'UTC', value: 'UTC' },
  { label: 'London (UTC+0/+1)', value: 'Europe/London' },
  { label: 'Berlin (UTC+1/+2)', value: 'Europe/Berlin' },
  { label: 'Dubai (UTC+4)', value: 'Asia/Dubai' },
  { label: 'Kolkata (UTC+5:30)', value: 'Asia/Kolkata' },
  { label: 'Singapore (UTC+8)', value: 'Asia/Singapore' },
  { label: 'Hong Kong (UTC+8)', value: 'Asia/Hong_Kong' },
  { label: 'Tokyo (UTC+9)', value: 'Asia/Tokyo' },
  { label: 'Sydney (UTC+10/+11)', value: 'Australia/Sydney' },
  { label: 'New York (UTC−5/−4)', value: 'America/New_York' },
  { label: 'Chicago (UTC−6/−5)', value: 'America/Chicago' },
  { label: 'Los Angeles (UTC−8/−7)', value: 'America/Los_Angeles' },
];

/** The current theme's colour for a token, so swatches start from what the chart actually shows. */
function themeColor(name: string, fallback: string) {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}
const isDarkTheme = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

function ColorPicker({
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: string;
  onChange: (val: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <label className={`cs-swatch${disabled ? ' is-disabled' : ''}`} title={ariaLabel}>
      <input type="color" aria-label={ariaLabel} value={value.slice(0, 7)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <span style={{ backgroundColor: value }} />
    </label>
  );
}

/** Checkbox row; extra controls (colours, selects) sit on the right. */
function Check({
  label,
  checked,
  onChange,
  disabled = false,
  indent = false,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  indent?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`cs-row${indent ? ' is-indent' : ''}${disabled ? ' is-disabled' : ''}`}>
      <label className="cs-check">
        <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {children && <div className="cs-control">{children}</div>}
    </div>
  );
}

/** Label on the left, control on the right. */
function Row({ label, indent = false, children }: { label: string; indent?: boolean; children: ReactNode }) {
  return (
    <div className={`cs-row${indent ? ' is-indent' : ''}`}>
      <span className="cs-label">{label}</span>
      <div className="cs-control">{children}</div>
    </div>
  );
}

const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
function LineStyleSelect({ value, onChange, ariaLabel }: { value?: string; onChange: (value: typeof LINE_STYLES[number]) => void; ariaLabel: string }) {
  return (
    <select aria-label={ariaLabel} className="cs-select is-narrow" value={value ?? 'solid'} onChange={(e) => onChange(e.target.value as typeof LINE_STYLES[number])}>
      <option value="solid">Solid</option>
      <option value="dashed">Dashed</option>
      <option value="dotted">Dotted</option>
    </select>
  );
}

export function ChartSettingsDialog({
  appearance,
  chartStyle,
  symbol,
  comparison,
  firstDate,
  lastDate,
  onClose,
  onApply,
  onGoToDate,
  onEvents,
}: Props) {
  const [section, setSection] = useState<Section>('price');
  const [draft, setDraft] = useState(appearance);
  const [initialDraft] = useState(appearance);
  const [style, setStyle] = useState(chartStyle);
  const [initialStyle] = useState(chartStyle);
  const [compareSymbol, setCompareSymbol] = useState(comparison?.symbol ?? '');
  const [compareSeparate, setCompareSeparate] = useState(comparison?.separate ?? false);
  const [currentComparison, setCurrentComparison] = useState(comparison);
  const [initialComparison] = useState(comparison);
  const [goDate, setGoDate] = useState('');
  const [error, setError] = useState('');
  const update = (change: Partial<ChartAppearance>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    onApply(next, style, currentComparison);
  };

  const handleStyleChange = (nextStyle: ChartStyle) => {
    setStyle(nextStyle);
    onApply(draft, nextStyle, currentComparison);
  };

  const addComparison = () => {
    const next = compareSymbol.trim();
    if (!next) {
      setCurrentComparison(null);
      onApply(draft, style, null);
      return;
    }
    if (!/^[A-Z0-9_&.\-]{1,40}$/.test(next) || next === symbol) {
      setError('Enter a different scanner symbol, such as TCS.');
      return;
    }
    setError('');
    const comp = { symbol: next, separate: compareSeparate };
    setCurrentComparison(comp);
    onApply(draft, style, comp);
  };

  const handleCompareSeparateChange = (separate: boolean) => {
    setCompareSeparate(separate);
    const next = compareSymbol.trim();
    if (next) {
      const comp = { symbol: next, separate };
      setCurrentComparison(comp);
      onApply(draft, style, comp);
    }
  };

  const cancel = () => {
    onApply(initialDraft, initialStyle, initialComparison);
    onClose();
  };

  const apply = () => {
    const next = compareSymbol.trim();
    if (next && (!/^[A-Z0-9_&.\-]{1,40}$/.test(next) || next === symbol)) {
      setError('Enter a different scanner symbol, such as TCS.');
      return;
    }
    const comp = next ? { symbol: next, separate: compareSeparate } : null;
    onApply(draft, style, comp);
    onClose();
  };

  const navigate = () => {
    if (!goDate) return;
    if (onGoToDate(goDate)) onClose();
    else setError('Choose a date within the published chart history.');
  };

  const reset = () => {
    const next: ChartAppearance = { ...draft, verticalGrid: true, horizontalGrid: true, crosshair: true, crosshairMode: 'normal' };
    for (const key of RESET_KEYS) delete next[key];
    setDraft(next);
    onApply(next, style, currentComparison);
  };

  const upColor = draft.upColor ?? DEFAULT_UP;
  const downColor = draft.downColor ?? DEFAULT_DOWN;
  const borderUpColor = draft.borderUpColor ?? upColor;
  const borderDownColor = draft.borderDownColor ?? downColor;
  const wickUpColor = draft.wickUpColor ?? upColor;
  const wickDownColor = draft.wickDownColor ?? downColor;

  const isCandle = CANDLE_STYLES.includes(style);
  const isBar = BAR_STYLES.includes(style);
  const isLine = LINE_STYLE_CHARTS.includes(style);
  const selectTab = (id: Section) => { setSection(id); setError(''); };

  return (
    <ChartDialog title="Chart settings" onClose={cancel} className="chart-settings-dialog">
      <div className="chart-settings-layout">
        <nav className="chart-settings-nav" role="tablist" aria-label="Chart settings sections" aria-orientation="vertical">
          {sections.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={section === id}
              aria-controls="settings-panel"
              className={`chart-settings-nav-btn${section === id ? ' active' : ''}`}
              onClick={() => selectTab(id)}
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="chart-settings-content" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`}>
          {section === 'price' && <>
            <h4 className="cs-subhead">Chart type</h4>
            <Row label="Style">
              <select aria-label="Chart type" className="cs-select" value={style} onChange={(event) => handleStyleChange(event.target.value as ChartStyle)}>
                {CHART_STYLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Row>

            {(isCandle || isBar || style === 'baseline') && <>
              <h4 className="cs-subhead">{isCandle ? 'Candles' : isBar ? 'Bars' : 'Baseline'}</h4>
              {isCandle ? <>
                <Check label="Body" checked={draft.bodyVisible !== false} onChange={(checked) => update({ bodyVisible: checked })}>
                  <ColorPicker ariaLabel="Candle up body color" value={upColor} onChange={(val) => update({ upColor: val })} />
                  <ColorPicker ariaLabel="Candle down body color" value={downColor} onChange={(val) => update({ downColor: val })} />
                </Check>
                <Check label="Borders" checked={style === 'hollowCandles' || draft.borderVisible !== false} disabled={style === 'hollowCandles'} onChange={(checked) => update({ borderVisible: checked })}>
                  <ColorPicker ariaLabel="Border up color" value={borderUpColor} onChange={(val) => update({ borderUpColor: val })} />
                  <ColorPicker ariaLabel="Border down color" value={borderDownColor} onChange={(val) => update({ borderDownColor: val })} />
                </Check>
                <Check label="Wick" checked={draft.wickVisible !== false} onChange={(checked) => update({ wickVisible: checked })}>
                  <ColorPicker ariaLabel="Wick up color" value={wickUpColor} onChange={(val) => update({ wickUpColor: val })} />
                  <ColorPicker ariaLabel="Wick down color" value={wickDownColor} onChange={(val) => update({ wickDownColor: val })} />
                </Check>
              </> : <Row label={style === 'baseline' ? 'Above / below base' : 'Up / down'}>
                <ColorPicker ariaLabel="Up color" value={upColor} onChange={(val) => update({ upColor: val })} />
                <ColorPicker ariaLabel="Down color" value={downColor} onChange={(val) => update({ downColor: val })} />
              </Row>}
              {style !== 'baseline' && <Check label="Color bars based on previous close" checked={draft.colorByPreviousClose ?? false} onChange={(checked) => update({ colorByPreviousClose: checked })} />}
            </>}

            {isLine && <>
              <h4 className="cs-subhead">Line</h4>
              <Row label="Color and width">
                <ColorPicker ariaLabel="Line color" value={draft.lineColor ?? themeColor('accent', '#2962ff')} onChange={(val) => update({ lineColor: val })} />
                <select aria-label="Line width" className="cs-select is-narrow" value={draft.lineWidth ?? 2} onChange={(e) => update({ lineWidth: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map(width => <option key={width} value={width}>{width}px</option>)}
                </select>
              </Row>
            </>}

            <h4 className="cs-subhead">Data</h4>
            <Row label="Precision">
              <select aria-label="Precision" className="cs-select" value={draft.precision ?? 'default'} onChange={(e) => update({ precision: e.target.value })}>
                <option value="default">Default</option>
                {['0', '1', '2', '3', '4'].map(value => <option key={value} value={value}>{value === '0' ? '1' : `1/${10 ** Number(value)}`}</option>)}
              </select>
            </Row>
            <Row label="Timezone">
              <select aria-label="Timezone" className="cs-select" value={draft.timezone ?? 'Asia/Kolkata'} onChange={(e) => update({ timezone: e.target.value })}>
                {TIMEZONES.map((tz) => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
              </select>
            </Row>

            <h4 className="cs-subhead">Compare</h4>
            <Row label="Symbol">
              <input aria-label="Compare symbol" className="cs-input" placeholder="e.g. TCS" value={compareSymbol} maxLength={40}
                onChange={(event) => setCompareSymbol(event.target.value.toUpperCase())}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addComparison(); } }} />
              <button type="button" className="cs-button" onClick={addComparison}>Add</button>
            </Row>
            <Check label="Comparison in synced pane" checked={compareSeparate} onChange={(checked) => handleCompareSeparateChange(checked)} />
          </>}

          {section === 'readout' && <>
            <h4 className="cs-subhead">Symbol</h4>
            <Check label="Logo" checked={draft.statusLogo !== false} onChange={(checked) => update({ statusLogo: checked })} />
            <Check label="Title" checked={draft.statusTitle !== false} onChange={(checked) => update({ statusTitle: checked })}>
              <select aria-label="Title shows" className="cs-select" disabled={draft.statusTitle === false} value={draft.statusTitleMode ?? 'symbol'}
                onChange={(e) => update({ statusTitleMode: e.target.value as 'symbol' | 'description' | 'ticker' })}>
                <option value="symbol">Symbol</option>
                <option value="description">Description</option>
                <option value="ticker">Ticker</option>
              </select>
            </Check>
            <Check label="Market status" checked={draft.statusMarketStatus !== false} onChange={(checked) => update({ statusMarketStatus: checked })} />
            <Check label="Open, high, low, close" checked={draft.statusOhlc !== false} onChange={(checked) => update({ statusOhlc: checked })} />
            <Check label="Bar change values" checked={draft.statusBarChange !== false} onChange={(checked) => update({ statusBarChange: checked })} />
            <Check label="Volume" checked={draft.volume} onChange={(checked) => update({ volume: checked })} />
            <Check label="Volume in separate pane" indent disabled={!draft.volume} checked={draft.volumePane ?? false} onChange={(checked) => update({ volumePane: checked })} />
            <h4 className="cs-subhead">Indicators</h4>
            <Check label="Indicator values" checked={draft.statusIndicators !== false} onChange={(checked) => update({ statusIndicators: checked })} />
            <Check label="Background" checked={draft.statusBackground ?? false} onChange={(checked) => update({ statusBackground: checked })}>
              <ColorPicker ariaLabel="Background color" disabled={!draft.statusBackground} value={draft.statusBackgroundColor ?? '#131722'} onChange={(val) => update({ statusBackgroundColor: val })} />
              <input aria-label="Background opacity" className="cs-input is-number" type="number" min="0.1" max="1" step="0.05" disabled={!draft.statusBackground}
                value={draft.statusBackgroundOpacity ?? 0.8} onChange={(e) => update({ statusBackgroundOpacity: Number(e.target.value) })} />
            </Check>
          </>}

          {section === 'axes' && <>
            <h4 className="cs-subhead">Price scale</h4>
            <Row label="Scale mode">
              <select aria-label="Price scale" className="cs-select" value={draft.scaleMode} onChange={(event) => update({ scaleMode: event.target.value as ScaleMode })}>
                <option value="normal">Regular</option>
                <option value="logarithmic">Logarithmic</option>
                <option value="percentage">Percentage</option>
                <option value="indexed">Indexed to 100</option>
              </select>
            </Row>
            <Check label="Invert scale" checked={draft.invertScale ?? false} onChange={(checked) => update({ invertScale: checked })} />
            <Check label="Symbol last value label" checked={draft.lastValueLabel !== false} onChange={(checked) => update({ lastValueLabel: checked })} />
            <Row label="Margins top / bottom">
              <input aria-label="Top margin %" className="cs-input is-number" type="number" min="0" max="49" value={draft.topMargin ?? 13} onChange={(e) => update({ topMargin: Number(e.target.value) })} />
              <input aria-label="Bottom margin %" className="cs-input is-number" type="number" min="0" max="49" value={draft.bottomMargin ?? 10} onChange={(e) => update({ bottomMargin: Number(e.target.value) })} />
            </Row>
            <h4 className="cs-subhead">Lines</h4>
            <Check label="Last price line" checked={draft.priceLineVisible !== false} onChange={(checked) => update({ priceLineVisible: checked })} />
            <Check label="High and low price lines" checked={draft.highLowPriceLines ?? false} onChange={(checked) => update({ highLowPriceLines: checked })} />
            <h4 className="cs-subhead">Time scale</h4>
            <Check label="Corner clock" checked={draft.sessionClock ?? false} onChange={(checked) => update({ sessionClock: checked })} />
            <Check label="Countdown to bar close" checked={draft.barCountdown ?? false} onChange={(checked) => update({ barCountdown: checked })} />
          </>}

          {section === 'appearance' && <>
            <h4 className="cs-subhead">Chart basic styles</h4>
            <Row label="Background">
              <ColorPicker ariaLabel="Canvas background color" value={draft.backgroundColor ?? themeColor('chart-background', themeColor('surface', '#ffffff'))} onChange={(val) => update({ backgroundColor: val })} />
              {draft.backgroundColor && <button type="button" className="cs-link" onClick={() => update({ backgroundColor: undefined })}>Use theme</button>}
            </Row>
            <Check label="Vertical grid lines" checked={draft.verticalGrid} onChange={(checked) => update({ verticalGrid: checked })}>
              <ColorPicker ariaLabel="Vertical grid color" value={draft.vertGridColor ?? themeColor('chart-grid', isDarkTheme() ? '#1f1f22' : '#f2f2f4')} onChange={(val) => update({ vertGridColor: val })} />
              <LineStyleSelect ariaLabel="Vertical grid style" value={draft.vertGridStyle} onChange={(value) => update({ vertGridStyle: value })} />
            </Check>
            <Check label="Horizontal grid lines" checked={draft.horizontalGrid} onChange={(checked) => update({ horizontalGrid: checked })}>
              <ColorPicker ariaLabel="Horizontal grid color" value={draft.horzGridColor ?? themeColor('chart-grid', isDarkTheme() ? '#1f1f22' : '#f2f2f4')} onChange={(val) => update({ horzGridColor: val })} />
              <LineStyleSelect ariaLabel="Horizontal grid style" value={draft.horzGridStyle} onChange={(value) => update({ horzGridStyle: value })} />
            </Check>
            <Check label="Crosshair" checked={draft.crosshair} onChange={(checked) => update({ crosshair: checked })}>
              <ColorPicker ariaLabel="Crosshair color" value={draft.crosshairColor ?? themeColor('chart-crosshair', isDarkTheme() ? '#4a4a50' : '#c7c7cc')} onChange={(val) => update({ crosshairColor: val })} />
              <LineStyleSelect ariaLabel="Crosshair style" value={draft.crosshairStyle} onChange={(value) => update({ crosshairStyle: value })} />
            </Check>
            <Row label="Crosshair transparency" indent>
              <input type="range" min="0" max="100" step="1" aria-label="Transparency" className="cs-range" value={draft.crosshairTransparency ?? 0}
                onChange={(e) => update({ crosshairTransparency: Number(e.target.value) })} />
              <output className="cs-value">{draft.crosshairTransparency ?? 0}%</output>
            </Row>
            <Row label="Crosshair snapping" indent>
              <select aria-label="Crosshair snapping" className="cs-select" value={draft.crosshairMode ?? 'normal'}
                onChange={(event) => update({ crosshairMode: event.target.value as ChartAppearance['crosshairMode'] })}>
                <option value="normal">Free</option>
                <option value="magnet">Close</option>
                <option value="ohlc">OHLC</option>
              </select>
            </Row>
            <Check label="Watermark" checked={draft.watermarkVisible ?? false} onChange={(checked) => update({ watermarkVisible: checked })}>
              <ColorPicker ariaLabel="Watermark color" disabled={!draft.watermarkVisible} value={draft.watermarkColor ?? '#9aa4b2'} onChange={(val) => update({ watermarkColor: val })} />
              <input aria-label="Watermark text" className="cs-input" disabled={!draft.watermarkVisible} placeholder={symbol} value={draft.watermarkText ?? ''} onChange={(e) => update({ watermarkText: e.target.value })} />
            </Check>
            <h4 className="cs-subhead">Scales</h4>
            <Row label="Text">
              <ColorPicker ariaLabel="Scale text color" value={draft.scaleTextColor ?? themeColor('muted', '#86868b')} onChange={(val) => update({ scaleTextColor: val })} />
              <select aria-label="Scale text size" className="cs-select is-narrow" value={draft.scaleFontSize ?? 11} onChange={(e) => update({ scaleFontSize: Number(e.target.value) })}>
                {[10, 11, 12, 13, 14].map(size => <option key={size} value={size}>{size}</option>)}
              </select>
            </Row>
          </>}

          {section === 'trading' && <>
            <h4 className="cs-subhead">Events</h4>
            <Check label="Show published event markers" checked={draft.events ?? false} onChange={(checked) => update({ events: checked })} />
            <p className="cs-note">Earnings, corporate actions and market news appear on the dates they happened.</p>
            <div className="cs-row">
              <button className="cs-button" type="button" onClick={() => { onEvents(); onClose(); }}>View published events</button>
            </div>
          </>}

          {section === 'navigation' && <>
            <h4 className="cs-subhead">Go to</h4>
            <Row label="Date">
              <input aria-label="Go to date" className="cs-input" type="date" min={firstDate} max={lastDate} value={goDate}
                onChange={(event) => { setGoDate(event.target.value); setError(''); }} />
              <button className="cs-button" type="button" disabled={!goDate} onClick={navigate}>Go</button>
            </Row>
            <p className="cs-note">The latest bar is the latest published candle, not a live quote.</p>
            <h4 className="cs-subhead">Mouse and keyboard</h4>
            <Check label="Enable panning" checked={draft.panEnabled !== false} onChange={(checked) => update({ panEnabled: checked })} />
            <Check label="Enable zooming" checked={draft.zoomEnabled !== false} onChange={(checked) => update({ zoomEnabled: checked })} />
            <Row label="Mouse drag">
              <select aria-label="Mouse drag" className="cs-select" value={draft.mousePan ?? 'both'} onChange={(e) => update({ mousePan: e.target.value as 'both' | 'horizontal' })}>
                <option value="both">Time and price</option>
                <option value="horizontal">Horizontal only</option>
              </select>
            </Row>
            <Row label="Default visible bars">
              <input aria-label="Default visible bars" className="cs-input is-number" type="number" min="0" max="100000" step="1" placeholder="All"
                value={draft.defaultVisibleBars || ''} onChange={(e) => update({ defaultVisibleBars: Number(e.target.value) })} />
            </Row>
            <Check label="Combine densely packed bars" checked={draft.conflation ?? false} onChange={(checked) => update({ conflation: checked })} />
          </>}

          {error && <p className="chart-settings-error" role="alert">{error}</p>}
        </div>
      </div>

      <footer className="chart-settings-footer">
        <button type="button" className="cs-link" onClick={reset}>Reset to defaults</button>
        <div className="chart-settings-footer-actions">
          <button type="button" className="cs-button" onClick={cancel}>Cancel</button>
          <button type="button" className="cs-button is-primary" onClick={apply}>Apply</button>
        </div>
      </footer>
    </ChartDialog>
  );
}
