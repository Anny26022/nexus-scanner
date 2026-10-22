import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesCombined, Maximize2, Minus, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { validateCandles, type Candle } from '../chart/model';
import { ChartEngine } from '../chart/ChartEngine';
import { loadGrid, loadScene, savedDrawingBook, writeChartStorage } from '../chart/storage';
import { defaultStudies } from '../chart/studies';
import { defaultStudyConfigs } from '../chart/studyConfigs';
import { loadEmaLines } from './EmaSettings';
import { useGridWindow } from '../hooks/useGridWindow';
import type { StockRow } from '../types/screener';

type QuickChartsViewProps = {
  rows: StockRow[];
  revision?: string;
  matchCount?: number;
  matchedSymbols?: string[];
  loadRows?: () => Promise<StockRow[]>;
  busy: boolean;
  firstRank?: number;
  onOpenFullChart?: (symbol: string, revision?: string) => void;
};

const price = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function useNearViewport(root: Element | null) {
  const [nearViewport, setNearViewport] = useState(false);
  const observe = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    if (!root) return;
    const observer = new IntersectionObserver(([entry]) => {
      setNearViewport(Boolean(entry?.isIntersecting));
    }, { root, rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  return { nearViewport, observe };
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
      zoomEnabled: false,
    });
    engine.setRange(6);
    onEngineChange(engine);
    return () => { engine.destroy(); onEngineChange(null); };
  }, [displayCandles, symbol, onEngineChange]);
  return <div ref={attach} className="quick-chart-canvas" aria-label="Interactive chart using the saved chart style, indicators, and drawings. Drag to pan; scroll or pinch to zoom, and select drawings to edit them." role="group" tabIndex={0} />;
}

function QuickChartCard({ row, revision, rank, scrollRoot, onOpenFullChart }: { row: StockRow; revision?: string; rank: number; scrollRoot: Element | null; onOpenFullChart?: (symbol: string, revision?: string) => void }) {
  const { nearViewport, observe } = useNearViewport(scrollRoot);
  const engineRef = useRef<ChartEngine | null>(null);
  const onEngineChange = useCallback((engine: ChartEngine | null) => { engineRef.current = engine; }, []);
  const chart = useQuery({
    queryKey: ['quick-chart', revision, row.symbol],
    queryFn: async () => {
      const snapshot = await screenerApi.getChart(row.symbol, revision);
      return { ...snapshot, candles: validateCandles(snapshot.candles) };
    },
    enabled: nearViewport && Boolean(revision),
    staleTime: Infinity,
    retry: 1,
  });
  const changePct = typeof row.changePct === 'number' && Number.isFinite(row.changePct) ? row.changePct : null;
  const positive = changePct != null && changePct >= 0;
  const openFullChart = () => {
    if (!onOpenFullChart) return;
    const grid = loadGrid();
    writeChartStorage('grid.v1', {
      ...grid,
      tiles: [{ ...grid.tiles[0], symbol: row.symbol }, ...grid.tiles.slice(1)],
    });
    onOpenFullChart(row.symbol, revision);
  };
  return <article ref={observe} className="quick-chart-card" aria-label={`${row.symbol} quick chart`}>
    <header className="quick-chart-header">
      <div className="quick-chart-identity">
        <span className="quick-chart-rank" aria-label={`Result ${rank}`}>{rank}</span>
        <div><strong>{row.symbol}</strong><span title={row.name}>{row.name}</span></div>
      </div>
      <div className="quick-chart-quote">
        <strong>₹{typeof row.close === 'number' && Number.isFinite(row.close) ? price.format(row.close) : ' - '}</strong>
        <span className={changePct == null ? 'neutral' : positive ? 'positive' : 'negative'}>
          {changePct != null ? `${positive ? '+' : ''}${changePct.toFixed(2)}%` : ' - '}
        </span>
      </div>
    </header>
    <div className="quick-chart-stage chart-stage">
      {!revision || chart.isError ? (
        <div className="quick-chart-unavailable">
          <ChartNoAxesCombined size={18} />
          <span>{revision ? 'Chart unavailable' : 'Revision unavailable'}</span>
          {Boolean(revision) && (
            <button type="button" onClick={() => void chart.refetch()} aria-label={`Retry ${row.symbol} chart`}><RefreshCw size={13} /></button>
          )}
        </div>
      ) : !nearViewport || chart.isPending ? (
        <div className="quick-chart-skeleton" aria-label="Loading chart" />
      ) : chart.data?.candles.length ? (
        <>
          <MiniChart candles={chart.data.candles} symbol={row.symbol} onEngineChange={onEngineChange} />
          <div className="chart-actions-zone" role="group" aria-label={`${row.symbol} chart controls`}>
            <div className="chart-actions">
              <button type="button" className="button button-icon" aria-label="Zoom in" title="Zoom in (+)" onClick={() => engineRef.current?.zoom(.8)}><Plus size={15}/></button>
              <button type="button" className="button button-icon" aria-label="Zoom out" title="Zoom out (-)" onClick={() => engineRef.current?.zoom(1.25)}><Minus size={15}/></button>
              <button type="button" className="button button-icon" aria-label="Reset chart view" title="Reset chart view (6 months)" onClick={() => engineRef.current?.setRange(6)}><RotateCcw size={14}/></button>
              <button type="button" className="button button-ghost chart-auto-btn" title="Restore automatic price scaling" onClick={() => engineRef.current?.resetPriceScale()}>Auto</button>
            </div>
          </div>
        </>
      ) : (
        <div className="quick-chart-unavailable"><ChartNoAxesCombined size={18} /><span>No price history</span></div>
      )}
    </div>
    <footer className="quick-chart-meta">
      <span>RS <strong>{row.rsRating ?? ' - '}</strong></span>
      <span>RVOL <strong>{row.rvol == null ? ' - ' : `${row.rvol.toFixed(1)}×`}</strong></span>
      <span>₹{Number.isFinite(row.rupeeVolumeCrore) ? price.format(row.rupeeVolumeCrore) : ' - '} Cr</span>
      <span>1D</span>
      {Boolean(onOpenFullChart) && (
        <button type="button" className="quick-chart-open" onClick={openFullChart} aria-label={`Open ${row.symbol} full chart`} title={`Open ${row.symbol} full chart`}><Maximize2 size={13} /></button>
      )}
    </footer>
  </article>;
}

export function QuickChartsView({ rows, revision, matchCount = rows.length, matchedSymbols, loadRows, busy, firstRank = 1, onOpenFullChart }: QuickChartsViewProps) {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const fullResultKey = matchedSymbols?.length === matchCount ? matchedSymbols.join(',') : rows.map(row => row.symbol).join(',');
  const allRows = useQuery({
    queryKey: ['quick-chart-rows', revision, matchCount, fullResultKey],
    queryFn: () => loadRows!(),
    enabled: Boolean(loadRows && revision && matchCount > rows.length),
    staleTime: Infinity,
    retry: 1,
  });
  const chartRows = allRows.data ?? rows;
  const gridWindow = useGridWindow(chartRows, `${revision}-${fullResultKey}`);
  const baseRank = allRows.data ? 1 : firstRank;

  if ((busy || allRows.isPending) && !chartRows.length) return <div className="quick-charts-grid" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="quick-chart-card quick-chart-card-skeleton" key={index} />)}</div>;
  if (!chartRows.length) return null;
  return <div ref={setScrollRoot} className="quick-charts-scroll" onScroll={gridWindow.onScroll} aria-live="off">
    <p className="quick-charts-hint">Interactive charts use your saved style, indicators, and drawings. Drag to pan; scroll or pinch to zoom.</p>
    {allRows.isPending && <p className="quick-charts-hint">Preparing all {matchCount.toLocaleString('en-IN')} matching equities…</p>}
    <div className="quick-charts-grid" style={gridWindow.enabled ? { paddingTop: `${gridWindow.top}px`, paddingBottom: `${gridWindow.bottom}px` } : undefined}>
      {gridWindow.items.map((row, index) => (
        <QuickChartCard
          key={row.symbol}
          row={row}
          revision={revision}
          rank={baseRank + gridWindow.firstIndex + index}
          scrollRoot={scrollRoot}
          onOpenFullChart={onOpenFullChart}
        />
      ))}
    </div>
  </div>;
}
