import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesCombined, Maximize2, RefreshCw } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { validateCandles, type Candle } from '../chart/model';
import { ChartEngine } from '../chart/ChartEngine';
import { loadGrid, loadScene, savedDrawingBook, writeChartStorage } from '../chart/storage';
import { defaultStudies } from '../chart/studies';
import { defaultStudyConfigs } from '../chart/studyConfigs';
import { loadEmaLines } from './EmaSettings';
import type { StockRow } from '../types/screener';

type QuickChartsViewProps = {
  rows: StockRow[];
  revision?: string;
  busy: boolean;
  firstRank?: number;
  onOpenFullChart?: (symbol: string, revision?: string) => void;
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

function MiniChart({ candles, symbol, onEngineChange }: { candles: readonly Candle[]; symbol: string; onEngineChange: (engine: ChartEngine | null) => void }) {
  // Keep the complete published history in the engine. setRange(6) below only
  // selects the initial viewport; slicing here would make older sessions
  // impossible to reach by panning left.
  const displayCandles = candles;
  const attach = useCallback((host: HTMLDivElement | null) => {
    if (!host || !displayCandles.length) return;
    const scene = loadScene('0');
    const engine = new ChartEngine(host, displayCandles, () => {}, savedDrawingBook(symbol));
    engine.setStyle(scene.style ?? 'candles');
    engine.setEmaLines(scene.emaLines ?? loadEmaLines());
    engine.setStudyConfigs(scene.studyConfigs ?? defaultStudyConfigs());
    engine.setStudies(scene.studies ?? defaultStudies());
    engine.setAppearance({
      horizontalGrid: true,
      verticalGrid: false,
      crosshair: true,
      volume: true,
      scaleMode: 'normal',
      ...scene.appearance,
      panEnabled: true,
      zoomEnabled: true,
    });
    engine.setRange(6);
    onEngineChange(engine);
    return () => { engine.destroy(); onEngineChange(null); };
  }, [displayCandles, symbol, onEngineChange]);
  return <div ref={attach} className="quick-chart-canvas" aria-label="Interactive chart using the saved chart style, indicators, and drawings. Drag to pan, scroll or pinch to zoom, and select drawings to edit them." role="group" tabIndex={0} />;
}

function QuickChartCard({ row, revision, rank, onOpenFullChart }: { row: StockRow; revision?: string; rank: number; onOpenFullChart?: (symbol: string, revision?: string) => void }) {
  const { visible, observe } = useNearViewport();
  const engineRef = useRef<ChartEngine | null>(null);
  const onEngineChange = useCallback((engine: ChartEngine | null) => { engineRef.current = engine; }, []);
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
  const openFullChart = () => {
    const grid = loadGrid();
    writeChartStorage('grid.v1', {
      ...grid,
      tiles: [{ ...grid.tiles[0], symbol: row.symbol }, ...grid.tiles.slice(1)],
    });
    onOpenFullChart?.(row.symbol, revision);
  };
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
          : chart.data?.candles.length ? <MiniChart candles={chart.data.candles} symbol={row.symbol} onEngineChange={onEngineChange} /> : <div className="quick-chart-unavailable"><ChartNoAxesCombined size={18} /><span>No price history</span></div>}
    </div>
    <footer className="quick-chart-meta">
      <span>RS <strong>{row.rsRating ?? ' - '}</strong></span>
      <span>RVOL <strong>{row.rvol == null ? ' - ' : `${row.rvol.toFixed(1)}×`}</strong></span>
      <span>₹{Number.isFinite(row.rupeeVolumeCrore) ? price.format(row.rupeeVolumeCrore) : ' - '} Cr</span>
      <span>1D</span>
      <button type="button" className="quick-chart-recenter" onClick={() => engineRef.current?.latest()}>Recenter</button>
      <button type="button" className="quick-chart-open" onClick={openFullChart} aria-label={`Open ${row.symbol} full chart`}><Maximize2 size={12} /><span>Open chart</span></button>
    </footer>
  </article>;
}

export function QuickChartsView({ rows, revision, busy, firstRank = 1, onOpenFullChart }: QuickChartsViewProps) {
  if (busy && !rows.length) return <div className="quick-charts-grid" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="quick-chart-card quick-chart-card-skeleton" key={index} />)}</div>;
  if (!rows.length) return null;
  return <div className="quick-charts-scroll" aria-live="polite">
    <p className="quick-charts-hint">Interactive charts use your saved style, indicators, and drawings. Drag to pan; scroll or pinch to zoom.</p>
    <div className="quick-charts-grid">{rows.map((row, index) => <QuickChartCard key={row.symbol} row={row} revision={revision} rank={firstRank + index} onOpenFullChart={onOpenFullChart} />)}</div>
  </div>;
}
