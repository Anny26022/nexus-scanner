import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CandlestickSeries, ColorType, LineSeries, createChart } from 'lightweight-charts';
import { ChartNoAxesCombined, RefreshCw } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { validateCandles, type Candle } from '../chart/model';
import { sma } from '../chart/studies';
import type { StockRow } from '../types/screener';

type QuickChartsViewProps = {
  rows: StockRow[];
  revision?: string;
  busy: boolean;
  firstRank?: number;
};

const price = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function useNearViewport() {
  const [visible, setVisible] = useState(false);
  const observe = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisible(true);
    }, { rootMargin: '560px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { visible, observe };
}

function MiniChart({ candles }: { candles: readonly Candle[] }) {
  const displayCandles = useMemo(() => candles.slice(-130), [candles]);
  const attach = useCallback((host: HTMLDivElement | null) => {
    if (!host || !displayCandles.length) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: 'transparent', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(122, 137, 130, .13)' } },
      rightPriceScale: { visible: false, borderVisible: false, scaleMargins: { top: .12, bottom: .10 } },
      leftPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false, rightOffset: 3, barSpacing: 5.25, minBarSpacing: 2, lockVisibleTimeRangeOnResize: true },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false, axisDoubleClickReset: true },
      kineticScroll: { mouse: true, touch: true },
    });
    const candlesSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#16856f', downColor: '#ca5a62', borderVisible: false,
      wickUpColor: '#16856f', wickDownColor: '#ca5a62', lastValueVisible: false, priceLineVisible: false,
    });
    candlesSeries.setData(displayCandles.map(candle => ({ time: candle.date as never, open: candle.open, high: candle.high, low: candle.low, close: candle.close })));
    const addAverage = (period: number, color: string) => {
      const values = sma(displayCandles.map(candle => candle.close), period);
      const series = chart.addSeries(LineSeries, { color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      series.setData(displayCandles.flatMap((candle, index) => values[index] == null ? [] : [{ time: candle.date as never, value: values[index]! }]));
    };
    addAverage(20, '#bf7a18');
    addAverage(50, '#3d78bd');
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [displayCandles]);
  return <div ref={attach} className="quick-chart-canvas" aria-label="Interactive candlestick chart. Drag to review prior sessions, pinch to zoom." role="img" />;
}

function QuickChartCard({ row, revision, rank }: { row: StockRow; revision?: string; rank: number }) {
  const { visible, observe } = useNearViewport();
  const chart = useQuery({
    queryKey: ['quick-chart', revision, row.symbol],
    queryFn: async () => {
      const snapshot = await screenerApi.getChart(row.symbol, revision);
      return { ...snapshot, candles: validateCandles(snapshot.candles) };
    },
    enabled: visible && Boolean(revision),
    staleTime: Infinity,
    retry: 1,
  });
  const positive = row.changePct >= 0;
  return <article ref={observe} className="quick-chart-card" aria-label={`${row.symbol} quick chart`}>
    <header className="quick-chart-header">
      <div className="quick-chart-identity">
        <span className="quick-chart-rank" aria-label={`Result ${rank}`}>{rank}</span>
        <div><strong>{row.symbol}</strong><span title={row.name}>{row.name}</span></div>
      </div>
      <div className="quick-chart-quote"><strong>₹{price.format(row.close)}</strong><span className={positive ? 'positive' : 'negative'}>{positive ? '+' : ''}{row.changePct.toFixed(2)}%</span></div>
    </header>
    <div className="quick-chart-stage">
      {chart.isPending || !visible ? <div className="quick-chart-skeleton" aria-label="Loading chart" />
        : chart.isError ? <div className="quick-chart-unavailable"><ChartNoAxesCombined size={18} /><span>Chart unavailable</span><button type="button" onClick={() => void chart.refetch()} aria-label={`Retry ${row.symbol} chart`}><RefreshCw size={13} /></button></div>
          : chart.data?.candles.length ? <MiniChart candles={chart.data.candles} /> : <div className="quick-chart-unavailable"><ChartNoAxesCombined size={18} /><span>No price history</span></div>}
    </div>
    <footer className="quick-chart-meta">
      <span>RS <strong>{row.rsRating ?? ' - '}</strong></span>
      <span>RVOL <strong>{row.rvol == null ? ' - ' : `${row.rvol.toFixed(1)}×`}</strong></span>
      <span>₹{Number.isFinite(row.rupeeVolumeCrore) ? price.format(row.rupeeVolumeCrore) : ' - '} Cr</span>
      <span>1D</span>
    </footer>
  </article>;
}

export function QuickChartsView({ rows, revision, busy, firstRank = 1 }: QuickChartsViewProps) {
  if (busy && !rows.length) return <div className="quick-charts-grid" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="quick-chart-card quick-chart-card-skeleton" key={index} />)}</div>;
  if (!rows.length) return null;
  return <div className="quick-charts-scroll" aria-live="polite">
    <p className="quick-charts-hint">Drag a chart to review earlier sessions. Pinch to zoom.</p>
    <div className="quick-charts-grid">{rows.map((row, index) => <QuickChartCard key={row.symbol} row={row} revision={revision} rank={firstRank + index} />)}</div>
  </div>;
}
