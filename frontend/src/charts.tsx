import React from 'react';
import { ChartEngine, type ChartAppearance, type ChartStyle } from './chart/ChartEngine';
import { CompareEngine, type CompareHover, type CompareSeries } from './chart/CompareEngine';
import { defaultStudyConfigs } from './chart/studyConfigs';
import { defaultStudies } from './chart/studies';
import type { Candle, EmaLine } from './chart/model';
import { EMBED_ROOT_CLASS } from './embedding';
import './charts.css';

export type { Candle } from './chart/model';
export type { ChartStyle } from './chart/ChartEngine';
export type { CompareHover, CompareSeries } from './chart/CompareEngine';
export { COMPARE_PALETTE, rebaseSeries } from './chart/CompareEngine';

/** Overrides for the scanner's design tokens, e.g. `{'--surface': 'hsl(var(--card))'}`, so charts take a host's palette. */
export type ChartTokens = Record<`--${string}`, string>;

interface FrameProps {
  /** Light or dark candle and grid colours. Default light. */
  theme?: 'light' | 'dark';
  tokens?: ChartTokens;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
}

export interface MovingAverage { period: number; color?: string }

export interface PriceChartProps extends FrameProps {
  /** Oldest first. `date` is a trading day (`2026-10-26`) or, for intraday bars, an ISO timestamp (`2026-10-26T09:15:00Z`). */
  candles: readonly Candle[];
  chartStyle?: ChartStyle;
  movingAverages?: readonly MovingAverage[];
  /** Volume histogram under the price. Default true. */
  showVolume?: boolean;
  /** Bars visible when the chart opens or its candles change; all bars when omitted. */
  visibleBars?: number;
  /** The bar under the crosshair, or the last bar when the pointer leaves. */
  onHover?: (bar: Candle) => void;
}

export interface CompareChartProps extends FrameProps {
  /** Each line is rebased to 0% on the latest common start date. */
  series: readonly CompareSeries[];
  onHover?: (hover: CompareHover | null) => void;
}

const MA_COLORS = ['#f59e0b', '#8b5cf6', '#22d3ee', '#ec4899', '#10b981'];
const APPEARANCE: ChartAppearance = {horizontalGrid: false, verticalGrid: false, crosshair: true, volume: true, scaleMode: 'normal', panEnabled: true, zoomEnabled: true};

const emaLines = (averages: readonly MovingAverage[]): EmaLine[] => averages.map((average, index) => ({
  id: `ma${average.period}-${index}`, period: average.period, color: average.color ?? MA_COLORS[index % MA_COLORS.length],
  enabled: true, width: 2, style: 'solid', opacity: 1,
}));

/** The scoped root every chart renders in: scanner tokens, theme and the host's overrides. */
function ChartFrame({theme = 'light', tokens, className, style, children, ...rest}: FrameProps & {children: React.ReactNode}) {
  // The root fills its container; the host sizes the chart by sizing that container (or through `style`).
  return <div className={`${EMBED_ROOT_CLASS}${className ? ` ${className}` : ''}`} data-theme={theme}
    style={{width: '100%', height: '100%', ...tokens, ...style} as React.CSSProperties}>
    <div className="nexus-chart" role="group" aria-label={rest['aria-label'] ?? 'Chart'}>{children}</div>
  </div>;
}

/** A price chart on the scanner's chart engine: candles or line styles, moving averages, volume, pan and zoom. */
export function PriceChart({candles, chartStyle = 'candles', movingAverages = [], showVolume = true, visibleBars, onHover, ...frame}: PriceChartProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const engine = React.useRef<ChartEngine | null>(null);
  const hover = React.useRef(onHover);
  hover.current = onHover;

  // The engine is an external canvas widget: it is created once and updated through its setters below.
  React.useLayoutEffect(() => {
    if (!host.current) return;
    const chart = new ChartEngine(host.current, candles, bar => hover.current?.(bar));
    chart.setStudyConfigs(defaultStudyConfigs());
    chart.setStudies(defaultStudies());
    chart.setAppearance(APPEARANCE);
    engine.current = chart;
    return () => { chart.destroy(); engine.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useLayoutEffect(() => {
    engine.current?.setCandles(candles);
    if (visibleBars) engine.current?.showLastBars(visibleBars); else engine.current?.fitAll();
  }, [candles, visibleBars]);
  React.useLayoutEffect(() => { engine.current?.setStyle(chartStyle); }, [chartStyle]);
  const averagesKey = movingAverages.map(average => `${average.period}:${average.color ?? ''}`).join(',');
  React.useLayoutEffect(() => { engine.current?.setEmaLines(emaLines(movingAverages)); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [averagesKey]);
  React.useLayoutEffect(() => { engine.current?.setStudyVisibility('volume', showVolume); }, [showVolume]);
  const tokensKey = JSON.stringify(frame.tokens ?? {});
  React.useLayoutEffect(() => { engine.current?.refreshTheme(); }, [frame.theme, tokensKey]);

  return <ChartFrame {...frame}><div ref={host} className="nexus-chart-canvas" tabIndex={0} /></ChartFrame>;
}

/** Several themes, indices or stocks on one percentage scale, drawn with the same library and tokens. */
export function CompareChart({series, onHover, ...frame}: CompareChartProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const engine = React.useRef<CompareEngine | null>(null);
  const hover = React.useRef(onHover);
  hover.current = onHover;

  React.useLayoutEffect(() => {
    if (!host.current) return;
    const chart = new CompareEngine(host.current, value => hover.current?.(value));
    engine.current = chart;
    return () => { chart.destroy(); engine.current = null; };
  }, []);
  React.useLayoutEffect(() => { engine.current?.setSeries(series); }, [series]);
  const tokensKey = JSON.stringify(frame.tokens ?? {});
  React.useLayoutEffect(() => { engine.current?.refreshTheme(); }, [frame.theme, tokensKey]);

  return <ChartFrame {...frame}><div ref={host} className="nexus-chart-canvas" tabIndex={0} /></ChartFrame>;
}
