import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Eye,
  EyeOff,
  Settings,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Trash2,
} from 'lucide-react';
import type { ChartEngine, ChartAppearance } from '../chart/ChartEngine';
import type { Candle, EmaLine } from '../chart/model';
import type { ChartStudies } from '../chart/studies';
import type { StudyConfigs } from '../chart/studyConfigs';
import {
  computeIndicatorSeries,
  formatVolumeValue,
} from '../chart/indicatorValues';

export interface LegendProps {
  engine: ChartEngine | null;
  candles: readonly Candle[];
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
}

/**
 * Overlay rows rendered on Pane 0 (Price pane) underneath the OHLC quote
 */
export function PricePaneLegend({
  engine,
  candles,
  studies,
  studyConfigs,
  emaLines,
  appearance,
  onOpenIndicators,
  onOpenSettings,
  onUpdateEmaLines,
  onUpdateStudies,
  onUpdateAppearance,
}: LegendProps) {
  const [hiddenStudies, setHiddenStudies] = useState<Record<string, boolean>>({});
  const openSettings = (id: string) => (onOpenSettings ? onOpenSettings(id) : onOpenIndicators());

  const toggleStudyVisibility = (id: string) => {
    const nextHidden = !hiddenStudies[id];
    setHiddenStudies(prev => ({ ...prev, [id]: nextHidden }));
    engine?.setStudyVisibility(id, !nextHidden);
  };

  const indicatorSeries = useMemo(() => {
    return computeIndicatorSeries(candles, emaLines, studies, studyConfigs);
  }, [candles, emaLines, studies, studyConfigs]);

  const latest = useMemo(() => {
    return indicatorSeries.getSnapshot(candles.length - 1);
  }, [indicatorSeries, candles.length]);

  const stCfg = studyConfigs?.supertrend;
  const bbCfg = studyConfigs?.bollinger;
  const smaCfg = studyConfigs?.sma;

  return (
    <div className="chart-indicator-legend">
      {/* Volume Overlay (when in price pane) */}
      {appearance.volume && !appearance.volumePane && (
        <div className="chart-indicator-row">
          <span className="chart-indicator-title" style={{ color: '#089981' }} onClick={() => openSettings('volume')}>
            <span className="chart-indicator-bullet">●</span>
            <span>Vol</span>
            <span className="chart-indicator-val" data-ind-val="vol">
              {formatVolumeValue(latest.volume)}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.volume ? 'Show Volume' : 'Hide Volume'}
              onClick={() => toggleStudyVisibility('volume')}
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
                  {val !== null && val !== undefined ? val.toFixed(2) : '-'}
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
              {latest.supertrend?.value !== null && latest.supertrend?.value !== undefined
                ? latest.supertrend.value.toFixed(stCfg?.precision ?? 2)
                : '-'}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.supertrend ? 'Show' : 'Hide'}
              onClick={() => toggleStudyVisibility('supertrend')}
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
                <span data-ind-val="bb-upper" style={{ color: bbCfg?.upperColor ?? '#78909c' }}>{latest.bollinger?.upper?.toFixed(bbCfg?.precision ?? 2) ?? '-'} </span>
              )}
              {bbCfg?.middleVisible !== false && (
                <span data-ind-val="bb-mid" style={{ color: bbCfg?.middleColor ?? '#78909c' }}>{latest.bollinger?.middle?.toFixed(bbCfg?.precision ?? 2) ?? '-'} </span>
              )}
              {bbCfg?.lowerVisible !== false && (
                <span data-ind-val="bb-lower" style={{ color: bbCfg?.lowerColor ?? '#78909c' }}>{latest.bollinger?.lower?.toFixed(bbCfg?.precision ?? 2) ?? '-'}</span>
              )}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.bollinger ? 'Show' : 'Hide'}
              onClick={() => toggleStudyVisibility('bollinger')}
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
              {latest.sma !== null && latest.sma !== undefined ? latest.sma.toFixed(smaCfg?.precision ?? 2) : '-'}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.sma ? 'Show' : 'Hide'}
              onClick={() => toggleStudyVisibility('sma')}
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
              {latest.vwap !== null && latest.vwap !== undefined ? latest.vwap.toFixed(studyConfigs?.vwap?.precision ?? 2) : '-'}
            </span>
          </span>
          <span className="chart-indicator-actions">
            <button
              type="button"
              className="chart-indicator-action-btn"
              title={hiddenStudies.vwap ? 'Show' : 'Hide'}
              onClick={() => toggleStudyVisibility('vwap')}
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
  candles,
  studies,
  studyConfigs,
  emaLines,
  appearance,
  paneOffsets = [],
  onOpenIndicators,
  onOpenSettings,
  onUpdateStudies,
  onUpdateAppearance,
}: LegendProps) {
  const [hiddenStudies, setHiddenStudies] = useState<Record<string, boolean>>({});
  const openSettings = (id: string) => (onOpenSettings ? onOpenSettings(id) : onOpenIndicators());

  const toggleStudyVisibility = (id: string) => {
    const nextHidden = !hiddenStudies[id];
    setHiddenStudies(prev => ({ ...prev, [id]: nextHidden }));
    engine?.setStudyVisibility(id, !nextHidden);
  };

  const indicatorSeries = useMemo(() => {
    return computeIndicatorSeries(candles, emaLines, studies, studyConfigs);
  }, [candles, emaLines, studies, studyConfigs]);

  const latest = useMemo(() => {
    return indicatorSeries.getSnapshot(candles.length - 1);
  }, [indicatorSeries, candles.length]);

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
    plots: Array<{ label?: string; valKey: string; color?: string; defaultVal: string }>;
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
          defaultVal: latest.macd?.line !== null && latest.macd?.line !== undefined ? latest.macd.line.toFixed(prec) : '-',
        });
      }
      if (studyConfigs?.macd?.signalVisible !== false) {
        plots.push({
          label: 'Signal',
          valKey: 'macd-signal',
          color: studyConfigs?.macd?.signalColor ?? '#f59e0b',
          defaultVal: latest.macd?.signal !== null && latest.macd?.signal !== undefined ? latest.macd.signal.toFixed(prec) : '-',
        });
      }
      if (studyConfigs?.macd?.histVisible !== false) {
        plots.push({
          label: 'Hist',
          valKey: 'macd-hist',
          color: (latest.macd?.histogram ?? 0) >= 0 ? (studyConfigs?.macd?.histColor ?? '#089981') : '#ef5350',
          defaultVal: latest.macd?.histogram !== null && latest.macd?.histogram !== undefined ? latest.macd.histogram.toFixed(prec) : '-',
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
          defaultVal: latest.rsi !== null && latest.rsi !== undefined ? latest.rsi.toFixed(prec) : '-',
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
          defaultVal: latest.atr !== null && latest.atr !== undefined ? latest.atr.toFixed(prec) : '-',
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
          defaultVal: latest.stochastic?.k !== null && latest.stochastic?.k !== undefined ? latest.stochastic.k.toFixed(prec) : '-',
        });
      }
      if (studyConfigs?.stochastic?.dVisible !== false) {
        plots.push({
          label: '%D',
          valKey: 'stoch-d',
          color: studyConfigs?.stochastic?.dColor ?? '#ef5350',
          defaultVal: latest.stochastic?.d !== null && latest.stochastic?.d !== undefined ? latest.stochastic.d.toFixed(prec) : '-',
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
        ],
      });
    }
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
                onClick={() => toggleStudyVisibility(pane.id)}
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
                  if (pane.id === 'volume') {
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
