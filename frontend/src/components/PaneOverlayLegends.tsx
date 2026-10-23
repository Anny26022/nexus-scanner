import { createPortal } from 'react-dom';
import {
  Eye,
  EyeOff,
  Settings,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Trash2,
  ChevronRight,
} from 'lucide-react';
import { enabledExtraStudies, studyLineColor, studyParams, studyTitle, type ExtraStudies } from '../chart/extraStudies';
import type { ChartEngine, ChartAppearance } from '../chart/ChartEngine';
import type { EmaLine } from '../chart/model';
import type { ChartStudies } from '../chart/studies';
import type { StudyConfigs } from '../chart/studyConfigs';
import {
  computeIndicatorSeries,
  formatIndicatorValue,
  formatRelativeVolume,
  formatVolumeValue,
  type IndicatorSnapshot,
} from '../chart/indicatorValues';

export interface LegendProps {
  engine: ChartEngine | null;
  indicatorSeries: ReturnType<typeof computeIndicatorSeries>;
  snapshotIndex: number;
  studies: ChartStudies;
  studyConfigs?: StudyConfigs;
  emaLines: readonly EmaLine[];
  appearance: ChartAppearance;
  paneOffsets?: Array<{ paneIndex: number; top: number; height: number }>;
  onOpenIndicators: () => void;
  onOpenSettings?: (indicatorId: string) => void;
  onUpdateEmaLines: (lines: EmaLine[]) => void;
  onUpdateStudies: (studies: ChartStudies) => void;
  onUpdateAppearance: (app: Partial<ChartAppearance>) => void;
  hiddenStudies: Readonly<Record<string, boolean>>;
  onToggleStudyVisibility: (id: string) => void;
  onUpdateExtras?: (next: ExtraStudies) => void;
  onUpdateFundamentals?: (next: NonNullable<StudyConfigs['fundamentals']>) => void;
  /** Legend chrome: collapse the indicator rows and hide every indicator at once. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  allHidden?: boolean;
  onToggleAllHidden?: () => void;
}

/**
 * Overlay rows rendered on Pane 0 (Price pane) underneath the OHLC quote
 */
export function PricePaneLegend({
  indicatorSeries,
  snapshotIndex,
  studies,
  studyConfigs,
  emaLines,
  appearance,
  onOpenIndicators,
  onOpenSettings,
  onUpdateEmaLines,
  onUpdateStudies,
  onUpdateAppearance,
  hiddenStudies,
  onToggleStudyVisibility,
  onUpdateExtras,
  onUpdateFundamentals,
  collapsed = false,
  onToggleCollapsed,
  allHidden = false,
  onToggleAllHidden,
}: LegendProps) {
  const openSettings = (id: string) => (onOpenSettings ? onOpenSettings(id) : onOpenIndicators());
  const latest = indicatorSeries.getSnapshot(snapshotIndex);
  const extras = studyConfigs?.extras;
  const overlayExtras = enabledExtraStudies(extras).filter(def => def.pane === 'price');
  const indicatorCount = emaLines.filter(line => line.enabled).length + Object.values(studies).filter(Boolean).length
    + enabledExtraStudies(extras).length + (appearance.volume ? 1 : 0);

  const stCfg = studyConfigs?.supertrend;
  const bbCfg = studyConfigs?.bollinger;
  const smaCfg = studyConfigs?.sma;

  if (collapsed) {
    return <div className="chart-indicator-legend">
      <button type="button" className="chart-legend-toggle" aria-expanded={false} title="Show legend (Alt+L)" onClick={onToggleCollapsed}>
        <ChevronRight size={12} aria-hidden="true" />{indicatorCount} {indicatorCount === 1 ? 'indicator' : 'indicators'}
      </button>
    </div>;
  }

  return (
    <div className="chart-indicator-legend">
      {indicatorCount > 0 && (onToggleCollapsed || onToggleAllHidden) && <div className="chart-legend-tools">
        {onToggleCollapsed && <button type="button" className="chart-legend-toggle" aria-expanded title="Collapse legend (Alt+L)" onClick={onToggleCollapsed}>
          <ChevronDown size={12} aria-hidden="true" />Legend
        </button>}
        {onToggleAllHidden && <button type="button" className="chart-legend-toggle" aria-pressed={allHidden} title={`${allHidden ? 'Show' : 'Hide'} all indicators (Alt+V)`} onClick={onToggleAllHidden}>
          {allHidden ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}{allHidden ? 'Show all' : 'Hide all'}
        </button>}
      </div>}
      {overlayExtras.map(def => {
        const state = extras?.[def.id];
        const params = studyParams(def, state);
        const color = studyLineColor(def.lines[0], state);
        return <div key={def.id} className="chart-indicator-row">
          <span className="chart-indicator-title" style={{color}} onClick={() => openSettings(def.id)}>
            <span className="chart-indicator-bullet">●</span>
            <span>{studyTitle(def, params)}</span>
            {def.lines.map(line => <span key={line.key} className="chart-indicator-val" data-ind-val={`x:${def.id}:${line.key}`} data-ind-precision={def.precision}
              style={{color: studyLineColor(line, state)}}>{formatIndicatorValue(latest.extras[`${def.id}:${line.key}`], def.precision)}</span>)}
          </span>
          <span className="chart-indicator-actions">
            <button type="button" className="chart-indicator-action-btn" title={hiddenStudies[def.id] ? 'Show' : 'Hide'} onClick={() => onToggleStudyVisibility(def.id)}>
              {hiddenStudies[def.id] ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings(def.id)}><Settings size={12} /></button>
            <button type="button" className="chart-indicator-action-btn delete" title="Remove" onClick={() => onUpdateExtras?.({...extras, [def.id]: {...state, enabled: false}})}><Trash2 size={12} /></button>
          </span>
        </div>;
      })}
      {studyConfigs?.fundamentals?.enabled && <div className="chart-indicator-row">
        <span className="chart-indicator-title" style={{color: '#2962ff'}} onClick={() => openSettings('fundamentals')}>
          <span className="chart-indicator-bullet">●</span>
          <span>Price Band & Results</span>
        </span>
        <span className="chart-indicator-actions">
          <button type="button" className="chart-indicator-action-btn" title={hiddenStudies.fundamentals ? 'Show' : 'Hide'} onClick={() => onToggleStudyVisibility('fundamentals')}>
            {hiddenStudies.fundamentals ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings('fundamentals')}><Settings size={12} /></button>
          {onUpdateFundamentals && <button type="button" className="chart-indicator-action-btn delete" title="Remove" onClick={() => onUpdateFundamentals({...studyConfigs.fundamentals!, enabled: false})}><Trash2 size={12} /></button>}
        </span>
      </div>}
      {/* Volume Overlay (when in price pane) */}
      {appearance.volume && !appearance.volumePane && (
        <div className="chart-indicator-row">
          <span className="chart-indicator-title" style={{ color: '#089981' }} onClick={() => openSettings('volume')}>
            <span className="chart-indicator-bullet">●</span>
            <span>Vol</span>
            <span className="chart-indicator-val" data-ind-val="vol">
              {formatVolumeValue(latest.volume)}
            </span>
            {volumeStatPlots(latest).map(plot => <span key={plot.valKey} className="chart-indicator-val chart-volume-stat">
              <span className="chart-pane-val-label">{plot.label}</span> <span data-ind-val={plot.valKey}>{plot.defaultVal}</span>
            </span>)}
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.volume ? 'Show Volume' : 'Hide Volume'}
              onClick={() => onToggleStudyVisibility('volume')}
            >
              {hiddenStudies.volume ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings('volume')}>
              <Settings size={12} />
            </button>
            <button
              type="button"
              className="chart-indicator-action-btn delete"
              title="Remove Volume"
              onClick={() => onUpdateAppearance({ volume: false })}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      )}

      {/* EMA Lines */}
      {emaLines.map(line => {
        const val = latest.ema[line.id];
        return (
          <div key={line.id} className="chart-indicator-row">
            <span
              className="chart-indicator-title"
              style={{ color: line.enabled ? line.color : 'var(--muted)' }}
              onClick={() => openSettings('ema')}
            >
              <span className="chart-indicator-bullet">●</span>
              <span>EMA {line.period}</span>
              <span className="chart-indicator-params">(close)</span>
              {line.enabled && (
                <span className="chart-indicator-val" data-ind-val={`ema-${line.id}`}>
                  {formatIndicatorValue(val)}
                </span>
              )}
            </span>
            <span className="chart-indicator-actions">
              <button
                type="button"
                className="chart-indicator-action-btn"
                title={line.enabled ? 'Hide EMA' : 'Show EMA'}
                onClick={() => {
                  const next = emaLines.map(l => (l.id === line.id ? { ...l, enabled: !l.enabled } : l));
                  onUpdateEmaLines(next);
                }}
              >
                {line.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings('ema')}>
                <Settings size={12} />
              </button>
              <button
                type="button"
                className="chart-indicator-action-btn delete"
                title="Remove"
                onClick={() => {
                  const next = emaLines.filter(l => l.id !== line.id);
                  onUpdateEmaLines(next);
                }}
              >
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        );
      })}

      {/* Supertrend (Pane 0) */}
      {studies.supertrend && (
        <div className="chart-indicator-row">
          <span
            className="chart-indicator-title"
            style={{ color: latest.supertrend?.direction === 1 ? (stCfg?.upColor ?? '#089981') : (stCfg?.downColor ?? '#ef5350') }}
            onClick={() => openSettings('supertrend')}
          >
            <span className="chart-indicator-bullet">●</span>
            <span>Supertrend</span>
            <span className="chart-indicator-params">({stCfg?.period ?? 10}, {stCfg?.multiplier ?? 3})</span>
            <span className="chart-indicator-val" data-ind-val="supertrend">
              {formatIndicatorValue(latest.supertrend?.value, stCfg?.precision)}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.supertrend ? 'Show' : 'Hide'}
              onClick={() => onToggleStudyVisibility('supertrend')}
            >
              {hiddenStudies.supertrend ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings('supertrend')}>
              <Settings size={12} />
            </button>
            <button
              type="button"
              className="chart-indicator-action-btn delete"
              title="Remove"
              onClick={() => onUpdateStudies({ ...studies, supertrend: false })}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      )}

      {/* Bollinger Bands (Pane 0) */}
      {studies.bollinger && (
        <div className="chart-indicator-row">
          <span className="chart-indicator-title" style={{ color: bbCfg?.middleColor ?? '#78909c' }} onClick={() => openSettings('bollinger')}>
            <span className="chart-indicator-bullet">●</span>
            <span>BB</span>
            <span className="chart-indicator-params">({bbCfg?.period ?? 20}, {bbCfg?.multiplier ?? 2})</span>
            <span className="chart-indicator-val">
              {bbCfg?.upperVisible !== false && (
                <span data-ind-val="bb-upper" style={{ color: bbCfg?.upperColor ?? '#78909c' }}>{formatIndicatorValue(latest.bollinger?.upper, bbCfg?.precision)} </span>
              )}
              {bbCfg?.middleVisible !== false && (
                <span data-ind-val="bb-mid" style={{ color: bbCfg?.middleColor ?? '#78909c' }}>{formatIndicatorValue(latest.bollinger?.middle, bbCfg?.precision)} </span>
              )}
              {bbCfg?.lowerVisible !== false && (
                <span data-ind-val="bb-lower" style={{ color: bbCfg?.lowerColor ?? '#78909c' }}>{formatIndicatorValue(latest.bollinger?.lower, bbCfg?.precision)}</span>
              )}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.bollinger ? 'Show' : 'Hide'}
              onClick={() => onToggleStudyVisibility('bollinger')}
            >
              {hiddenStudies.bollinger ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings('bollinger')}>
              <Settings size={12} />
            </button>
            <button
              type="button"
              className="chart-indicator-action-btn delete"
              title="Remove"
              onClick={() => onUpdateStudies({ ...studies, bollinger: false })}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      )}

      {/* SMA 50 (Pane 0) */}
      {studies.sma && smaCfg?.visible !== false && (
        <div className="chart-indicator-row">
          <span className="chart-indicator-title" style={{ color: smaCfg?.color ?? '#3b82f6' }} onClick={() => openSettings('sma')}>
            <span className="chart-indicator-bullet">●</span>
            <span>SMA {smaCfg?.period ?? 50}</span>
            <span className="chart-indicator-params">({smaCfg?.source ?? 'close'})</span>
            <span className="chart-indicator-val" data-ind-val="sma-50">
              {formatIndicatorValue(latest.sma, smaCfg?.precision)}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.sma ? 'Show' : 'Hide'}
              onClick={() => onToggleStudyVisibility('sma')}
            >
              {hiddenStudies.sma ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings('sma')}>
              <Settings size={12} />
            </button>
            <button
              type="button"
              className="chart-indicator-action-btn delete"
              title="Remove"
              onClick={() => onUpdateStudies({ ...studies, sma: false })}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      )}

      {/* Monthly VWAP (Pane 0) */}
      {studies.vwap && studyConfigs?.vwap?.visible !== false && (
        <div className="chart-indicator-row">
          <span className="chart-indicator-title" style={{ color: studyConfigs?.vwap?.color ?? '#e09b26' }} onClick={() => openSettings('vwap')}>
            <span className="chart-indicator-bullet">●</span>
            <span>VWAP</span>
            <span className="chart-indicator-params">(Monthly)</span>
            <span className="chart-indicator-val" data-ind-val="vwap">
              {formatIndicatorValue(latest.vwap, studyConfigs?.vwap?.precision)}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.vwap ? 'Show' : 'Hide'}
              onClick={() => onToggleStudyVisibility('vwap')}
            >
              {hiddenStudies.vwap ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={() => openSettings('vwap')}>
              <Settings size={12} />
            </button>
            <button
              type="button"
              className="chart-indicator-action-btn delete"
              title="Remove"
              onClick={() => onUpdateStudies({ ...studies, vwap: false })}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Dedicated TradingView & OpenAlgo styled sub-pane header bars
 */
export function SubPaneLegends({
  engine,
  indicatorSeries,
  snapshotIndex,
  studies,
  studyConfigs,
  appearance,
  paneOffsets = [],
  onOpenIndicators,
  onOpenSettings,
  onUpdateStudies,
  onUpdateAppearance,
  hiddenStudies,
  onToggleStudyVisibility,
  onUpdateExtras,
}: LegendProps) {
  const openSettings = (id: string) => (onOpenSettings ? onOpenSettings(id) : onOpenIndicators());
  const latest = indicatorSeries.getSnapshot(snapshotIndex);

  const effectiveOffsets = paneOffsets.length > 0 ? paneOffsets : (engine?.getPaneOffsets?.() ?? []);
  const panesCount = engine?.getPanesCount?.() ?? (effectiveOffsets.length > 0 ? Math.max(...effectiveOffsets.map(p => p.paneIndex)) + 1 : 1);
  const maxPaneIndex = Math.max(0, panesCount - 1);

  const getOffset = (paneIdx: number) => {
    const found = effectiveOffsets.find(p => p.paneIndex === paneIdx);
    if (found) return found;
    return { paneIndex: paneIdx, top: Math.max(0, paneIdx * 200), height: 120 };
  };

  const subPanes: Array<{
    id: string;
    title: string;
    params?: string;
    color: string;
    paneIndex: number;
    top: number;
    height: number;
    plots: Array<{ label?: string; valKey: string; color?: string; defaultVal: string; precision?: number }>;
    onRemove?: () => void;
  }> = [];

  if (studies.macd) {
    const paneIdx = engine?.getStudyPaneIndex('macd') ?? 1;
    if (paneIdx > 0) {
      const offset = getOffset(paneIdx);
      const fast = studyConfigs?.macd?.fast ?? 12;
      const slow = studyConfigs?.macd?.slow ?? 26;
      const signal = studyConfigs?.macd?.signal ?? 9;
      const prec = studyConfigs?.macd?.precision ?? 2;
      const plots: Array<{ label?: string; valKey: string; color?: string; defaultVal: string }> = [];
      if (studyConfigs?.macd?.macdVisible !== false) {
        plots.push({
          label: 'MACD',
          valKey: 'macd-line',
          color: studyConfigs?.macd?.macdColor ?? '#187669',
          defaultVal: formatIndicatorValue(latest.macd?.line, prec),
        });
      }
      if (studyConfigs?.macd?.signalVisible !== false) {
        plots.push({
          label: 'Signal',
          valKey: 'macd-signal',
          color: studyConfigs?.macd?.signalColor ?? '#f59e0b',
          defaultVal: formatIndicatorValue(latest.macd?.signal, prec),
        });
      }
      if (studyConfigs?.macd?.histVisible !== false) {
        plots.push({
          label: 'Hist',
          valKey: 'macd-hist',
          color: (latest.macd?.histogram ?? 0) >= 0 ? (studyConfigs?.macd?.histColor ?? '#089981') : '#ef5350',
          defaultVal: formatIndicatorValue(latest.macd?.histogram, prec),
        });
      }
      subPanes.push({
        id: 'macd',
        title: 'MACD',
        params: `(${fast}, ${slow}, ${signal})`,
        color: studyConfigs?.macd?.macdColor ?? '#187669',
        paneIndex: paneIdx,
        top: offset.top,
        height: offset.height,
        plots,
      });
    }
  }

  if (studies.rsi) {
    const paneIdx = engine?.getStudyPaneIndex('rsi') ?? 1;
    if (paneIdx > 0) {
      const offset = getOffset(paneIdx);
      const period = studyConfigs?.rsi?.period ?? 14;
      const prec = studyConfigs?.rsi?.precision ?? 2;
      const plots: Array<{ label?: string; valKey: string; color?: string; defaultVal: string }> = [];
      if (studyConfigs?.rsi?.lineVisible !== false) {
        plots.push({
          valKey: 'rsi',
          color: studyConfigs?.rsi?.color ?? '#8b5cf6',
          defaultVal: formatIndicatorValue(latest.rsi, prec),
        });
      }
      subPanes.push({
        id: 'rsi',
        title: 'RSI',
        params: `(${period})`,
        color: studyConfigs?.rsi?.color ?? '#8b5cf6',
        paneIndex: paneIdx,
        top: offset.top,
        height: offset.height,
        plots,
      });
    }
  }

  if (studies.atr) {
    const paneIdx = engine?.getStudyPaneIndex('atr') ?? 1;
    if (paneIdx > 0) {
      const offset = getOffset(paneIdx);
      const period = studyConfigs?.atr?.period ?? 14;
      const prec = studyConfigs?.atr?.precision ?? 2;
      const plots: Array<{ label?: string; valKey: string; color?: string; defaultVal: string }> = [];
      if (studyConfigs?.atr?.visible !== false) {
        plots.push({
          valKey: 'atr',
          color: studyConfigs?.atr?.color ?? '#e09b26',
          defaultVal: formatIndicatorValue(latest.atr, prec),
        });
      }
      subPanes.push({
        id: 'atr',
        title: 'ATR',
        params: `(${period})`,
        color: studyConfigs?.atr?.color ?? '#e09b26',
        paneIndex: paneIdx,
        top: offset.top,
        height: offset.height,
        plots,
      });
    }
  }

  if (studies.stochastic) {
    const paneIdx = engine?.getStudyPaneIndex('stochastic') ?? 1;
    if (paneIdx > 0) {
      const offset = getOffset(paneIdx);
      const period = studyConfigs?.stochastic?.period ?? 14;
      const dPeriod = studyConfigs?.stochastic?.dPeriod ?? 3;
      const prec = studyConfigs?.stochastic?.precision ?? 2;
      const plots: Array<{ label?: string; valKey: string; color?: string; defaultVal: string }> = [];
      if (studyConfigs?.stochastic?.kVisible !== false) {
        plots.push({
          label: '%K',
          valKey: 'stoch-k',
          color: studyConfigs?.stochastic?.kColor ?? '#187669',
          defaultVal: formatIndicatorValue(latest.stochastic?.k, prec),
        });
      }
      if (studyConfigs?.stochastic?.dVisible !== false) {
        plots.push({
          label: '%D',
          valKey: 'stoch-d',
          color: studyConfigs?.stochastic?.dColor ?? '#ef5350',
          defaultVal: formatIndicatorValue(latest.stochastic?.d, prec),
        });
      }
      subPanes.push({
        id: 'stochastic',
        title: 'Stoch',
        params: `(${period}, ${dPeriod}, 3)`,
        color: studyConfigs?.stochastic?.kColor ?? '#187669',
        paneIndex: paneIdx,
        top: offset.top,
        height: offset.height,
        plots,
      });
    }
  }

  if (appearance.volume && appearance.volumePane) {
    const paneIdx = engine?.getStudyPaneIndex('volume') ?? 1;
    if (paneIdx > 0) {
      const offset = getOffset(paneIdx);
      subPanes.push({
        id: 'volume',
        title: 'Volume',
        color: '#089981',
        paneIndex: paneIdx,
        top: offset.top,
        height: offset.height,
        plots: [
          {
            valKey: 'volume-pane',
            color: 'var(--text)',
            defaultVal: formatVolumeValue(latest.volume),
          },
          ...volumeStatPlots(latest),
        ],
      });
    }
  }

  const extras = studyConfigs?.extras;
  for (const def of enabledExtraStudies(extras).filter(item => item.pane === 'separate')) {
    const paneIdx = engine?.getStudyPaneIndex(def.id) ?? -1;
    if (paneIdx <= 0) continue;
    const state = extras?.[def.id];
    const offset = getOffset(paneIdx);
    const params = studyParams(def, state);
    subPanes.push({
      id: def.id,
      title: def.short,
      params: def.inputs.length ? def.inputs.map(input => params[input.id]).filter(value => value !== 0).join(' ') : undefined,
      color: studyLineColor(def.lines[0], state),
      paneIndex: paneIdx,
      top: offset.top,
      height: offset.height,
      plots: def.lines.map(line => ({
        label: def.lines.length > 1 ? line.label : undefined,
        valKey: `x:${def.id}:${line.key}`,
        color: studyLineColor(line, state),
        defaultVal: formatIndicatorValue(latest.extras[`${def.id}:${line.key}`], def.precision),
        precision: def.precision,
      })),
      onRemove: () => onUpdateExtras?.({...extras, [def.id]: {...state, enabled: false}}),
    });
  }

  if (subPanes.length === 0) return null;

  return (
    <>
      {subPanes.map(pane => {
        const isHidden = !!hiddenStudies[pane.id];
        const targetElement = engine?.getPaneElement?.(pane.paneIndex) ?? null;
        const legendBar = (
          <div
            key={pane.id}
            className={`chart-pane-legend-bar${isHidden ? ' is-hidden' : ''}`}
            style={{
              position: 'absolute',
              top: targetElement ? '6px' : `${Math.max(0, pane.top) + 6}px`,
              left: '12px',
              zIndex: 10,
            }}
          >
            <div className="chart-pane-legend-title" onClick={() => openSettings(pane.id)}>
              <span className="chart-pane-legend-bullet" style={{ color: pane.color }}>
                ●
              </span>
              <span>{pane.title}</span>
              {pane.params && <span className="chart-pane-legend-params">{pane.params}</span>}
            </div>

            {!isHidden && (
              <div className="chart-pane-legend-values">
                {pane.plots.map((plot, i) => (
                  <span key={i} className="chart-pane-val-item">
                    {plot.label && <span className="chart-pane-val-label">{plot.label}:</span>}
                    <span
                      className="chart-pane-val-num"
                      data-ind-val={plot.valKey}
                      data-ind-precision={plot.precision}
                      style={{ color: plot.color }}
                    >
                      {plot.defaultVal}
                    </span>
                  </span>
                ))}
              </div>
            )}

            <div className="chart-pane-legend-tools">
              <button
                type="button"
                className="chart-pane-tool-btn"
                title={isHidden ? 'Show indicator' : 'Hide indicator'}
                onClick={() => onToggleStudyVisibility(pane.id)}
              >
                {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                type="button"
                className="chart-pane-tool-btn"
                title="Settings"
                onClick={() => openSettings(pane.id)}
              >
                <Settings size={13} />
              </button>
              <button
                type="button"
                className="chart-pane-tool-btn"
                title="Move pane up"
                disabled={pane.paneIndex <= 1}
                onClick={() => engine?.movePane(pane.paneIndex, 'up')}
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                className="chart-pane-tool-btn"
                title="Move pane down"
                disabled={pane.paneIndex >= maxPaneIndex}
                onClick={() => engine?.movePane(pane.paneIndex, 'down')}
              >
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                className="chart-pane-tool-btn"
                title="Maximize / restore pane"
                onClick={() => engine?.maximizePane(pane.paneIndex)}
              >
                <Maximize2 size={13} />
              </button>
              <button
                type="button"
                className="chart-pane-tool-btn delete"
                title="Remove pane"
                onClick={() => {
                  if (pane.onRemove) {
                    pane.onRemove();
                  } else if (pane.id === 'volume') {
                    onUpdateAppearance({ volume: false });
                  } else {
                    onUpdateStudies({ ...studies, [pane.id]: false });
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        );

        if (targetElement) {
          return createPortal(legendBar, targetElement, `${pane.id}-${pane.paneIndex}`);
        }
        return legendBar;
      })}
    </>
  );
}

/** Avg (50 SMA, which Simple Volume doesn't draw), relative volume and up/down volume ratio. */
function volumeStatPlots(latest: IndicatorSnapshot) {
  return [
    {label: 'Avg', valKey: 'vol-avg', color: 'var(--muted)', defaultVal: formatVolumeValue(latest.volumeAvg)},
    {label: 'RVol', valKey: 'vol-rel', color: 'var(--muted)', defaultVal: formatRelativeVolume(latest.volumeRel)},
    {label: 'U/D', valKey: 'vol-ud', color: 'var(--muted)', defaultVal: formatIndicatorValue(latest.volumeUpDown, 2)},
  ];
}
