import { useState, useRef, useCallback } from 'react';
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
  { id: 'axes', label: 'Scales', Icon: MoveUpRight },
  { id: 'appearance', label: 'Canvas', Icon: Palette },
  { id: 'trading', label: 'Trading & Events', Icon: CalendarDays },
  { id: 'navigation', label: 'Navigation', Icon: SlidersHorizontal },
];

const styles: readonly [ChartStyle, string][] = [
  ['candles', 'Candles'],
  ['bars', 'HLC bars'],
  ['line', 'Line'],
  ['area', 'Area'],
  ['baseline', 'Baseline'],
];

const TIMEZONES: readonly { label: string; value: string }[] = [
  { label: 'UTC', value: 'UTC' },
  { label: 'Europe/London (GMT/BST)', value: 'Europe/London' },
  { label: 'Europe/Berlin (CET)', value: 'Europe/Berlin' },
  { label: 'Asia/Dubai (GST)', value: 'Asia/Dubai' },
  { label: 'Asia/Kolkata (IST UTC+5:30)', value: 'Asia/Kolkata' },
  { label: 'Asia/Singapore (SGT)', value: 'Asia/Singapore' },
  { label: 'Asia/Hong_Kong (HKT)', value: 'Asia/Hong_Kong' },
  { label: 'Asia/Tokyo (JST)', value: 'Asia/Tokyo' },
  { label: 'Australia/Sydney (AEST)', value: 'Australia/Sydney' },
  { label: 'America/New_York (EST/EDT)', value: 'America/New_York' },
  { label: 'America/Chicago (CST/CDT)', value: 'America/Chicago' },
  { label: 'America/Los_Angeles (PST/PDT)', value: 'America/Los_Angeles' },
];

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
    <label className={`chart-color-swatch${disabled ? ' disabled' : ''}`} title={ariaLabel}>
      <input
        type="color"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="chart-color-swatch-fill" style={{ backgroundColor: value }} />
    </label>
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
  const contentRef = useRef<HTMLDivElement>(null);
  const isClickScrolling = useRef(false);

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

  const scrollToSection = (id: Section) => {
    setSection(id);
    setError('');
    isClickScrolling.current = true;
    const target = contentRef.current?.querySelector(`#settings-${id}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setTimeout(() => {
      isClickScrolling.current = false;
    }, 600);
  };

  const handleContentScroll = useCallback(() => {
    if (isClickScrolling.current || !contentRef.current) return;
    const container = contentRef.current;
    const containerTop = container.getBoundingClientRect().top;
    for (const { id } of sections) {
      const el = container.querySelector<HTMLElement>(`#settings-${id}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top - containerTop <= 100 && rect.bottom - containerTop > 40) {
          setSection(id);
          break;
        }
      }
    }
  }, []);

  const upColor = draft.upColor ?? DEFAULT_UP;
  const downColor = draft.downColor ?? DEFAULT_DOWN;
  const borderUpColor = draft.borderUpColor ?? upColor;
  const borderDownColor = draft.borderDownColor ?? downColor;
  const wickUpColor = draft.wickUpColor ?? upColor;
  const wickDownColor = draft.wickDownColor ?? downColor;

  return (
    <ChartDialog title="Chart settings" onClose={onClose} className="chart-settings-dialog">
      <div className="chart-settings-layout">
        <nav className="chart-settings-nav" aria-label="Chart settings sections">
          {sections.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`chart-settings-nav-btn${section === id ? ' active' : ''}`}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => scrollToSection(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="chart-settings-content" ref={contentRef} onScroll={handleContentScroll}>
          {/* Section: Price / Symbol */}
          <section id="settings-price" aria-labelledby="heading-price" className="chart-settings-section">
            <div className="chart-settings-section-header">
              <h3 id="heading-price">Symbol</h3>
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Chart Type</div>
              <label className="chart-setting-row">
                <span>Chart type</span>
                <select
                  aria-label="Chart type"
                  className="chart-settings-select"
                  value={style}
                  onChange={(event) => handleStyleChange(event.target.value as ChartStyle)}
                >
                  {styles.map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {(style === 'candles' || style === 'bars') && (
              <div className="chart-settings-group">
                <div className="chart-settings-group-title">Candles & Bars</div>
                <div className="chart-setting-pair-row">
                  <label className="chart-setting-pair-label">
                    <input
                      type="checkbox"
                      checked={draft.bodyVisible !== false}
                      onChange={(e) => update({ bodyVisible: e.target.checked })}
                    />
                    <span>Body</span>
                  </label>
                  <div className="chart-color-pair">
                    <ColorPicker
                      ariaLabel="Candle up body color"
                      value={upColor}
                      onChange={(val) => update({ upColor: val })}
                    />
                    <ColorPicker
                      ariaLabel="Candle down body color"
                      value={downColor}
                      onChange={(val) => update({ downColor: val })}
                    />
                  </div>
                </div>

                {style === 'candles' && (
                  <>
                    <div className="chart-setting-pair-row">
                      <label className="chart-setting-pair-label">
                        <input
                          type="checkbox"
                          checked={draft.borderVisible !== false}
                          onChange={(e) => update({ borderVisible: e.target.checked })}
                        />
                        <span>Borders</span>
                      </label>
                      <div className="chart-color-pair">
                        <ColorPicker
                          ariaLabel="Border up color"
                          value={borderUpColor}
                          onChange={(val) => update({ borderUpColor: val })}
                        />
                        <ColorPicker
                          ariaLabel="Border down color"
                          value={borderDownColor}
                          onChange={(val) => update({ borderDownColor: val })}
                        />
                      </div>
                    </div>

                    <div className="chart-setting-pair-row">
                      <label className="chart-setting-pair-label">
                        <input
                          type="checkbox"
                          checked={draft.wickVisible !== false}
                          onChange={(e) => update({ wickVisible: e.target.checked })}
                        />
                        <span>Wick</span>
                      </label>
                      <div className="chart-color-pair">
                        <ColorPicker
                          ariaLabel="Wick up color"
                          value={wickUpColor}
                          onChange={(val) => update({ wickUpColor: val })}
                        />
                        <ColorPicker
                          ariaLabel="Wick down color"
                          value={wickDownColor}
                          onChange={(val) => update({ wickDownColor: val })}
                        />
                      </div>
                    </div>
                  </>
                )}

                <label className="chart-setting-toggle">
                  <input
                    type="checkbox"
                    checked={draft.colorByPreviousClose ?? false}
                    onChange={(e) => update({ colorByPreviousClose: e.target.checked })}
                  />
                  <span>Color from previous close</span>
                </label>
              </div>
            )}

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Values</div>
              <label className="chart-setting-row">
                <span>Precision</span>
                <select
                  aria-label="Precision"
                  className="chart-settings-select"
                  value={draft.precision ?? 'default'}
                  onChange={(e) => update({ precision: e.target.value })}
                >
                  <option value="default">Default</option>
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.priceLineVisible !== false}
                  onChange={(e) => update({ priceLineVisible: e.target.checked })}
                />
                <span>Last price line</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.highLowPriceLines ?? false}
                  onChange={(e) => update({ highLowPriceLines: e.target.checked })}
                />
                <span>High and low price lines</span>
              </label>
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Compare</div>
              <div className="chart-setting-row chart-setting-action">
                <span>Compare symbol</span>
                <div className="chart-setting-input-btn">
                  <input
                    aria-label="Compare symbol"
                    placeholder="e.g. TCS"
                    value={compareSymbol}
                    maxLength={40}
                    onChange={(event) => setCompareSymbol(event.target.value.toUpperCase())}
                  />
                  <button type="button" className="chart-settings-secondary" onClick={addComparison}>
                    Add
                  </button>
                </div>
              </div>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  aria-label="Comparison in synced pane"
                  checked={compareSeparate}
                  onChange={(event) => handleCompareSeparateChange(event.target.checked)}
                />
                <span>Comparison in synced pane</span>
              </label>
            </div>
          </section>

          {/* Section: Readout & Status Line */}
          <section id="settings-readout" aria-labelledby="heading-readout" className="chart-settings-section">
            <div className="chart-settings-section-header">
              <h3 id="heading-readout">Status line</h3>
            </div>
            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Readout Elements</div>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.statusLogo !== false}
                  onChange={(e) => update({ statusLogo: e.target.checked })}
                />
                <span>Logo</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.statusTitle !== false}
                  onChange={(e) => update({ statusTitle: e.target.checked })}
                />
                <span>Title</span>
              </label>
              <label className="chart-setting-row chart-setting-indent">
                <span>Title shows</span>
                <select
                  className="chart-settings-select"
                  value={draft.statusTitleMode ?? 'symbol'}
                  onChange={(e) => update({ statusTitleMode: e.target.value as 'symbol' | 'description' | 'ticker' })}
                >
                  <option value="symbol">Symbol</option>
                  <option value="description">Description</option>
                  <option value="ticker">Ticker</option>
                </select>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.statusMarketStatus !== false}
                  onChange={(e) => update({ statusMarketStatus: e.target.checked })}
                />
                <span>Market status</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.statusOhlc !== false}
                  onChange={(e) => update({ statusOhlc: e.target.checked })}
                />
                <span>Open, high, low, close</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.statusBarChange !== false}
                  onChange={(e) => update({ statusBarChange: e.target.checked })}
                />
                <span>Bar change values</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.volume}
                  onChange={(event) => update({ volume: event.target.checked })}
                />
                <span>Volume</span>
              </label>
              <label className="chart-setting-toggle chart-setting-indent">
                <input
                  type="checkbox"
                  aria-label="Volume in separate pane"
                  disabled={!draft.volume}
                  checked={draft.volumePane ?? false}
                  onChange={(event) => update({ volumePane: event.target.checked })}
                />
                <span>Volume in separate pane</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.statusIndicators !== false}
                  onChange={(e) => update({ statusIndicators: e.target.checked })}
                />
                <span>Indicator values</span>
              </label>
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Background</div>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.statusBackground ?? false}
                  onChange={(e) => update({ statusBackground: e.target.checked })}
                />
                <span>Background plate</span>
              </label>
              {draft.statusBackground && (
                <>
                  <div className="chart-setting-row">
                    <span>Background color</span>
                    <ColorPicker
                      ariaLabel="Background color"
                      value={draft.statusBackgroundColor ?? '#131722'}
                      onChange={(val) => update({ statusBackgroundColor: val })}
                    />
                  </div>
                  <label className="chart-setting-row">
                    <span>Opacity</span>
                    <input
                      type="number"
                      min="0.1"
                      max="1.0"
                      step="0.05"
                      value={draft.statusBackgroundOpacity ?? 0.8}
                      onChange={(e) => update({ statusBackgroundOpacity: Number(e.target.value) })}
                    />
                  </label>
                </>
              )}
            </div>
          </section>

          {/* Section: Axes & Scales */}
          <section id="settings-axes" aria-labelledby="heading-axes" className="chart-settings-section">
            <div className="chart-settings-section-header">
              <h3 id="heading-axes">Scales</h3>
            </div>
            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Navigation & Drag</div>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.panEnabled !== false}
                  onChange={(e) => update({ panEnabled: e.target.checked })}
                />
                <span>Enable panning</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.zoomEnabled !== false}
                  onChange={(e) => update({ zoomEnabled: e.target.checked })}
                />
                <span>Enable zooming</span>
              </label>
              <label className="chart-setting-row">
                <span>Mouse drag</span>
                <select
                  className="chart-settings-select"
                  value={draft.mousePan ?? 'both'}
                  onChange={(e) => update({ mousePan: e.target.value as 'both' | 'horizontal' })}
                >
                  <option value="both">Time and price</option>
                  <option value="horizontal">Horizontal only</option>
                </select>
              </label>
              <label className="chart-setting-row">
                <span>Default visible bars (0 = all)</span>
                <input
                  type="number"
                  min="0"
                  max="100000"
                  step="1"
                  value={draft.defaultVisibleBars ?? 0}
                  onChange={(e) => update({ defaultVisibleBars: Number(e.target.value) })}
                />
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.conflation ?? false}
                  onChange={(event) => update({ conflation: event.target.checked })}
                />
                <span>Combine densely packed bars</span>
              </label>
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Price Scale</div>
              <label className="chart-setting-row">
                <span>Price scale mode</span>
                <select
                  aria-label="Price scale"
                  className="chart-settings-select"
                  value={draft.scaleMode}
                  onChange={(event) => update({ scaleMode: event.target.value as ScaleMode })}
                >
                  <option value="normal">Regular</option>
                  <option value="logarithmic">Logarithmic</option>
                  <option value="percentage">Percentage</option>
                  <option value="indexed">Indexed to 100</option>
                </select>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.invertScale ?? false}
                  onChange={(e) => update({ invertScale: e.target.checked })}
                />
                <span>Invert price scale</span>
              </label>
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Time Axis</div>
              <label className="chart-setting-row">
                <span>Timezone</span>
                <select
                  aria-label="Timezone"
                  className="chart-settings-select"
                  value={draft.timezone ?? 'Asia/Kolkata'}
                  onChange={(e) => update({ timezone: e.target.value })}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.sessionClock ?? false}
                  onChange={(e) => update({ sessionClock: e.target.checked })}
                />
                <span>Corner clock</span>
              </label>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.barCountdown ?? false}
                  onChange={(e) => update({ barCountdown: e.target.checked })}
                />
                <span>Countdown to bar close</span>
              </label>
            </div>
          </section>

          {/* Section: Canvas / Appearance */}
          <section id="settings-appearance" aria-labelledby="heading-appearance" className="chart-settings-section">
            <div className="chart-settings-section-header">
              <h3 id="heading-appearance">Canvas</h3>
            </div>
            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Watermark</div>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.watermarkVisible ?? false}
                  onChange={(e) => update({ watermarkVisible: e.target.checked })}
                />
                <span>Show watermark</span>
              </label>
              {draft.watermarkVisible && (
                <>
                  <label className="chart-setting-row">
                    <span>Text (blank uses symbol)</span>
                    <input
                      placeholder={symbol}
                      value={draft.watermarkText ?? ''}
                      onChange={(e) => update({ watermarkText: e.target.value })}
                    />
                  </label>
                  <div className="chart-setting-row">
                    <span>Color</span>
                    <ColorPicker
                      ariaLabel="Watermark color"
                      value={draft.watermarkColor ?? '#9aa4b2'}
                      onChange={(val) => update({ watermarkColor: val })}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Grid Lines</div>
              <div className="chart-setting-row">
                <label className="chart-setting-toggle" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={draft.verticalGrid}
                    onChange={(event) => update({ verticalGrid: event.target.checked })}
                  />
                  <span>Vertical grid</span>
                </label>
                <ColorPicker
                  ariaLabel="Vertical grid color"
                  value={draft.vertGridColor ?? '#2a2e39'}
                  onChange={(val) => update({ vertGridColor: val })}
                />
              </div>
              <div className="chart-setting-row">
                <label className="chart-setting-toggle" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={draft.horizontalGrid}
                    onChange={(event) => update({ horizontalGrid: event.target.checked })}
                  />
                  <span>Horizontal grid</span>
                </label>
                <ColorPicker
                  ariaLabel="Horizontal grid color"
                  value={draft.horzGridColor ?? '#2a2e39'}
                  onChange={(val) => update({ horzGridColor: val })}
                />
              </div>
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Crosshair</div>
              <label className="chart-setting-toggle">
                <input
                  type="checkbox"
                  checked={draft.crosshair}
                  onChange={(event) => update({ crosshair: event.target.checked })}
                />
                <span>Crosshair lines and labels</span>
              </label>
              <label className="chart-setting-row">
                <span>Crosshair snapping</span>
                <select
                  aria-label="Crosshair snapping"
                  className="chart-settings-select"
                  value={draft.crosshairMode ?? 'normal'}
                  onChange={(event) => update({ crosshairMode: event.target.value as ChartAppearance['crosshairMode'] })}
                >
                  <option value="normal">Free</option>
                  <option value="magnet">Close</option>
                  <option value="ohlc">OHLC</option>
                </select>
              </label>
            </div>

            <div className="chart-settings-group">
              <div className="chart-settings-group-title">Plot Margins</div>
              <label className="chart-setting-row">
                <span>Top margin %</span>
                <input
                  type="number"
                  min="0"
                  max="49"
                  value={draft.topMargin ?? 13}
                  onChange={(e) => update({ topMargin: Number(e.target.value) })}
                />
              </label>
              <label className="chart-setting-row">
                <span>Bottom margin %</span>
                <input
                  type="number"
                  min="0"
                  max="49"
                  value={draft.bottomMargin ?? 10}
                  onChange={(e) => update({ bottomMargin: Number(e.target.value) })}
                />
              </label>
            </div>
          </section>

          {/* Section: Trading & Events */}
          <section id="settings-trading" aria-labelledby="heading-trading" className="chart-settings-section">
            <div className="chart-settings-section-header">
              <h3 id="heading-trading">Trading & Events</h3>
            </div>
            <label className="chart-setting-toggle">
              <input
                type="checkbox"
                checked={draft.events ?? false}
                onChange={(event) => update({ events: event.target.checked })}
              />
              <span>Show published event markers</span>
            </label>
            <p className="chart-settings-note">
              Earnings, corporate actions and market news appear on the dates they occurred in history.
            </p>
            <button
              className="chart-settings-secondary"
              type="button"
              onClick={() => {
                onEvents();
                onClose();
              }}
            >
              View published events
            </button>
          </section>

          {/* Section: Navigation */}
          <section id="settings-navigation" aria-labelledby="heading-navigation" className="chart-settings-section">
            <div className="chart-settings-section-header">
              <h3 id="heading-navigation">Navigation</h3>
            </div>
            <div className="chart-setting-row chart-setting-action">
              <span>Go to date</span>
              <div className="chart-setting-input-btn">
                <input
                  aria-label="Go to date"
                  type="date"
                  min={firstDate}
                  max={lastDate}
                  value={goDate}
                  onChange={(event) => {
                    setGoDate(event.target.value);
                    setError('');
                  }}
                />
                <button
                  className="chart-settings-secondary"
                  type="button"
                  disabled={!goDate}
                  onClick={navigate}
                >
                  Go
                </button>
              </div>
            </div>
            <p className="chart-settings-note">The latest bar is the latest published candle, not a live quote.</p>
          </section>

          {error && <p className="chart-settings-error" role="alert">{error}</p>}
        </div>
      </div>

      <footer className="chart-settings-footer">
        <div className="chart-settings-footer-actions">
          <button type="button" className="chart-settings-secondary" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="chart-settings-apply" onClick={apply}>
            Apply
          </button>
        </div>
      </footer>
    </ChartDialog>
  );
}
