import React, { useState } from 'react';
import { RotateCcw, Plus, Trash2 } from 'lucide-react';
import type {
  StudyConfigs,
  PriceSource,
  PlotLineStyle,
  IndicatorVisibility,
} from '../chart/studyConfigs';
import { SIMPLE_VOLUME_COLORS, defaultStudyConfigs, defaultVisibility } from '../chart/studyConfigs';
import { defaultEmaLines, type EmaLine } from '../chart/model';
import type { ChartAppearance } from '../chart/ChartEngine';
import { ChartDialog } from './ChartDialog';

export interface IndicatorSettingsModalProps {
  indicatorId: string;
  configs: StudyConfigs;
  emaLines: EmaLine[];
  appearance: ChartAppearance;
  onApplyConfigs: (configs: StudyConfigs) => void;
  onApplyEmaLines: (lines: EmaLine[]) => void;
  onApplyAppearance: (app: Partial<ChartAppearance>) => void;
  onClose: () => void;
}

const INDICATOR_TITLES: Record<string, string> = {
  rsi: 'RSI Settings',
  macd: 'MACD Settings',
  supertrend: 'Supertrend Settings',
  bollinger: 'Bollinger Bands Settings',
  sma: 'SMA Settings',
  atr: 'ATR Settings',
  stochastic: 'Stochastic Oscillator Settings',
  vwap: 'Monthly VWAP Settings',
  volume: 'Volume Settings',
  ema: 'EMA Settings',
};

function SourceSelect({
  value,
  onChange,
}: {
  value?: PriceSource;
  onChange: (val: PriceSource) => void;
}) {
  return (
    <div className="setting-field-row">
      <label htmlFor="source-select">Source</label>
      <select
        id="source-select"
        value={value ?? 'close'}
        onChange={e => onChange(e.target.value as PriceSource)}
        className="setting-select"
      >
        <option value="close">Close</option>
        <option value="open">Open</option>
        <option value="high">High</option>
        <option value="low">Low</option>
        <option value="hl2">(High + Low) / 2</option>
        <option value="hlc3">(High + Low + Close) / 3</option>
        <option value="ohlc4">(Open + High + Low + Close) / 4</option>
      </select>
    </div>
  );
}

function PrecisionSelect({
  value,
  onChange,
}: {
  value?: number;
  onChange: (val: number) => void;
}) {
  return (
    <div className="setting-field-row">
      <label htmlFor="precision-select">Precision</label>
      <select
        id="precision-select"
        value={value ?? 2}
        onChange={e => onChange(Number(e.target.value))}
        className="setting-select"
      >
        <option value={0}>0 (Integer)</option>
        <option value={1}>1 (0.0)</option>
        <option value={2}>2 (0.00 - Default)</option>
        <option value={3}>3 (0.000)</option>
        <option value={4}>4 (0.0000)</option>
      </select>
    </div>
  );
}

function PlotStyleRow({
  label,
  visible = true,
  onVisibleChange,
  color,
  onColorChange,
  lineWidth = 1,
  onLineWidthChange,
  lineStyle = 'solid',
  onLineStyleChange,
  onDelete,
}: {
  label: string;
  visible?: boolean;
  onVisibleChange?: (v: boolean) => void;
  color: string;
  onColorChange: (c: string) => void;
  lineWidth?: number;
  onLineWidthChange?: (w: number) => void;
  lineStyle?: PlotLineStyle;
  onLineStyleChange?: (s: PlotLineStyle) => void;
  onDelete?: () => void;
}) {
  return (
    <div className="setting-plot-row">
      <label className="setting-plot-label">
        {onVisibleChange && (
          <input
            type="checkbox"
            checked={visible}
            onChange={e => onVisibleChange(e.target.checked)}
            className="setting-checkbox"
          />
        )}
        <span>{label}</span>
      </label>
      <div className="setting-plot-controls">
        <input
          type="color"
          value={color}
          onChange={e => onColorChange(e.target.value)}
          className="setting-color-picker"
          title={`${label} color`}
        />
        {onLineWidthChange && (
          <select
            value={lineWidth}
            onChange={e => onLineWidthChange(Number(e.target.value))}
            className="setting-select-sm"
            title="Thickness"
          >
            <option value={1}>1px</option>
            <option value={2}>2px</option>
            <option value={3}>3px</option>
            <option value={4}>4px</option>
          </select>
        )}
        {onLineStyleChange && (
          <select
            value={lineStyle}
            onChange={e => onLineStyleChange(e.target.value as PlotLineStyle)}
            className="setting-select-sm"
            title="Style"
          >
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
          </select>
        )}
        {onDelete && (
          <button
            type="button"
            className="setting-item-delete-btn"
            onClick={onDelete}
            title="Remove line"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function VisibilityTab({
  visibility,
  onChange,
}: {
  visibility?: IndicatorVisibility;
  onChange: (v: IndicatorVisibility) => void;
}) {
  const vis = visibility ?? defaultVisibility();
  return (
    <div className="indicator-settings-section">
      <p className="setting-section-desc">
        Toggle which chart timeframes this indicator should appear on:
      </p>
      <div className="setting-visibility-grid">
        <label className="setting-visibility-item">
          <input
            type="checkbox"
            checked={vis.intraday !== false}
            onChange={e => onChange({ ...vis, intraday: e.target.checked })}
            className="setting-checkbox"
          />
          <div className="setting-visibility-text">
            <strong>Minutes / Intraday</strong>
            <span>&lt; 1D (1m, 5m, 15m, 1h)</span>
          </div>
        </label>
        <label className="setting-visibility-item">
          <input
            type="checkbox"
            checked={vis.daily !== false}
            onChange={e => onChange({ ...vis, daily: e.target.checked })}
            className="setting-checkbox"
          />
          <div className="setting-visibility-text">
            <strong>Daily</strong>
            <span>1D timeframe</span>
          </div>
        </label>
        <label className="setting-visibility-item">
          <input
            type="checkbox"
            checked={vis.weekly !== false}
            onChange={e => onChange({ ...vis, weekly: e.target.checked })}
            className="setting-checkbox"
          />
          <div className="setting-visibility-text">
            <strong>Weekly</strong>
            <span>1W timeframe</span>
          </div>
        </label>
        <label className="setting-visibility-item">
          <input
            type="checkbox"
            checked={vis.monthly !== false}
            onChange={e => onChange({ ...vis, monthly: e.target.checked })}
            className="setting-checkbox"
          />
          <div className="setting-visibility-text">
            <strong>Monthly</strong>
            <span>1M timeframe</span>
          </div>
        </label>
      </div>
    </div>
  );
}

export function IndicatorSettingsModal({
  indicatorId,
  configs,
  emaLines,
  appearance,
  onApplyConfigs,
  onApplyEmaLines,
  onApplyAppearance,
  onClose,
}: IndicatorSettingsModalProps) {
  const normId = indicatorId.startsWith('ema') ? 'ema' : indicatorId;
  const title = INDICATOR_TITLES[normId] || `${normId.toUpperCase()} Settings`;

  const [activeTab, setActiveTab] = useState<'inputs' | 'style' | 'visibility'>('inputs');
  const defaults = defaultStudyConfigs();

  // Local draft states
  const [draftConfigs, setDraftConfigs] = useState<StudyConfigs>(() => ({
    ...defaults,
    ...configs,
    rsi: { ...defaults.rsi!, ...configs.rsi },
    macd: { ...defaults.macd!, ...configs.macd },
    supertrend: { ...defaults.supertrend!, ...configs.supertrend },
    bollinger: { ...defaults.bollinger!, ...configs.bollinger },
    sma: { ...defaults.sma!, ...configs.sma },
    atr: { ...defaults.atr!, ...configs.atr },
    stochastic: { ...defaults.stochastic!, ...configs.stochastic },
    vwap: { ...defaults.vwap!, ...configs.vwap },
    volume: { ...defaults.volume!, ...configs.volume },
  }));

  const [draftEmaLines, setDraftEmaLines] = useState<EmaLine[]>(() =>
    emaLines.length > 0 ? emaLines.map(l => ({ ...l })) : defaultEmaLines()
  );

  const [volSeparate, setVolSeparate] = useState<boolean>(appearance.volumePane ?? true);

  const handleResetDefaults = () => {
    if (normId === 'ema') {
      setDraftEmaLines(defaultEmaLines());
      return;
    }
    if (normId in defaults) {
      setDraftConfigs(prev => ({
        ...prev,
        [normId]: defaults[normId as keyof StudyConfigs],
      }));
    }
    if (normId === 'volume') {
      setVolSeparate(true);
    }
  };

  const handleApply = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (normId === 'ema') {
      onApplyEmaLines(draftEmaLines);
    } else {
      onApplyConfigs(draftConfigs);
      if (normId === 'volume') {
        onApplyAppearance({ volumePane: volSeparate });
      }
    }
    onClose();
  };

  const currentVisibility: IndicatorVisibility =
    normId === 'ema'
      ? defaultVisibility()
      : (draftConfigs[normId as keyof StudyConfigs] as { visibility?: IndicatorVisibility })?.visibility ?? defaultVisibility();

  const handleVisibilityChange = (v: IndicatorVisibility) => {
    if (normId === 'ema') return;
    setDraftConfigs(prev => ({
      ...prev,
      [normId]: {
        ...(prev[normId as keyof StudyConfigs] as any),
        visibility: v,
      },
    }));
  };

  return (
    <ChartDialog title={title} className="indicator-settings-dialog" onClose={onClose}>
      <div className="indicator-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'inputs'}
          className={`indicator-settings-tab${activeTab === 'inputs' ? ' active' : ''}`}
          onClick={() => setActiveTab('inputs')}
        >
          Inputs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'style'}
          className={`indicator-settings-tab${activeTab === 'style' ? ' active' : ''}`}
          onClick={() => setActiveTab('style')}
        >
          Style
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'visibility'}
          className={`indicator-settings-tab${activeTab === 'visibility' ? ' active' : ''}`}
          onClick={() => setActiveTab('visibility')}
        >
          Visibility
        </button>
      </div>

      <div className="indicator-settings-body">
        <form onSubmit={handleApply} className="indicator-settings-form">
          {activeTab === 'inputs' && (
            <div className="indicator-settings-section">
              {/* EMA Inputs */}
              {normId === 'ema' && (
                <>
                  {draftEmaLines.map((line, idx) => (
                    <div key={line.id} className="setting-field-row">
                      <label htmlFor={`ema-period-${line.id}`}>{`EMA ${idx + 1} Period`}</label>
                      <input
                        id={`ema-period-${line.id}`}
                        type="number"
                        min={1}
                        max={500}
                        value={line.period}
                        onChange={e => {
                          const val = Number(e.target.value) || 1;
                          setDraftEmaLines(prev =>
                            prev.map(l => (l.id === line.id ? { ...l, period: val } : l))
                          );
                        }}
                      />
                    </div>
                  ))}
                </>
              )}

              {/* RSI Inputs */}
              {normId === 'rsi' && (
                <>
                  <div className="setting-field-row">
                    <label htmlFor="rsi-period">Length (Period)</label>
                    <input
                      id="rsi-period"
                      type="number"
                      min={1}
                      max={500}
                      value={draftConfigs.rsi?.period ?? 14}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          rsi: { ...prev.rsi!, period: Number(e.target.value) || 14 },
                        }))
                      }
                    />
                  </div>
                  <SourceSelect
                    value={draftConfigs.rsi?.source}
                    onChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, source: s },
                      }))
                    }
                  />
                </>
              )}

              {/* MACD Inputs */}
              {normId === 'macd' && (
                <>
                  <div className="setting-field-row">
                    <label htmlFor="macd-fast">Fast Length</label>
                    <input
                      id="macd-fast"
                      type="number"
                      min={1}
                      max={500}
                      value={draftConfigs.macd?.fast ?? 12}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          macd: { ...prev.macd!, fast: Number(e.target.value) || 12 },
                        }))
                      }
                    />
                  </div>
                  <div className="setting-field-row">
                    <label htmlFor="macd-slow">Slow Length</label>
                    <input
                      id="macd-slow"
                      type="number"
                      min={1}
                      max={500}
                      value={draftConfigs.macd?.slow ?? 26}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          macd: { ...prev.macd!, slow: Number(e.target.value) || 26 },
                        }))
                      }
                    />
                  </div>
                  <div className="setting-field-row">
                    <label htmlFor="macd-signal">Signal Smoothing</label>
                    <input
                      id="macd-signal"
                      type="number"
                      min={1}
                      max={500}
                      value={draftConfigs.macd?.signal ?? 9}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          macd: { ...prev.macd!, signal: Number(e.target.value) || 9 },
                        }))
                      }
                    />
                  </div>
                  <SourceSelect
                    value={draftConfigs.macd?.source}
                    onChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, source: s },
                      }))
                    }
                  />
                </>
              )}

              {/* Supertrend Inputs */}
              {normId === 'supertrend' && (
                <>
                  <div className="setting-field-row">
                    <label htmlFor="st-period">ATR Period</label>
                    <input
                      id="st-period"
                      type="number"
                      min={1}
                      max={200}
                      value={draftConfigs.supertrend?.period ?? 10}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          supertrend: {
                            ...prev.supertrend!,
                            period: Number(e.target.value) || 10,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="setting-field-row">
                    <label htmlFor="st-mult">Multiplier</label>
                    <input
                      id="st-mult"
                      type="number"
                      min={0.1}
                      max={20}
                      step={0.1}
                      value={draftConfigs.supertrend?.multiplier ?? 3}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          supertrend: {
                            ...prev.supertrend!,
                            multiplier: Number(e.target.value) || 3,
                          },
                        }))
                      }
                    />
                  </div>
                </>
              )}

              {/* Bollinger Bands Inputs */}
              {normId === 'bollinger' && (
                <>
                  <div className="setting-field-row">
                    <label htmlFor="bb-period">Length (Period)</label>
                    <input
                      id="bb-period"
                      type="number"
                      min={1}
                      max={200}
                      value={draftConfigs.bollinger?.period ?? 20}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          bollinger: {
                            ...prev.bollinger!,
                            period: Number(e.target.value) || 20,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="setting-field-row">
                    <label htmlFor="bb-mult">StdDev Multiplier</label>
                    <input
                      id="bb-mult"
                      type="number"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={draftConfigs.bollinger?.multiplier ?? 2}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          bollinger: {
                            ...prev.bollinger!,
                            multiplier: Number(e.target.value) || 2,
                          },
                        }))
                      }
                    />
                  </div>
                  <SourceSelect
                    value={draftConfigs.bollinger?.source}
                    onChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, source: s },
                      }))
                    }
                  />
                </>
              )}

              {/* SMA Inputs */}
              {normId === 'sma' && (
                <>
                  <div className="setting-field-row">
                    <label htmlFor="sma-period">Length (Period)</label>
                    <input
                      id="sma-period"
                      type="number"
                      min={1}
                      max={500}
                      value={draftConfigs.sma?.period ?? 50}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          sma: { ...prev.sma!, period: Number(e.target.value) || 50 },
                        }))
                      }
                    />
                  </div>
                  <SourceSelect
                    value={draftConfigs.sma?.source}
                    onChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        sma: { ...prev.sma!, source: s },
                      }))
                    }
                  />
                </>
              )}

              {/* ATR Inputs */}
              {normId === 'atr' && (
                <div className="setting-field-row">
                  <label htmlFor="atr-period">Length (Period)</label>
                  <input
                    id="atr-period"
                    type="number"
                    min={1}
                    max={200}
                    value={draftConfigs.atr?.period ?? 14}
                    onChange={e =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        atr: { ...prev.atr!, period: Number(e.target.value) || 14 },
                      }))
                    }
                  />
                </div>
              )}

              {/* Stochastic Inputs */}
              {normId === 'stochastic' && (
                <>
                  <div className="setting-field-row">
                    <label htmlFor="stoch-period">%K Length</label>
                    <input
                      id="stoch-period"
                      type="number"
                      min={1}
                      max={200}
                      value={draftConfigs.stochastic?.period ?? 14}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          stochastic: {
                            ...prev.stochastic!,
                            period: Number(e.target.value) || 14,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="setting-field-row">
                    <label htmlFor="stoch-dperiod">%D Smoothing</label>
                    <input
                      id="stoch-dperiod"
                      type="number"
                      min={1}
                      max={50}
                      value={draftConfigs.stochastic?.dPeriod ?? 3}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          stochastic: {
                            ...prev.stochastic!,
                            dPeriod: Number(e.target.value) || 3,
                          },
                        }))
                      }
                    />
                  </div>
                </>
              )}

              {/* VWAP Inputs */}
              {normId === 'vwap' && (
                <div className="setting-field-row">
                  <label>Anchor Period</label>
                  <input
                    type="text"
                    disabled
                    value="Monthly (Calendar)"
                    className="setting-read-only"
                  />
                </div>
              )}

              {/* Volume Inputs */}
              {normId === 'volume' && (
                <div className="setting-field-row">
                  <label>Pane Layout</label>
                  <div className="setting-radio-group">
                    <label className="setting-radio-label">
                      <input
                        type="radio"
                        name="volume-pane"
                        checked={!volSeparate}
                        onChange={() => setVolSeparate(false)}
                      />
                      Overlay on price
                    </label>
                    <label className="setting-radio-label">
                      <input
                        type="radio"
                        name="volume-pane"
                        checked={volSeparate}
                        onChange={() => setVolSeparate(true)}
                      />
                      Separate sub-pane
                    </label>
                  </div>
                </div>
              )}
              {normId === 'volume' && (() => {
                const vol = draftConfigs.volume!;
                const setVol = (change: Partial<NonNullable<StudyConfigs['volume']>>) => setDraftConfigs(prev => ({...prev, volume: {...prev.volume!, ...change}}));
                const simple = (vol.mode ?? 'simple') === 'simple';
                return <>
                  <div className="setting-field-row">
                    <label htmlFor="volume-mode">Colouring</label>
                    <select id="volume-mode" aria-label="Volume colouring" value={vol.mode ?? 'simple'} onChange={e => setVol({mode: e.target.value as 'simple' | 'classic'})}>
                      <option value="simple">Simple volume (pocket pivots)</option>
                      <option value="classic">Classic up / down</option>
                    </select>
                  </div>
                  {simple && <>
                    <div className="setting-field-row">
                      <label htmlFor="volume-ppv">Pocket pivot lookback</label>
                      <select id="volume-ppv" aria-label="Pocket pivot lookback" value={vol.ppvLength ?? 10} onChange={e => setVol({ppvLength: Number(e.target.value) as 5 | 10 | 20})}>
                        <option value={5}>5 bars</option>
                        <option value={10}>10 bars</option>
                        <option value={20}>20 bars</option>
                      </select>
                    </div>
                    <div className="setting-field-row">
                      <label htmlFor="volume-ma">Average length</label>
                      <input id="volume-ma" aria-label="Volume average length" type="number" min={5} max={200} value={vol.maLength ?? 50}
                        onChange={e => setVol({maLength: Math.max(5, Math.min(200, Number(e.target.value) || 50))})} />
                    </div>
                    <div className="setting-field-row">
                      <label htmlFor="volume-dry">Dry volume at or below</label>
                      <select id="volume-dry" aria-label="Dry volume fraction" value={vol.dryFraction ?? 0.2} onChange={e => setVol({dryFraction: Number(e.target.value)})}>
                        {[[0.1, '1/10'], [0.2, '1/5'], [0.25, '1/4'], [1 / 3, '1/3']].map(([value, label]) => <option key={label} value={value}>{label} of average</option>)}
                      </select>
                    </div>
                    {([['showDry', 'Show dry volume (orange)'], ['showLabels', 'Highest/lowest volume labels (HVE, HVY, HVQ, Y, Q)'], ['recordUpOnly', 'Sky-blue record bars only on up days'], ['showSnort', 'Bull Snort markers']] as const).map(([key, label]) =>
                      <label key={key} className="setting-visibility-item">
                        <input type="checkbox" checked={key === 'recordUpOnly' ? vol[key] === true : vol[key] !== false} onChange={e => setVol({[key]: e.target.checked})} />
                        {label}
                      </label>)}
                  </>}
                </>;
              })()}
            </div>
          )}

          {activeTab === 'style' && (
            <div className="indicator-settings-section">
              {/* EMA Style */}
              {normId === 'ema' && (
                <>
                  {draftEmaLines.map(line => (
                    <PlotStyleRow
                      key={line.id}
                      label={`EMA ${line.period}`}
                      visible={line.enabled}
                      onVisibleChange={en =>
                        setDraftEmaLines(prev =>
                          prev.map(l => (l.id === line.id ? { ...l, enabled: en } : l))
                        )
                      }
                      color={line.color}
                      onColorChange={col =>
                        setDraftEmaLines(prev =>
                          prev.map(l => (l.id === line.id ? { ...l, color: col } : l))
                        )
                      }
                      lineWidth={line.width}
                      onLineWidthChange={w =>
                        setDraftEmaLines(prev =>
                          prev.map(l => (l.id === line.id ? { ...l, width: w } : l))
                        )
                      }
                      lineStyle={line.style}
                      onLineStyleChange={st =>
                        setDraftEmaLines(prev =>
                          prev.map(l => (l.id === line.id ? { ...l, style: st } : l))
                        )
                      }
                      onDelete={
                        draftEmaLines.length > 1
                          ? () => setDraftEmaLines(prev => prev.filter(l => l.id !== line.id))
                          : undefined
                      }
                    />
                  ))}

                  {draftEmaLines.length < 5 && (
                    <button
                      type="button"
                      className="setting-add-plot-btn"
                      onClick={() =>
                        setDraftEmaLines(prev => [
                          ...prev,
                          {
                            id: crypto.randomUUID(),
                            period: 200,
                            color: '#ec4899',
                            enabled: true,
                            width: 2,
                            style: 'solid',
                            opacity: 1,
                          },
                        ])
                      }
                    >
                      <Plus size={13} />
                      <span>Add EMA Line</span>
                    </button>
                  )}
                </>
              )}

              {/* RSI Style */}
              {normId === 'rsi' && (
                <>
                  <PlotStyleRow
                    label="RSI Line"
                    visible={draftConfigs.rsi?.lineVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, lineVisible: v },
                      }))
                    }
                    color={draftConfigs.rsi?.color ?? '#8b5cf6'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, color: c },
                      }))
                    }
                    lineWidth={draftConfigs.rsi?.lineWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, lineWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.rsi?.lineStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, lineStyle: s },
                      }))
                    }
                  />

                  <div className="setting-field-row">
                    <label htmlFor="rsi-ob">Overbought Level</label>
                    <input
                      id="rsi-ob"
                      type="number"
                      min={50}
                      max={99}
                      value={draftConfigs.rsi?.overbought ?? 70}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          rsi: { ...prev.rsi!, overbought: Number(e.target.value) || 70 },
                        }))
                      }
                    />
                  </div>

                  <div className="setting-field-row">
                    <label htmlFor="rsi-os">Oversold Level</label>
                    <input
                      id="rsi-os"
                      type="number"
                      min={1}
                      max={50}
                      value={draftConfigs.rsi?.oversold ?? 30}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          rsi: { ...prev.rsi!, oversold: Number(e.target.value) || 30 },
                        }))
                      }
                    />
                  </div>

                  <PlotStyleRow
                    label="Threshold Bands"
                    visible={draftConfigs.rsi?.bandsVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, bandsVisible: v },
                      }))
                    }
                    color={draftConfigs.rsi?.bandColor ?? '#aab8c5'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, bandColor: c },
                      }))
                    }
                  />

                  <PrecisionSelect
                    value={draftConfigs.rsi?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        rsi: { ...prev.rsi!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* MACD Style */}
              {normId === 'macd' && (
                <>
                  <PlotStyleRow
                    label="MACD Line"
                    visible={draftConfigs.macd?.macdVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, macdVisible: v },
                      }))
                    }
                    color={draftConfigs.macd?.macdColor ?? '#187669'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, macdColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.macd?.macdWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, macdWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.macd?.macdStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, macdStyle: s },
                      }))
                    }
                  />

                  <PlotStyleRow
                    label="Signal Line"
                    visible={draftConfigs.macd?.signalVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, signalVisible: v },
                      }))
                    }
                    color={draftConfigs.macd?.signalColor ?? '#f59e0b'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, signalColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.macd?.signalWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, signalWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.macd?.signalStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, signalStyle: s },
                      }))
                    }
                  />

                  <PlotStyleRow
                    label="Histogram"
                    visible={draftConfigs.macd?.histVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, histVisible: v },
                      }))
                    }
                    color={draftConfigs.macd?.histColor ?? '#089981'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, histColor: c },
                      }))
                    }
                  />

                  <PrecisionSelect
                    value={draftConfigs.macd?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        macd: { ...prev.macd!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* Supertrend Style */}
              {normId === 'supertrend' && (
                <>
                  <PlotStyleRow
                    label="Bullish Trend"
                    color={draftConfigs.supertrend?.upColor ?? '#089981'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        supertrend: { ...prev.supertrend!, upColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.supertrend?.lineWidth ?? 2}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        supertrend: { ...prev.supertrend!, lineWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.supertrend?.lineStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        supertrend: { ...prev.supertrend!, lineStyle: s },
                      }))
                    }
                  />

                  <PlotStyleRow
                    label="Bearish Trend"
                    color={draftConfigs.supertrend?.downColor ?? '#ef5350'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        supertrend: { ...prev.supertrend!, downColor: c },
                      }))
                    }
                  />

                  <PrecisionSelect
                    value={draftConfigs.supertrend?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        supertrend: { ...prev.supertrend!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* Bollinger Bands Style */}
              {normId === 'bollinger' && (
                <>
                  <PlotStyleRow
                    label="Upper Band"
                    visible={draftConfigs.bollinger?.upperVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, upperVisible: v },
                      }))
                    }
                    color={draftConfigs.bollinger?.upperColor ?? '#78909c'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, upperColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.bollinger?.upperWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, upperWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.bollinger?.upperStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, upperStyle: s },
                      }))
                    }
                  />

                  <PlotStyleRow
                    label="Middle Basis"
                    visible={draftConfigs.bollinger?.middleVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, middleVisible: v },
                      }))
                    }
                    color={draftConfigs.bollinger?.middleColor ?? '#78909c'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, middleColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.bollinger?.middleWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, middleWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.bollinger?.middleStyle ?? 'dashed'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, middleStyle: s },
                      }))
                    }
                  />

                  <PlotStyleRow
                    label="Lower Band"
                    visible={draftConfigs.bollinger?.lowerVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, lowerVisible: v },
                      }))
                    }
                    color={draftConfigs.bollinger?.lowerColor ?? '#78909c'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, lowerColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.bollinger?.lowerWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, lowerWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.bollinger?.lowerStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, lowerStyle: s },
                      }))
                    }
                  />

                  <PrecisionSelect
                    value={draftConfigs.bollinger?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        bollinger: { ...prev.bollinger!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* SMA Style */}
              {normId === 'sma' && (
                <>
                  <PlotStyleRow
                    label="SMA Line"
                    visible={draftConfigs.sma?.visible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        sma: { ...prev.sma!, visible: v },
                      }))
                    }
                    color={draftConfigs.sma?.color ?? '#3b82f6'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        sma: { ...prev.sma!, color: c },
                      }))
                    }
                    lineWidth={draftConfigs.sma?.lineWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        sma: { ...prev.sma!, lineWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.sma?.lineStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        sma: { ...prev.sma!, lineStyle: s },
                      }))
                    }
                  />

                  <PrecisionSelect
                    value={draftConfigs.sma?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        sma: { ...prev.sma!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* ATR Style */}
              {normId === 'atr' && (
                <>
                  <PlotStyleRow
                    label="ATR Line"
                    visible={draftConfigs.atr?.visible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        atr: { ...prev.atr!, visible: v },
                      }))
                    }
                    color={draftConfigs.atr?.color ?? '#e09b26'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        atr: { ...prev.atr!, color: c },
                      }))
                    }
                    lineWidth={draftConfigs.atr?.lineWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        atr: { ...prev.atr!, lineWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.atr?.lineStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        atr: { ...prev.atr!, lineStyle: s },
                      }))
                    }
                  />

                  <PrecisionSelect
                    value={draftConfigs.atr?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        atr: { ...prev.atr!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* Stochastic Style */}
              {normId === 'stochastic' && (
                <>
                  <PlotStyleRow
                    label="%K Line"
                    visible={draftConfigs.stochastic?.kVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, kVisible: v },
                      }))
                    }
                    color={draftConfigs.stochastic?.kColor ?? '#187669'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, kColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.stochastic?.kWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, kWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.stochastic?.kStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, kStyle: s },
                      }))
                    }
                  />

                  <PlotStyleRow
                    label="%D Line"
                    visible={draftConfigs.stochastic?.dVisible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, dVisible: v },
                      }))
                    }
                    color={draftConfigs.stochastic?.dColor ?? '#ef5350'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, dColor: c },
                      }))
                    }
                    lineWidth={draftConfigs.stochastic?.dWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, dWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.stochastic?.dStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, dStyle: s },
                      }))
                    }
                  />

                  <div className="setting-field-row">
                    <label htmlFor="stoch-upper">Upper Band</label>
                    <input
                      id="stoch-upper"
                      type="number"
                      min={50}
                      max={99}
                      value={draftConfigs.stochastic?.upper ?? 80}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          stochastic: {
                            ...prev.stochastic!,
                            upper: Number(e.target.value) || 80,
                          },
                        }))
                      }
                    />
                  </div>

                  <div className="setting-field-row">
                    <label htmlFor="stoch-lower">Lower Band</label>
                    <input
                      id="stoch-lower"
                      type="number"
                      min={1}
                      max={50}
                      value={draftConfigs.stochastic?.lower ?? 20}
                      onChange={e =>
                        setDraftConfigs(prev => ({
                          ...prev,
                          stochastic: {
                            ...prev.stochastic!,
                            lower: Number(e.target.value) || 20,
                          },
                        }))
                      }
                    />
                  </div>

                  <PrecisionSelect
                    value={draftConfigs.stochastic?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        stochastic: { ...prev.stochastic!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* VWAP Style */}
              {normId === 'vwap' && (
                <>
                  <PlotStyleRow
                    label="VWAP Line"
                    visible={draftConfigs.vwap?.visible !== false}
                    onVisibleChange={v =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        vwap: { ...prev.vwap!, visible: v },
                      }))
                    }
                    color={draftConfigs.vwap?.color ?? '#e09b26'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        vwap: { ...prev.vwap!, color: c },
                      }))
                    }
                    lineWidth={draftConfigs.vwap?.lineWidth ?? 1}
                    onLineWidthChange={w =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        vwap: { ...prev.vwap!, lineWidth: w },
                      }))
                    }
                    lineStyle={draftConfigs.vwap?.lineStyle ?? 'solid'}
                    onLineStyleChange={s =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        vwap: { ...prev.vwap!, lineStyle: s },
                      }))
                    }
                  />

                  <PrecisionSelect
                    value={draftConfigs.vwap?.precision}
                    onChange={p =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        vwap: { ...prev.vwap!, precision: p },
                      }))
                    }
                  />
                </>
              )}

              {/* Volume Style */}
              {normId === 'volume' && (draftConfigs.volume?.mode ?? 'simple') === 'simple' && (
                <>
                  {([['ppvColor', 'Pocket pivot', SIMPLE_VOLUME_COLORS.ppv], ['aboveUpColor', 'Up above average', SIMPLE_VOLUME_COLORS.up],
                    ['aboveDownColor', 'Down above average', SIMPLE_VOLUME_COLORS.down], ['dryColor', 'Dry volume', SIMPLE_VOLUME_COLORS.dry],
                    ['noiseColor', 'Other volume', '#7c7c87'], ['snortColor', 'Bull Snort', SIMPLE_VOLUME_COLORS.snort], ['recordColor', 'Highest volume (HVE/HVY/HVQ)', SIMPLE_VOLUME_COLORS.record]] as const).map(([key, label, fallback]) =>
                    <PlotStyleRow key={key} label={label} color={draftConfigs.volume?.[key] ?? fallback}
                      onColorChange={c => setDraftConfigs(prev => ({...prev, volume: {...prev.volume!, [key]: c}}))} />)}
                </>
              )}
              {normId === 'volume' && draftConfigs.volume?.mode === 'classic' && (
                <>
                  <PlotStyleRow
                    label="Up Volume"
                    color={draftConfigs.volume?.upColor ?? '#089981'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        volume: { ...prev.volume!, upColor: c },
                      }))
                    }
                  />
                  <PlotStyleRow
                    label="Down Volume"
                    color={draftConfigs.volume?.downColor ?? '#ef5350'}
                    onColorChange={c =>
                      setDraftConfigs(prev => ({
                        ...prev,
                        volume: { ...prev.volume!, downColor: c },
                      }))
                    }
                  />
                </>
              )}
            </div>
          )}

          {activeTab === 'visibility' && (
            <VisibilityTab
              visibility={currentVisibility}
              onChange={handleVisibilityChange}
            />
          )}

          <footer className="indicator-settings-footer">
            <button
              type="button"
              className="indicator-settings-btn-ghost"
              onClick={handleResetDefaults}
              title="Reset to default settings"
            >
              <RotateCcw size={13} />
              <span>Defaults</span>
            </button>
            <div className="indicator-settings-footer-actions">
              <button
                type="button"
                className="indicator-settings-btn-cancel"
                onClick={onClose}
              >
                Cancel
              </button>
              <button type="submit" className="indicator-settings-btn-apply">
                Apply
              </button>
            </div>
          </footer>
        </form>
      </div>
    </ChartDialog>
  );
}
