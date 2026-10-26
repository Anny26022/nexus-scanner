import {
  ColorType, CrosshairMode, LineSeries, LineStyle, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time,
} from 'lightweight-charts';
import { chartTime, crosshairDate } from './ChartEngine';

/** One line on a comparison chart: dated closes (trading days or intraday timestamps). */
export interface CompareSeries {
  id: string;
  label: string;
  points: readonly {date: string; value: number}[];
  color?: string;
}

export interface CompareHover {
  date: string;
  values: {id: string; label: string; color: string; change: number}[];
}

/** Distinct in light and dark; series beyond eight repeat the palette. */
export const COMPARE_PALETTE = ['#2962ff', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

const percent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

/**
 * Rebases each series to its value on the latest common start date, so every line starts at 0% and shows change
 * over the same period. Points before that date are dropped; a series with no point on or after it is left out.
 */
export function rebaseSeries(series: readonly CompareSeries[]): {id: string; label: string; color: string; points: {date: string; change: number}[]}[] {
  const sorted = series.map(entry => ({...entry, points: [...entry.points].filter(point => Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))}));
  const starts = sorted.filter(entry => entry.points.length).map(entry => Date.parse(entry.points[0].date));
  if (!starts.length) return [];
  const start = Math.max(...starts);
  return sorted.flatMap((entry, index) => {
    const points = entry.points.filter(point => Date.parse(point.date) >= start);
    if (!points.length) return [];
    const base = points[0].value;
    return [{id: entry.id, label: entry.label, color: entry.color ?? COMPARE_PALETTE[index % COMPARE_PALETTE.length],
      points: points.map(point => ({date: point.date, change: (point.value / base - 1) * 100}))}];
  });
}

/** Several series on one percentage scale, drawn with the same chart library and theme tokens as ChartEngine. */
export class CompareEngine {
  private chart: IChartApi;
  private lines = new Map<string, ISeriesApi<'Line'>>();
  private rebased: ReturnType<typeof rebaseSeries> = [];
  private dateByTime = new Map<number, string>();
  private zeroLine?: {line: ISeriesApi<'Line'>; price: IPriceLine};

  constructor(private host: HTMLDivElement, private onHover: (hover: CompareHover | null) => void = () => {}) {
    this.chart = createChart(host, {
      autoSize: true,
      layout: {fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif', fontSize: 12, attributionLogo: false},
      grid: {vertLines: {visible: false}, horzLines: {visible: true}},
      rightPriceScale: {borderVisible: false, scaleMargins: {top: .12, bottom: .12}},
      timeScale: {borderVisible: false, rightOffset: 4, fixLeftEdge: true, fixRightEdge: true},
      crosshair: {mode: CrosshairMode.Normal},
      localization: {locale: 'en-IN', priceFormatter: percent, timeFormatter: (time: Time) => crosshairDate(this.dateString(time))},
      handleScroll: {mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false},
    });
    this.chart.subscribeCrosshairMove(this.crosshair);
    this.refreshTheme();
  }

  setSeries(series: readonly CompareSeries[]) {
    this.rebased = rebaseSeries(series);
    const ids = new Set(this.rebased.map(entry => entry.id));
    if (this.zeroLine) { this.zeroLine.line.removePriceLine(this.zeroLine.price); this.zeroLine = undefined; }
    for (const [id, line] of this.lines) if (!ids.has(id)) { this.chart.removeSeries(line); this.lines.delete(id); }
    this.dateByTime = new Map(this.rebased.flatMap(entry => entry.points).filter(point => point.date.length > 10)
      .map(point => [chartTime(point.date) as number, point.date]));
    const intraday = this.dateByTime.size > 0;
    this.chart.applyOptions({timeScale: {timeVisible: intraday, secondsVisible: false}});
    this.rebased.forEach((entry, index) => {
      let line = this.lines.get(entry.id);
      if (!line) {
        line = this.chart.addSeries(LineSeries, {lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3});
        this.lines.set(entry.id, line);
      }
      line.applyOptions({color: entry.color, title: entry.label});
      line.setData(entry.points.map(point => ({time: chartTime(point.date), value: point.change})));
      // One dashed zero line marks the common start.
      if (index === 0) this.zeroLine = {line, price: line.createPriceLine({price: 0, color: this.token('line', '#d2d2d7'), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: ''})};
    });
    this.chart.timeScale().fitContent();
  }

  /** Re-reads colours from the host's CSS tokens (after a theme or token change). */
  refreshTheme() {
    this.chart.applyOptions({
      layout: {background: {type: ColorType.Solid, color: this.token('chart-background', this.token('surface', '#ffffff'))}, textColor: this.token('muted', '#787b86')},
      grid: {horzLines: {color: this.token('chart-grid', '#f0f0f0')}},
      crosshair: {vertLine: {color: this.token('chart-crosshair', '#aab8c5'), labelBackgroundColor: this.token('text', '#131722')},
        horzLine: {color: this.token('chart-crosshair', '#aab8c5'), labelBackgroundColor: this.token('text', '#131722')}},
    });
  }

  destroy() {
    this.chart.unsubscribeCrosshairMove(this.crosshair);
    this.chart.remove();
  }

  private token(name: string, fallback: string) {
    return getComputedStyle(this.host).getPropertyValue(`--${name}`).trim() || fallback;
  }

  private dateString(time: Time) {
    return typeof time === 'string' ? time : typeof time === 'number' ? this.dateByTime.get(time) ?? new Date(time * 1000).toISOString().slice(0, 10)
      : `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
  }

  private crosshair = (event: MouseEventParams<Time>) => {
    if (event.time === undefined) { this.onHover(null); return; }
    const values = this.rebased.flatMap(entry => {
      const line = this.lines.get(entry.id);
      const datum = line && event.seriesData.get(line);
      return datum && 'value' in datum ? [{id: entry.id, label: entry.label, color: entry.color, change: datum.value}] : [];
    });
    this.onHover({date: this.dateString(event.time), values});
  };
}
