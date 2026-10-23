import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Maximize2, Minimize2, Minus, Pause, Pencil, Play, Plus, RotateCcw, Settings2, SkipBack, SkipForward, SlidersHorizontal, X, Keyboard, LayoutTemplate } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { ChartEngine, type ChartAppearance, type ChartStudies, type ChartStyle } from '../chart/ChartEngine';
import { ReplayClock } from '../chart/ReplayClock';
import { aggregate, validateCandles, type Candle, type EmaLine, type Interval } from '../chart/model';
import { DrawingBook } from '../chart/drawings';
import { DrawingToolbar } from './DrawingToolbar';
import { DrawingContextToolbar } from './DrawingContextToolbar';
import { EMA_PREFS_KEY, loadEmaLines } from './EmaSettings';
import { ChartLegend, updateCandleValues, type ChartMetrics } from './ChartLegend';
import { ChartDialog } from './ChartDialog';
import { ChartContextMenu } from './ChartContextMenu';
import { ChartComparison } from './ChartComparison';
import { chartEvents, revealedThrough, type ChartEvent } from '../chart/events';
import { defaultStudies } from '../chart/studies';
import { chartStorage, loadGrid, loadScene, loadNamedLayouts, saveNamedLayouts, exportWorkspaceDocumentJson, importWorkspaceDocumentJson, readChartStorage, writeChartStorage, savedDrawingBook, WATCHLIST_KEY, type GridSettings, type SceneSettings, type TileSettings, type SavedLayout } from '../chart/storage';
import { ChartSync } from '../chart/ChartSync';
import { ChartLayoutPicker } from './ChartLayoutPicker';
import { chartLayout, layoutAreas, MAX_CHARTS } from '../chart/layouts';
import { ChartSettingsDialog } from './ChartSettingsDialog';
import { ChartStylePicker } from './ChartStylePicker';
import { PricePaneLegend, SubPaneLegends } from './PaneOverlayLegends';
import { computeIndicatorSeries, updateLiveIndicatorDom } from '../chart/indicatorValues';
import { type StudyConfigs, defaultStudyConfigs, isIndicatorVisibleForInterval } from '../chart/studyConfigs';
import { FundamentalsIndicator, FundamentalsSettingsDialog } from './FundamentalsIndicator';
import { bandChanges, fundamentalsConfig, priceBandGuides, upcomingResults } from '../chart/fundamentals';
import { IndicatorsCatalogModal } from './IndicatorsCatalogModal';
import { IndicatorSettingsModal } from './IndicatorSettingsModal';
import { ExtraStudySettingsDialog } from './ExtraStudySettingsDialog';
import { ChartSymbolSearch, type ChartSymbolSearchHandle } from './ChartSymbolSearch';
import { ChartShortcutsDialog } from './ChartShortcutsDialog';
import { ChartClock } from './ChartClock';
import { IntervalPrompt } from './IntervalPrompt';
import { useMountEffect } from '../hooks/useMountEffect';
import { EXTRA_STUDY_BY_ID, type ExtraStudies, type ExtraStudyId } from '../chart/extraStudies';
import { WatchlistDock } from './WatchlistDock';
import { Download, Upload } from 'lucide-react';
import { Button } from './Button';

const ranges=[[1,'1mo'],[3,'3mo'],[6,'6mo'],[12,'1y'],[24,'2y'],[null,'All']] as const;

function filterStudiesForInterval(rawStudies: ChartStudies, configs: StudyConfigs, interval: Interval): ChartStudies {
  const visible = { ...rawStudies };
  for (const key of Object.keys(rawStudies) as (keyof ChartStudies)[]) {
    if (rawStudies[key] && !isIndicatorVisibleForInterval(configs[key]?.visibility, interval)) visible[key] = false;
  }
  return visible;
}

/** 'consume' prevents the browser default; 'focus' moved focus and lets the key reach the new target. */
type TileShortcutHandler = (event: KeyboardEvent) => 'consume' | 'focus' | null;
// Each mounted tile registers its shortcut handler against its section element.
const tileShortcutHandlers = new WeakMap<Element, TileShortcutHandler>();
const INTERVALS: readonly Interval[] = ['D', 'W', 'M'];
const isEditable = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** Scene-level commands that keyboard shortcuts on the tile can invoke. */
export interface ChartSceneActions {
  openIndicators: () => void;
  toggleLegend: () => void;
  toggleAllIndicators: () => void;
  toggleDrawings: () => void;
  resetView: () => void;
  saveImage: () => void;
  openSettings: () => void;
}

/** Runs `run` once per mount; give it a `key` that changes with the value it applies to the chart. */
function EngineSync({run}: {run: () => void}) {
  useMountEffect(run);
  return null;
}

function ChartScene({candles, symbol, book, firstDate, lastDate,metrics,sessionDate,symbolControls,viewControls,layoutControls,events,revision,interval,tileId,sync,benchmark,actionsRef}: {benchmark?: ReadonlyMap<string, number>; actionsRef?: { current: ChartSceneActions | null };candles: readonly Candle[]; symbol: string;book:DrawingBook;firstDate:string;lastDate:string;metrics?:ChartMetrics;sessionDate:string;symbolControls:ReactNode;viewControls:ReactNode;layoutControls?:ReactNode;events:readonly ChartEvent[];revision:string;interval:Interval;tileId:string;sync:ChartSync}) {
  const [saved]=useState(()=>loadScene(tileId));
  const paneChoice=useRef(saved.paneWeights);
  const engine = useRef<ChartEngine | null>(null);
  const quote = useRef<HTMLOutputElement>(null);
  const previousByDate=useMemo(()=>new Map(candles.map((bar,index)=>[bar.date,candles[index-1]])),[candles]);
  const [emaLines,setEmaLines]=useState(()=>saved.emaLines??loadEmaLines());
  const emaChoice=useRef(emaLines);
  const [style,setStyle]=useState<ChartStyle>(saved.style??'candles');
  const styleChoice=useRef<ChartStyle>(style);
  const [range,setRange]=useState<number|null|undefined>(saved.range === undefined && !saved.view ? 12 : saved.range);
  const rangeChoice=useRef<number|null|undefined>(range);
  const [drawingsOpen,setDrawingsOpen]=useState(false);
  const [indicatorsOpen,setIndicatorsOpen]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [context,setContext]=useState<{x:number;y:number}|null>(null);
  const [appearance,setAppearance]=useState<ChartAppearance>({horizontalGrid:false,verticalGrid:false,crosshair:true,volume:true,scaleMode:'normal',...saved.appearance,volumePane:saved.appearance?.volumePane??true});
  const appearanceChoice=useRef(appearance);
  const [studies,setStudies]=useState<ChartStudies>(saved.studies??defaultStudies());
  const studyChoice=useRef(studies);
  const [studyConfigs, setStudyConfigs] = useState<StudyConfigs>(() => saved.studyConfigs ?? defaultStudyConfigs());
  const studyConfigsChoice = useRef(studyConfigs);
  const [numericalConfigs, setNumericalConfigs] = useState(studyConfigs);
  const visibleStudies = useMemo(() => filterStudiesForInterval(studies, numericalConfigs, interval), [studies, numericalConfigs, interval]);
  const [activeIndicatorSetting, setActiveIndicatorSetting] = useState<string | null>(null);
  const [comparison,setComparison]=useState<{symbol:string;separate:boolean}|null>(saved.comparison??null);
  const persist=(change:Partial<SceneSettings>)=>writeChartStorage(`scene.${tileId}.v1`,{...loadScene(tileId),...change});
  const comparisonChoice=useRef<{symbol:string;candles:readonly Candle[];separate:boolean}>({symbol:'',candles:[],separate:false});
  const [paneOffsets, setPaneOffsets] = useState<Array<{ paneIndex: number; top: number; height: number }>>([]);
  // Mirrors the price scale's auto-fit, which a price-axis drag turns off and a double-click restores.
  const [autoScale, setAutoScale] = useState(true);
  const syncAutoScale = () => { const on = engine.current?.isAutoScale?.() ?? true; if (on !== autoScale) setAutoScale(on); };
  const overlayRef = useRef<HTMLDivElement>(null);
  const candleIndexByDate = useMemo(() => new Map(candles.map((b, i) => [b.date, i])), [candles]);
  const indicatorSeries = useMemo(() => {
    return computeIndicatorSeries(candles, emaLines, visibleStudies, numericalConfigs, benchmark, interval);
  }, [candles, emaLines, visibleStudies, numericalConfigs, benchmark, interval]);
  const indicatorSeriesRef = useRef(indicatorSeries);
  indicatorSeriesRef.current = indicatorSeries;
  const [hiddenStudies, setHiddenStudies] = useState<Record<string, boolean>>({});
  const hiddenStudiesChoice = useRef(hiddenStudies);
  const restoreHiddenStudies = (chart: ChartEngine) => {
    for (const [id, hidden] of Object.entries(hiddenStudiesChoice.current)) {
      if (hidden) chart.setStudyVisibility(id, false);
    }
  };
  const [allHidden, setAllHidden] = useState(false);
  const toggleAllIndicators = () => {
    const hide = !allHidden;
    setAllHidden(hide);
    const ids = [...Object.entries(studyChoice.current).filter(([, on]) => on).map(([id]) => id),
      ...Object.entries(studyConfigsChoice.current.extras ?? {}).filter(([, state]) => state?.enabled).map(([id]) => id), 'fundamentals', 'volume'];
    hiddenStudiesChoice.current = {...hiddenStudiesChoice.current, ...Object.fromEntries(ids.map(id => [id, hide]))};
    setHiddenStudies(hiddenStudiesChoice.current);
    for (const id of ids) engine.current?.setStudyVisibility(id, !hide);
    engine.current?.setEmaLines(hide ? [] : emaChoice.current);
    if (engine.current) updateBandGuides(engine.current);
  };
  const toggleStudyVisibility = (id: string) => {
    const hidden = !hiddenStudiesChoice.current[id];
    hiddenStudiesChoice.current = { ...hiddenStudiesChoice.current, [id]: hidden };
    setHiddenStudies(hiddenStudiesChoice.current);
    engine.current?.setStudyVisibility(id, !hidden);
    if (id === 'fundamentals' && engine.current) updateBandGuides(engine.current);
  };
  const updateEmaLines = (next: EmaLine[]) => {
    setEmaLines(next);
    emaChoice.current = next;
    engine.current?.setEmaLines(next);
    persist({ emaLines: next });
  };
  const onComparison=useCallback((symbol:string,candles:readonly Candle[],separate:boolean)=>{
    comparisonChoice.current={symbol,candles,separate};engine.current?.setComparison(symbol,candles,separate);
    if(paneChoice.current) engine.current?.restorePaneWeights(paneChoice.current);
  },[]);
  const applyStudies=(next:ChartStudies)=>{
    studyChoice.current=next;setStudies(next);
    engine.current?.setStudies(filterStudiesForInterval(next, studyConfigsChoice.current, interval));
    if (engine.current) restoreHiddenStudies(engine.current);
    persist({studies:next});
    if (engine.current) setPaneOffsets(engine.current.getPaneOffsets?.() ?? []);
  };
  const applyStudyConfigs = (next: StudyConfigs, rebuildStudies = true) => {
    studyConfigsChoice.current = next;
    setStudyConfigs(next);
    engine.current?.setStudyConfigs?.(next);
    if (engine.current) updateBandGuides(engine.current);
    if (rebuildStudies) {
      setNumericalConfigs(next);
      engine.current?.setStudies(filterStudiesForInterval(studyChoice.current, next, interval));
    }
    if (engine.current) restoreHiddenStudies(engine.current);
    persist({ studyConfigs: next });
    if (engine.current) setPaneOffsets(engine.current.getPaneOffsets?.() ?? []);
  };
  const applyFundamentals = (fundamentals: NonNullable<StudyConfigs['fundamentals']>) =>
    applyStudyConfigs({...studyConfigsChoice.current, fundamentals}, false);
  const applyExtras = (next: ExtraStudies) => applyStudyConfigs({...studyConfigsChoice.current, extras: next});
  const applyComparison=(next:typeof comparison)=>{setComparison(next);persist({comparison:next});if(!next) onComparison('',[],false);};
  const [eventDetails,setEventDetails]=useState<readonly ChartEvent[]|null>(null);
  const [clock]=useState(()=>new ReplayClock(candles.length));
  const replay=useSyncExternalStore(clock.subscribe,clock.getSnapshot,clock.getSnapshot);
  // Upcoming results "E" label: the schedule query is shared with the indicator's badge.
  const fundamentals = studyConfigs.fundamentals?.enabled ? fundamentalsConfig(studyConfigs.fundamentals) : null;
  const earningsSchedule = useQuery({queryKey: ['earnings-schedule', revision, symbol], queryFn: () => screenerApi.getEarningsSchedule(symbol, revision),
    staleTime: Infinity, retry: false, enabled: Boolean(fundamentals?.earningsLabel)});
  const nextResults = fundamentals?.earningsLabel && !allHidden && !hiddenStudies.fundamentals && replay.index === null
    ? upcomingResults(earningsSchedule.data, sessionDate) : null;
  const bandHistory = useQuery({queryKey: ['price-band-history', revision, symbol], queryFn: () => screenerApi.getPriceBandHistory(symbol, revision),
    staleTime: Infinity, retry: false, enabled: Boolean(fundamentals?.bandHistory)});
  const bandChoice = useRef<readonly {date: string; from: string; to: string}[]>([]);
  // The engine applies its own replay cutoff, so pass every change through the snapshot date.
  bandChoice.current = fundamentals?.bandHistory && !allHidden && !hiddenStudies.fundamentals ? bandChanges(bandHistory.data?.bands, sessionDate) : [];
  const earningsChoice = useRef<{date: string; line: boolean} | null>(null);
  earningsChoice.current = nextResults ? {date: nextResults.scheduled_date, line: fundamentals!.earningsLine} : null;
  const metricsChoice = useRef(metrics);
  metricsChoice.current = metrics;
  const updateBandGuides = (chart: ChartEngine) => {
    const metrics = metricsChoice.current;
    const config = studyConfigsChoice.current.fundamentals;
    chart.setPriceBandGuides?.(config?.enabled && config.guides !== false && !hiddenStudiesChoice.current.fundamentals && clock.getSnapshot().index === null
      ? priceBandGuides(metrics?.circuitLimit, candles[candles.length - 1].close, metrics?.isFno) : []);
  };
  const markCustomRange=()=>{
    if(rangeChoice.current===undefined || clock.getSnapshot().index!==null) return;
    rangeChoice.current=undefined;setRange(undefined);persist({range:undefined});
  };
  const replayBook=useRef(new DrawingBook());
  const [selecting,setSelecting]=useState(false);
  const selectingChoice=useRef(false);
  const activeBook=replay.index===null?book:replayBook.current;
  const currentBar=candles[replay.index??candles.length-1];
  const [error, setError] = useState('');
  const cancelSelection=useCallback(()=>{selectingChoice.current=false;setSelecting(false);engine.current?.setReplayPicker(null);},[]);
  const startReplay=useCallback((index:number)=>{
    selectingChoice.current=false;setSelecting(false);engine.current?.setReplayPicker(null);
    replayBook.current=new DrawingBook();rangeChoice.current=undefined;setRange(undefined);clock.seek(index);
  },[clock]);
  const selectBar=()=>{
    selectingChoice.current=true;setSelecting(true);clock.exit();
    engine.current?.setReplayPicker(startReplay,cancelSelection);
  };
  const exitReplay=()=>{cancelSelection();clock.exit();};
  // React 19 callback-ref cleanup owns the native chart lifecycle.
  const attach = useCallback((host: HTMLDivElement | null) => {
    if (!host) return;
    let chart: ChartEngine;
    try {
      // Read after the preceding symbol's ref cleanup persisted its final view.
      const latestScene=loadScene(tileId);
      const selectedRange=latestScene.range===undefined&&!latestScene.view?12:latestScene.range;
      rangeChoice.current=selectedRange;
      setRange(current=>current===selectedRange?current:selectedRange);
      const revealed=()=>clock.getSnapshot().index===null?candles:candles.slice(0,clock.getSnapshot().index!+1);
      chart = new ChartEngine(host, revealed(), bar => {
        if (quote.current) updateCandleValues(quote.current,bar,previousByDate.get(bar.date));
        if (overlayRef.current) {
          const idx = candleIndexByDate.get(bar.date) ?? candles.length - 1;
          const snap = indicatorSeriesRef.current.getSnapshot(idx);
          updateLiveIndicatorDom(overlayRef.current, snap, studyConfigsChoice.current);
        }
      },activeBook,setEventDetails);
      chart.setOnPanesChange?.(() => {
        setPaneOffsets(chart.getPaneOffsets?.() ?? []);
      });
      setPaneOffsets(chart.getPaneOffsets?.() ?? []);
      chart.setEmaLines(emaChoice.current);
      chart.setStyle(styleChoice.current);
      chart.setAppearance(appearanceChoice.current);
      chart.setStudyConfigs?.(studyConfigsChoice.current);
      chart.setBenchmark(benchmark);
      chart.setStudies(filterStudiesForInterval(studyChoice.current, studyConfigsChoice.current, interval));
      restoreHiddenStudies(chart);
      chart.setEvents(events,revealedThrough(candles,clock.getSnapshot().index,lastDate));
      const comparison=comparisonChoice.current;chart.setComparison(comparison.symbol,comparison.candles,comparison.separate);
      if (selectedRange!==undefined) chart.setRange(selectedRange);
      // A selected duration belongs to the tile, not to the previous symbol's
      // saved viewport. Restore exact dates only for an explicitly custom view.
      const customView=selectedRange===undefined&&clock.getSnapshot().index===null?latestScene.view:undefined;
      if(customView) chart.restoreView(customView);
      else if(selectedRange===undefined&&(appearanceChoice.current.defaultVisibleBars??0)>0) chart.showLastBars(appearanceChoice.current.defaultVisibleBars!);
      if(paneChoice.current) chart.restorePaneWeights(paneChoice.current);
      if (selectingChoice.current) chart.setReplayPicker(startReplay,cancelSelection);
      let previousIndex=clock.getSnapshot().index;
      const unsubscribe=clock.subscribe(()=>{
        const index=clock.getSnapshot().index;
        if (index!==previousIndex) { previousIndex=index; chart.setCandles(revealed());updateBandGuides(chart);chart.setEvents(events,revealedThrough(candles,index,lastDate)); }
      });
      engine.current = chart;
      updateBandGuides(chart);
      chart.setUpcomingEarnings?.(earningsChoice.current);
      chart.setBandChanges?.(bandChoice.current);
      const normalView=clock.getSnapshot().index===null,epoch=sync.persistenceEpoch;
      const unlink=normalView?sync.connect(chart,host):()=>{};
      let timer:ReturnType<typeof setTimeout>|undefined;
      let restoreFrame:number|undefined;
      let restoring=Boolean(customView);
      // Keep the last live viewport: reading the chart after its host is
      // removed can yield a resize-derived range instead of the user's range.
      let liveView=customView??chart.savedView();
      const saveView=()=>{
        if(!normalView||clock.getSnapshot().index!==null||selectingChoice.current||epoch!==sync.persistenceEpoch) return;
        const paneWeights=chart.paneWeights();paneChoice.current=paneWeights;
        const selected=rangeChoice.current;
        writeChartStorage(`scene.${tileId}.v1`,{...loadScene(tileId),style:styleChoice.current,appearance:appearanceChoice.current,studies:studyChoice.current,studyConfigs:studyConfigsChoice.current,emaLines:emaChoice.current,range:selected,view:selected===undefined?liveView:undefined,paneWeights});
      };
      const scheduleSave=()=>{
        if(restoring) return;
        if(host.isConnected) liveView=chart.savedView()??liveView;
        clearTimeout(timer);timer=setTimeout(saveView,200);
      };
      // autoSize measures the new tile after mount; replay the exact dates once
      // that measurement has completed, instead of leaving the 120-bar default.
      if(customView) restoreFrame=requestAnimationFrame(()=>{
        restoreFrame=requestAnimationFrame(()=>{
          chart.restoreView(customView);
          liveView=customView;
          restoring=false;
        });
      });
      const onWheel=()=>markCustomRange();
      const onPan=(event:PointerEvent)=>{if(event.buttons===1&&activeBook.getSnapshot().tool==='select') markCustomRange();};
      chart.chart.timeScale().subscribeVisibleTimeRangeChange(scheduleSave);
      host.addEventListener('wheel',onWheel,{capture:true,passive:true});
      host.addEventListener('pointermove',onPan,true);
      host.addEventListener('pointerup',scheduleSave,true);window.addEventListener('pagehide',saveView);
      return () => { if(restoreFrame!==undefined) cancelAnimationFrame(restoreFrame);clearTimeout(timer);saveView();window.removeEventListener('pagehide',saveView);host.removeEventListener('pointerup',scheduleSave,true);host.removeEventListener('pointermove',onPan,true);host.removeEventListener('wheel',onWheel,true);chart.chart.timeScale().unsubscribeVisibleTimeRangeChange(scheduleSave);unlink();unsubscribe(); chart.destroy(); if (engine.current === chart) engine.current = null; };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chart rendering unavailable.');
      return;
    }
  }, [candles,activeBook,clock,previousByDate,startReplay,cancelSelection,events,lastDate,interval,sync,tileId,benchmark]);
  const saveImage=()=>{const image=engine.current?.takeScreenshot();if(image){const link=document.createElement('a');link.download=`${symbol}-chart.png`;link.href=image.toDataURL('image/png');link.click();}};
  const applyAppearance=(change:Partial<typeof appearance>)=>{
    const next={...appearanceChoice.current,...change};
    appearanceChoice.current=next;setAppearance(next);engine.current?.setAppearance(next);
    persist({appearance:next});
    if (engine.current) setPaneOffsets(engine.current.getPaneOffsets());
  };
  if (actionsRef) actionsRef.current = {
    openIndicators: () => setIndicatorsOpen(true),
    toggleLegend: () => applyAppearance({legendCollapsed: !appearanceChoice.current.legendCollapsed}),
    toggleAllIndicators,
    toggleDrawings: () => activeBook.options({hideAll: !activeBook.getSnapshot().hideAll}),
    resetView: () => { markCustomRange(); engine.current?.reset(); },
    saveImage,
    openSettings: () => setSettingsOpen(true),
  };
  return <>
    <header className="chart-topbar">
      {symbolControls}
      <ChartStylePicker
        value={style}
        onChange={next => {
          setStyle(next);
          styleChoice.current = next;
          engine.current?.setStyle(next);
          persist({ style: next });
        }}
      />
      <button type="button" className="chart-toolbar-button" aria-label="Indicators" title="Indicators" onClick={()=>setIndicatorsOpen(true)}><SlidersHorizontal size={15}/><span>Indicators</span></button>
      <button type="button" className="chart-icon-button chart-drawing-toggle" aria-label={drawingsOpen?'Hide drawing tools':'Show drawing tools'} title="Drawing tools" aria-pressed={drawingsOpen} onClick={()=>{if(drawingsOpen) activeBook.setTool('select');setDrawingsOpen(value=>!value);}}><Pencil size={15}/></button>
      <button type="button" className="chart-toolbar-button chart-replay-toggle" aria-label="Replay" title="Bar replay" aria-pressed={selecting || replay.index!==null} onClick={()=>{
        if (selecting || replay.index!==null) exitReplay(); else selectBar();
      }}><Play size={14}/><span>Replay</span></button>
      <span className="chart-topbar-spacer" />
      {layoutControls}
      <button type="button" className="chart-icon-button" aria-label="Chart settings" title="Chart settings" onClick={()=>setSettingsOpen(true)}><Settings2 size={16}/></button>
      {viewControls}
    </header>
    {(selecting || replay.index!==null) && <div className="chart-replay" role="group" aria-label="Bar replay controls">
      <button type="button" aria-pressed={selecting} onClick={selectBar}>Select bar</button>
      <input key={selecting?'select':'playing'} type="date" aria-label="Replay start date" min={firstDate} max={lastDate} defaultValue={currentBar.date} onChange={event=>{
        const index=candles.findIndex(bar=>bar.date>=event.target.value);
        if (event.target.value && index>=0) startReplay(index);
      }}/>
      <button type="button" aria-label={replay.playing?'Pause replay':'Play replay'} disabled={selecting || replay.index===candles.length-1} onClick={()=>clock.toggle()}>{replay.playing?<Pause size={15}/>:<Play size={15}/>}</button>
      <button type="button" aria-label="Previous replay bar" disabled={selecting || replay.index===0} onClick={()=>clock.step(-1)}><SkipBack size={15}/></button>
      <button type="button" aria-label="Next replay bar" disabled={selecting || replay.index===candles.length-1} onClick={()=>clock.step()}><SkipForward size={15}/></button>
      <select aria-label="Replay speed" value={replay.speed} onChange={event=>clock.speed(Number(event.target.value))}>{[.5,1,2,4].map(speed=><option key={speed} value={speed}>{speed}×</option>)}</select>
      <output aria-label="Replay position">{selecting?'Click a bar to start':`${currentBar.date} · ${replay.index!+1}/${candles.length}`}</output>
      <button type="button" aria-label="Exit replay" title="Return to latest data" onClick={exitReplay}><X size={15}/></button>
    </div>}
    <div className={`chart-stage${selecting || replay.index!==null?' chart-stage-replay':''}`}>
      <div className="chart-plot" ref={overlayRef} data-indicator-values={appearance.statusIndicators===false?'hidden':undefined}
        onPointerUp={syncAutoScale} onDoubleClick={() => requestAnimationFrame(syncAutoScale)}>
        {paneOffsets[0] && <div className="chart-scale-buttons" style={{top: paneOffsets[0].top + paneOffsets[0].height - 28}}>
          <button type="button" aria-pressed={autoScale} title="Auto (fits data to screen)" aria-label="Auto-scale price"
            onClick={() => { engine.current?.setAutoScale?.(!autoScale); setAutoScale(!autoScale); }}>A</button>
          <button type="button" aria-pressed={appearance.scaleMode === 'logarithmic'} title="Logarithmic scale" aria-label="Logarithmic price scale"
            onClick={() => applyAppearance({scaleMode: appearance.scaleMode === 'logarithmic' ? 'normal' : 'logarithmic'})}>L</button>
        </div>}
        {(appearance.sessionClock||appearance.barCountdown)&&<ChartClock timezone={appearance.timezone??'Asia/Kolkata'} clock={Boolean(appearance.sessionClock)} countdown={Boolean(appearance.barCountdown)} />}
        <DrawingToolbar
          book={activeBook}
          firstDate={firstDate}
          lastDate={currentBar.date}
          drawingsOpen={drawingsOpen}
          onCloseMenu={() => setDrawingsOpen(false)}
        />
        <DrawingContextToolbar book={activeBook} />
      <EngineSync key={`${earningsChoice.current?.date ?? ''}|${earningsChoice.current?.line ?? ''}`} run={() => engine.current?.setUpcomingEarnings?.(earningsChoice.current)} />
      <EngineSync key={`guides:${metrics?.circuitLimit}:${metrics?.isFno}`} run={() => { if(engine.current) updateBandGuides(engine.current); }} />
      <EngineSync key={`bands:${bandChoice.current.map(change => change.date + change.to).join(',')}`} run={() => engine.current?.setBandChanges?.(bandChoice.current)} />
      {studyConfigs.fundamentals?.enabled && !allHidden && !hiddenStudies.fundamentals && <FundamentalsIndicator
        symbol={symbol} revision={revision} cutoff={revealedThrough(candles, replay.index, sessionDate)} sessionDate={sessionDate}
        metrics={metrics} config={studyConfigs.fundamentals}
        onMoveBadge={badgeOffset => applyFundamentals({...studyConfigsChoice.current.fundamentals!, badgeOffset})}
        onMove={offset => applyFundamentals({...studyConfigsChoice.current.fundamentals!, offset})}/>}
      <div className="chart-overlay-legend">
        <ChartLegend symbol={symbol} bar={currentBar} previous={previousByDate.get(currentBar.date)} quoteRef={quote}
          // The toolbar already names the symbol, so the status line's own title is opt-in.
          status={{logo:appearance.statusLogo===true,title:appearance.statusTitle===true,titleMode:appearance.statusTitleMode??'symbol',
            marketStatus:appearance.statusMarketStatus===true,ohlc:appearance.statusOhlc!==false,change:appearance.statusBarChange!==false,
            volume:appearance.statusVolume!==false,interval:interval==='D'?'1D':interval==='W'?'1W':'1M',name:metrics?.name,
            background:appearance.statusBackground?{color:appearance.statusBackgroundColor,opacity:appearance.statusBackgroundOpacity??.8}:undefined}}
          metrics={replay.index===null&&!selecting?metrics:undefined} sessionDate={replay.index===null&&!selecting?sessionDate:undefined}/>
        <PricePaneLegend
          engine={engine.current}
          indicatorSeries={indicatorSeries}
          snapshotIndex={replay.index ?? candles.length - 1}
          studies={visibleStudies}
          studyConfigs={studyConfigs}
          emaLines={emaLines}
          appearance={appearance}
          onOpenIndicators={() => setIndicatorsOpen(true)}
          onOpenSettings={id => setActiveIndicatorSetting(id)}
          onUpdateEmaLines={updateEmaLines}
          onUpdateStudies={applyStudies}
          onUpdateAppearance={applyAppearance}
          hiddenStudies={hiddenStudies}
          onToggleStudyVisibility={toggleStudyVisibility}
          onUpdateExtras={applyExtras}
          onUpdateFundamentals={applyFundamentals}
          collapsed={Boolean(appearance.legendCollapsed)}
          onToggleCollapsed={() => applyAppearance({legendCollapsed: !appearanceChoice.current.legendCollapsed})}
          allHidden={allHidden}
          onToggleAllHidden={toggleAllIndicators}
        />
      </div>
      <SubPaneLegends
        engine={engine.current}
        indicatorSeries={indicatorSeries}
        snapshotIndex={replay.index ?? candles.length - 1}
        studies={visibleStudies}
        studyConfigs={studyConfigs}
        emaLines={emaLines}
        appearance={appearance}
        paneOffsets={paneOffsets}
        onOpenIndicators={() => setIndicatorsOpen(true)}
        onOpenSettings={id => setActiveIndicatorSetting(id)}
        onUpdateEmaLines={updateEmaLines}
        onUpdateStudies={applyStudies}
        onUpdateAppearance={applyAppearance}
        hiddenStudies={hiddenStudies}
        onToggleStudyVisibility={toggleStudyVisibility}
        onUpdateExtras={applyExtras}
      />
      <div className="chart-actions-zone" role="group" aria-label="Chart controls">
        <div className="chart-actions">
          <Button aria-label="Zoom in" title="Zoom in (+)" onClick={() => {markCustomRange();engine.current?.zoom(.8);}}><Plus size={15}/></Button>
          <Button aria-label="Zoom out" title="Zoom out (-)" onClick={() => {markCustomRange();engine.current?.zoom(1.25);}}><Minus size={15}/></Button>
          <Button aria-label="Reset chart view" title="Reset chart view (Home)" onClick={() => {markCustomRange();engine.current?.reset();}}><RotateCcw size={14}/></Button>
          <Button variant="ghost" className="chart-auto-btn" title="Restore automatic price scaling" onClick={() => engine.current?.resetPriceScale()}>Auto</Button>
        </div>
      </div>
      {error ? <p role="alert" className="notice">{error}</p> : <div ref={attach} className="nexus-chart-canvas" role="group" tabIndex={0} onContextMenu={event=>{event.preventDefault();setContext({x:event.clientX,y:event.clientY});}} onKeyDownCapture={event=>{
        if ((event.key==='ContextMenu') || (event.key==='F10' && event.shiftKey)) {event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();setContext({x:rect.left+24,y:rect.top+24});}
        if (replay.index===null && ['ArrowLeft','ArrowRight','Home','+','=','-'].includes(event.key)) markCustomRange();
        if (replay.index!==null && [' ','ArrowRight','ArrowLeft'].includes(event.key)) {event.preventDefault();event.stopPropagation(); if(event.key===' ') clock.toggle();else clock.step(event.key==='ArrowLeft'?-1:1);}
      }}
        aria-label={`${symbol} ${style==='candles'?'candlestick':style==='bars'?'HLC':style}${appearance.volume?' and volume':''} chart`} aria-describedby={`chart-keyboard-help-${tileId}`}
      />}
      {context && <ChartContextMenu {...context} onClose={()=>setContext(null)}>
        <button type="button" role="menuitem" onClick={()=>{markCustomRange();engine.current?.reset();setContext(null);}}>Reset chart view</button>
        <button type="button" role="menuitem" onClick={()=>{engine.current?.resetPriceScale();setContext(null);}}>Restore automatic scale</button>
        <button type="button" role="menuitem" onClick={()=>{setSettingsOpen(true);setContext(null);}}>Chart settings</button>
        <button type="button" role="menuitem" onClick={()=>{selectBar();setContext(null);}}>Start bar replay</button>
        <button type="button" role="menuitem" onClick={()=>{saveImage();setContext(null);}}>Save chart image</button>
      </ChartContextMenu>}
      </div>
    </div>
    <footer className="chart-statusbar">
      <div className="chart-ranges" role="group" aria-label="Visible date range">{ranges.map(([months,label])=><button type="button" key={label} aria-pressed={range===months} onClick={()=>{setRange(months);rangeChoice.current=months;engine.current?.setRange(months);persist({range:months,view:undefined});}}>{label}</button>)}</div>
      <select className="chart-range-select" aria-label="Visible date range" value={range===undefined?'custom':range===null?'all':range} onChange={event=>{const months=event.target.value==='all'?null:Number(event.target.value);setRange(months);rangeChoice.current=months;engine.current?.setRange(months);persist({range:months,view:undefined});}}><option value="custom" disabled>Range</option>{ranges.map(([months,label])=><option key={label} value={months??'all'}>{label}</option>)}</select>
      <button type="button" className="chart-latest" onClick={()=>engine.current?.latest()}>Latest</button>
      {comparison && <ChartComparison {...comparison} revision={revision} sessionDate={sessionDate} interval={interval} onData={onComparison}/>}
    </footer>
    {indicatorsOpen && (
      <IndicatorsCatalogModal
        studies={studies}
        emaLines={emaLines}
        interval={interval}
        appearance={appearance}
        onApplyStudies={applyStudies}
        onApplyEmaLines={lines => {
          updateEmaLines(lines);
          setIndicatorsOpen(false);
          try { localStorage.setItem(EMA_PREFS_KEY, JSON.stringify(lines)); } catch { /* ignore */ }
        }}
        onApplyAppearance={applyAppearance}
        fundamentals={studyConfigs.fundamentals}
        onApplyFundamentals={applyFundamentals}
        extras={studyConfigs.extras}
        onApplyExtras={applyExtras}
        onOpenIndicatorSettings={id => {
          setIndicatorsOpen(false);
          setActiveIndicatorSetting(id);
        }}
        onClose={() => setIndicatorsOpen(false)}
      />
    )}
    {activeIndicatorSetting && EXTRA_STUDY_BY_ID.has(activeIndicatorSetting as ExtraStudyId) && (
      <ExtraStudySettingsDialog
        def={EXTRA_STUDY_BY_ID.get(activeIndicatorSetting as ExtraStudyId)!}
        state={studyConfigs.extras?.[activeIndicatorSetting as ExtraStudyId]}
        onApply={next => applyExtras({...studyConfigsChoice.current.extras, [activeIndicatorSetting]: next})}
        onClose={() => setActiveIndicatorSetting(null)}
      />
    )}
    {activeIndicatorSetting === 'fundamentals' && <FundamentalsSettingsDialog config={studyConfigs.fundamentals}
      onApply={applyFundamentals} onClose={() => setActiveIndicatorSetting(null)}/>}
    {activeIndicatorSetting && activeIndicatorSetting !== 'fundamentals' && !EXTRA_STUDY_BY_ID.has(activeIndicatorSetting as ExtraStudyId) && (
      <IndicatorSettingsModal
        indicatorId={activeIndicatorSetting}
        configs={studyConfigs}
        emaLines={emaLines}
        appearance={appearance}
        onApplyConfigs={applyStudyConfigs}
        onApplyEmaLines={lines => {
          updateEmaLines(lines);
          try { localStorage.setItem(EMA_PREFS_KEY, JSON.stringify(lines)); } catch { /* ignore */ }
        }}
        onApplyAppearance={applyAppearance}
        onClose={() => setActiveIndicatorSetting(null)}
      />
    )}
    {settingsOpen && <ChartSettingsDialog appearance={appearance} chartStyle={style} symbol={symbol} comparison={comparison} firstDate={firstDate} lastDate={currentBar.date} onClose={()=>setSettingsOpen(false)} onApply={(nextAppearance,nextStyle,nextComparison)=>{
      applyAppearance(nextAppearance);
      if(nextStyle!==style) {setStyle(nextStyle);styleChoice.current=nextStyle;engine.current?.setStyle(nextStyle);persist({style:nextStyle});}
      applyComparison(nextComparison);
    }} onGoToDate={date=>{const moved=engine.current?.goToDate(date)??false;if(moved) markCustomRange();return moved;}} onEvents={()=>setEventDetails(events.filter(event=>event.date<=revealedThrough(candles,replay.index,lastDate)))}/>}
    {eventDetails && <ChartDialog title="Published events" onClose={()=>setEventDetails(null)}><div className="chart-event-list">{eventDetails.length?eventDetails.map(event=><article key={event.id}><small>{event.date} · {event.kind==='action'?'Corporate action':event.kind==='earnings'?'Earnings filing':'News'}</small><p>{event.title}</p></article>):<p>No published events in this history.</p>}</div></ChartDialog>}
    <p id={`chart-keyboard-help-${tileId}`} className="sr-only">Two clicks or drag to draw. Select to move; drag handles to reshape. Delete removes. Ctrl or Command Z undoes. Escape cancels. Scroll or pinch zooms. Drag the right price scale to stretch or compress prices; double-click it to restore automatic scaling. Drag pane separators to resize. Alt Enter maximizes or restores the chart. While selecting a replay bar, use Left and Right then Enter, or click a bar. During replay, Space plays or pauses and Left or Right steps one bar.</p>
  </>;
}

export default function ChartsTab({datasetRevision,sessionDate}:{datasetRevision?:string;sessionDate?:string}) {
  const [grid,setGrid]=useState(()=>loadGrid());
  const gridChoice=useRef(grid);
  const [sync]=useState(()=>Object.assign(new ChartSync(),{enabled:true,dates:grid.links.dates,crosshairs:grid.links.crosshair}));
  const [shortcutsOpen,setShortcutsOpen]=useState(false);
  useMountEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isEditable(event.target)) return;
      // Open dialogs and focused menus own the keyboard (an expanded chart tile is not a dialog here).
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (document.activeElement instanceof Element && document.activeElement.closest('[role="menu"], [role="listbox"]')) return;
      if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); setShortcutsOpen(true); return; }
      const focused = document.activeElement instanceof Element ? document.activeElement.closest('.chart-workspace') : null;
      const tile = document.querySelector('.chart-workspace-expanded') ?? focused ?? document.querySelector('.chart-workspace');
      const result = tile ? tileShortcutHandlers.get(tile)?.(event) : null;
      if (result === 'consume') event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  const [layouts,setLayouts]=useState(loadNamedLayouts);
  const [layoutsOpen,setLayoutsOpen]=useState(false);
  const [layoutName,setLayoutName]=useState('');
  const [layoutError,setLayoutError]=useState('');
  const [generation,setGeneration]=useState(0);
  const warning=useSyncExternalStore(chartStorage.subscribe,chartStorage.getSnapshot,chartStorage.getSnapshot);

  const [expandedTile, setExpandedTile] = useState<string | null>(() => {
    const saved = readChartStorage('chart-fullscreen.v1');
    return typeof saved === 'string' ? saved : null;
  });
  const expandedChoice = useRef(expandedTile);

  const handleToggleExpand = useCallback((tileId: string) => {
    const next = expandedChoice.current === tileId ? null : tileId;
    expandedChoice.current = next;
    setExpandedTile(next);
    writeChartStorage('chart-fullscreen.v1', next);
  }, []);

  const handleCloseExpand = useCallback(() => {
    expandedChoice.current = null;
    setExpandedTile(null);
    writeChartStorage('chart-fullscreen.v1', null);
  }, []);

  const activeExpandedTile = (expandedTile !== null && Number(expandedTile) < grid.count) ? expandedTile : null;

  const updateGrid=useCallback((change:Partial<GridSettings>)=>{
    const next={...gridChoice.current,...change};gridChoice.current=next;sync.dates=next.links.dates;sync.crosshairs=next.links.crosshair;setGrid(next);writeChartStorage('grid.v1',next);
  },[sync]);
  const updateTile=useCallback((id:string,tile:TileSettings)=>{
    const {links}=gridChoice.current;
    updateGrid({tiles:gridChoice.current.tiles.map((current,index)=>String(index)===id?tile:{symbol:links.symbol?tile.symbol:current.symbol,interval:links.interval?tile.interval:current.interval})});
  },[updateGrid]);
  const selectWatchlistSymbol=useCallback((symbol:string)=>{
    const targetIndex=Number(activeExpandedTile??'0');
    const targetTile=gridChoice.current.tiles[targetIndex]??gridChoice.current.tiles[0];
    updateTile(String(targetIndex),{...targetTile,symbol});
  },[activeExpandedTile,updateTile]);

  const layoutControls = (
    <div className="chart-desk-toolbar" role="group" aria-label="Chart layout">
      <button type="button" className="chart-shortcuts-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={()=>setShortcutsOpen(true)}><Keyboard size={15}/></button>
      <button type="button" className="chart-layouts-button" aria-label="Layouts" title="Saved layouts" onClick={()=>setLayoutsOpen(true)}><LayoutTemplate size={14} aria-hidden="true"/><span>Layouts</span></button>
      <ChartLayoutPicker
        value={grid.layout}
        links={grid.links}
        onLayout={layout => {
          const newCount = chartLayout(layout).count;
          if (newCount > 1) {
            handleCloseExpand();
          }
          updateGrid({layout, count: newCount});
        }}
        onLinks={links=>updateGrid({links})}
      />
    </div>
  );

  return <div className="chart-desk">
    {/* One chart shows the desk controls in its own toolbar; a grid shares a slim header. */}
    {!activeExpandedTile && grid.count > 1 && <div className="chart-desk-header">{layoutControls}</div>}
    {warning&&<p role="status" className="notice">{warning}</p>}
    <div className={`chart-desk-body${activeExpandedTile ? ' chart-desk-body-expanded' : ''}`}>
      <div className={`chart-grid chart-grid-${grid.count}`} style={{gridTemplateColumns:`repeat(${chartLayout(grid.layout).columns},minmax(${chartLayout(grid.layout).minColumnWidth}px,1fr))`,gridTemplateRows:`repeat(${chartLayout(grid.layout).rows.length},minmax(260px,1fr))`,gridTemplateAreas:layoutAreas(chartLayout(grid.layout).rows)}}>
        {grid.tiles.slice(0,grid.count).map((tile,index)=>{
          const tileId = String(index);
          const isExpanded = activeExpandedTile === tileId;
          return (
            <ChartTile
              key={`${generation}:${index}:${tile.symbol}:${tile.interval}`}
              datasetRevision={datasetRevision}
              sessionDate={sessionDate}
              tileId={tileId}
              initial={tile}
              onChange={updateTile}
              sync={sync}
              area={String.fromCharCode(97+index)}
              expanded={isExpanded}
              onToggleExpand={() => handleToggleExpand(tileId)}
              onCloseExpand={handleCloseExpand}
              layoutControls={isExpanded || (!activeExpandedTile && grid.count === 1) ? layoutControls : undefined}
            />
          );
        })}
      </div>
      <WatchlistDock
        datasetRevision={datasetRevision}
        sessionDate={sessionDate}
        activeSymbol={grid.tiles[Number(activeExpandedTile ?? '0')]?.symbol}
        onSelectSymbol={selectWatchlistSymbol}
      />
    </div>
    {shortcutsOpen&&<ChartShortcutsDialog onClose={()=>setShortcutsOpen(false)}/>}
    {layoutsOpen&&<ChartDialog title="Saved layouts" className="chart-layouts-dialog" onClose={()=>setLayoutsOpen(false)}><div className="chart-layouts">
      <form className="chart-layouts-form" onSubmit={event=>{
        event.preventDefault();const name=layoutName.trim();
        if(!name) {setLayoutError('Enter a layout name.');return;}
        if(layouts.length>=10&&!layouts.some(layout=>layout.name===name)) {setLayoutError('Up to 10 layouts can be saved. Remove one first.');return;}
        const scenes=Array.from({length:MAX_CHARTS},(_,index)=>loadScene(String(index)));
        const existing = layouts.find(l => l.name === name);
        const layout: SavedLayout = {
          id: existing?.id ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ws-${Date.now()}`),
          name,
          grid: gridChoice.current,
          scenes,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        const next=[...layouts.filter(l=>l.name!==name),layout];
        if(saveNamedLayouts(next)) {setLayouts(next);setLayoutName('');setLayoutError('');}
      }}>
        <div className="chart-layouts-input-wrap">
          <input aria-label="Layout name" placeholder="Enter layout name..." value={layoutName} maxLength={40} onChange={event=>setLayoutName(event.target.value)}/>
          <button type="submit">Save current</button>
        </div>
      </form>
      <div className="chart-layouts-caption">Standard OpenAlgo workspace format. Drawings, indicators, and layouts persist across sessions.</div>
      {layoutError&&<div className="chart-layouts-error" role="alert">{layoutError}</div>}
      <div className="chart-saved-layouts-list">
        {layouts.length===0?(
          <div className="chart-layouts-empty">No saved layouts yet. Save your current chart arrangement above.</div>
        ):(
          layouts.map(layout=><div className="chart-saved-layout" key={layout.name}>
            <button type="button" className="chart-saved-layout-btn" aria-label={`Load layout ${layout.name}`} onClick={()=>{
              if (layout.grid.count > 1) {
                handleCloseExpand();
              }
              sync.persistenceEpoch++;layout.scenes.forEach((scene,index)=>writeChartStorage(`scene.${index}.v1`,scene));updateGrid(layout.grid);setGeneration(value=>value+1);setLayoutsOpen(false);
            }}>
              <span className="chart-saved-layout-name">{layout.name}</span>
              <span className="chart-saved-layout-badge">{layout.grid.count} {layout.grid.count===1?'chart':'charts'} · {layout.grid.layout}</span>
            </button>
            <button type="button" className="chart-saved-layout-action" aria-label={`Export layout ${layout.name}`} title="Export workspace JSON" onClick={()=>{
              const json = exportWorkspaceDocumentJson(layout);
              const blob = new Blob([json], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${layout.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.workspace.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}>
              <Download size={13}/>
            </button>
            <button type="button" className="chart-saved-layout-del" aria-label={`Delete layout ${layout.name}`} title={`Delete layout ${layout.name}`} onClick={()=>{const next=layouts.filter(item=>item.name!==layout.name);if(saveNamedLayouts(next)) setLayouts(next);}}>
              <X size={14}/>
            </button>
          </div>)
        )}
      </div>
      <div className="chart-layouts-footer-actions">
        <label className="chart-layouts-import-btn" title="Import OpenAlgo workspace document">
          <Upload size={12}/>
          <span>Import workspace JSON</span>
          <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={event => {
            const file = event.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = e => {
              const content = e.target?.result;
              if (typeof content !== 'string') return;
              const imported = importWorkspaceDocumentJson(content);
              if (!imported) {
                setLayoutError('Invalid OpenAlgo workspace JSON document.');
                return;
              }
              const next = [...layouts.filter(l => l.name !== imported.name), imported];
              if (saveNamedLayouts(next)) {
                setLayouts(next);
                setLayoutError('');
              }
            };
            reader.readAsText(file);
            event.target.value = '';
          }}/>
        </label>
      </div>
    </div></ChartDialog>}
  </div>;
}

function ChartTile({
  datasetRevision,
  sessionDate,
  tileId,
  initial,
  onChange,
  sync,
  area,
  expanded,
  onToggleExpand,
  onCloseExpand,
  layoutControls,
}: {
  datasetRevision?: string;
  sessionDate?: string;
  tileId: string;
  initial: TileSettings;
  onChange: (tileId: string, settings: TileSettings) => void;
  sync: ChartSync;
  area: string;
  expanded?: boolean;
  onToggleExpand: () => void;
  onCloseExpand: () => void;
  layoutControls?: ReactNode;
}) {
  const {symbol,interval}=initial;
  const searchRef = useRef<ChartSymbolSearchHandle>(null);
  const sceneActions = useRef<ChartSceneActions | null>(null);
  const [inputError, setInputError] = useState('');
  const book=savedDrawingBook(symbol);
  const changeInterval=(next:Interval)=>onChange(tileId,{symbol,interval:next});
  const [intervalDraft,setIntervalDraft]=useState<string|null>(null);
  const metadata=useQuery({
    queryKey:['chart-metrics',datasetRevision,symbol,sessionDate],
    queryFn:async()=>{
      const result=await screenerApi.runScreen({datasetRevision,universe:'custom',customSymbols:[symbol],asOfDate:sessionDate ?? '',page:1,pageSize:1,expressionTree:{type:'group',operator:'all',children:[]}});
      if (result.immutableRevision!==datasetRevision) throw new Error('Chart metrics revision mismatch');
      return result.rows.find(row=>row.symbol===symbol)??null;
    },
    enabled:Boolean(datasetRevision),retry:false,staleTime:Infinity,
  });
  const chart = useQuery({
    queryKey: ['chart', datasetRevision, symbol, sessionDate],
    queryFn: async () => {
      const snapshot = await screenerApi.getChart(symbol, datasetRevision, sessionDate);
      return {...snapshot, candles: validateCandles(snapshot.candles)};
    },
    enabled: Boolean(datasetRevision),
    retry: false,
    staleTime: Infinity,
  });
  // Loaded with the candles so relative-strength studies render without rebuilding the chart.
  const benchmark = useQuery({
    queryKey: ['benchmark', datasetRevision],
    queryFn: async () => (await screenerApi.getBenchmark(datasetRevision)) ?? null,
    enabled: Boolean(datasetRevision), retry: false, staleTime: Infinity,
  });
  const candles = useMemo(() => aggregate(chart.data?.candles ?? [], interval), [chart.data, interval]);
  const events=useMemo(()=>chart.data?chartEvents(chart.data):[],[chart.data]);
  const symbolControls=<>{intervalDraft!==null&&<IntervalPrompt initial={intervalDraft} onInterval={changeInterval}
      onSymbol={text=>searchRef.current?.open(text)} onClose={()=>setIntervalDraft(null)} />}<ChartSymbolSearch key={symbol} symbol={symbol} datasetRevision={datasetRevision} sessionDate={sessionDate}
        handleRef={searchRef} onError={setInputError} onSelect={next => onChange(tileId, {symbol: next, interval})} />
      <div className="chart-bar-divider" aria-hidden="true" />
      <div className="chart-intervals" role="group" aria-label="Candle interval">
        {(['D', 'W', 'M'] as const).map(value => <button type="button" key={value} aria-pressed={interval === value}
          aria-label={value === 'D' ? 'Daily candles' : value === 'W' ? 'Weekly candles' : 'Monthly candles'} onClick={() => changeInterval(value)}>{value==='D'?'1D':value==='W'?'1W':'1M'}</button>)}
      </div>
      <select className="chart-interval-select" aria-label="Candle interval" value={interval} onChange={event=>changeInterval(event.target.value as Interval)}><option value="D">1D</option><option value="W">1W</option><option value="M">1M</option></select></>;
  const stepWatchlist = (direction: 1 | -1) => {
    const stored = readChartStorage(WATCHLIST_KEY);
    const symbols = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string' && !item.startsWith('###')) : [];
    if (!symbols.length) return;
    const index = symbols.indexOf(symbol);
    const next = symbols[index < 0 ? 0 : (index + direction + symbols.length) % symbols.length];
    if (next !== symbol) onChange(tileId, {symbol: next, interval});
  };
  const handleShortcut: TileShortcutHandler = event => {
    const actions = sceneActions.current;
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const digit = /^Digit([1-3])$/.exec(event.code);
      if (digit) { changeInterval(INTERVALS[Number(digit[1]) - 1]); return 'consume'; }
      const command = ({KeyI: actions?.openIndicators, KeyL: actions?.toggleLegend, KeyV: actions?.toggleAllIndicators,
        KeyH: actions?.toggleDrawings, KeyR: actions?.resetView, KeyS: actions?.saveImage} as Record<string, (() => void) | undefined>)[event.code];
      if (command) { command(); return 'consume'; }
      return null;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    if (event.key === '[' || event.key === ']') {
      const index = INTERVALS.indexOf(interval);
      changeInterval(INTERVALS[Math.min(INTERVALS.length - 1, Math.max(0, index + (event.key === ']' ? 1 : -1)))]);
      return 'consume';
    }
    if (event.key === ',' || event.key === '.') { stepWatchlist(event.key === '.' ? 1 : -1); return 'consume'; }
    if (event.key === '/') { searchRef.current?.open(); return 'consume'; }
    // As in TradingView: a digit opens the interval box, a letter starts a symbol search.
    if (/^[0-9]$/.test(event.key)) { setIntervalDraft(event.key); return 'consume'; }
    if (/^[A-Za-z&]$/.test(event.key)) { searchRef.current?.open(event.key.toUpperCase()); return 'consume'; }
    return null;
  };
  const handleShortcutRef = useRef(handleShortcut);
  handleShortcutRef.current = handleShortcut;
  const registerShortcuts = (element: HTMLElement | null) => {
    if (!element) return;
    tileShortcutHandlers.set(element, event => handleShortcutRef.current(event));
    return () => { tileShortcutHandlers.delete(element); };
  };
  const viewControls = (
    <Button
      className="chart-expand"
      aria-label={expanded ? 'Restore chart' : 'Maximize chart'}
      aria-pressed={Boolean(expanded)}
      title={`${expanded ? 'Restore' : 'Maximize'} chart (Alt/⌥ Enter)`}
      onClick={onToggleExpand}
    >
      {expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}
    </Button>
  );
  return <section ref={registerShortcuts} style={{gridArea:area}} className={`chart-workspace${expanded?' chart-workspace-expanded':''}`} aria-label={expanded?'Nexus charts':`Chart ${Number(tileId)+1} · ${symbol}`}
    role={expanded?'dialog':undefined} aria-modal={expanded?true:undefined} onKeyDown={event=>{
      if (event.altKey && event.key==='Enter') { event.preventDefault(); onToggleExpand(); }
      if (expanded && event.key==='Escape') { event.preventDefault(); onCloseExpand(); }
      if (expanded && event.key==='Tab') {
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary, [tabindex="0"], a[href]')).filter(element=>element.getClientRects().length>0);
        const first=controls[0],last=controls.at(-1);
        if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    {(chart.isError || chart.isPending || !candles.length) && <header className="chart-topbar">{symbolControls}<span className="chart-topbar-spacer"/>{layoutControls}{viewControls}</header>}
    {inputError && <p role="alert" className="notice">{inputError}</p>}
    {chart.isError ? <div role="alert" className="chart-status"><p>{chart.error.message}</p><Button variant="ghost" onClick={() => void chart.refetch()}>Retry</Button></div>
      : chart.isPending || benchmark.isPending ? <p className="chart-status" role="status">Loading chart history…</p>
      : !candles.length ? <p className="chart-status" role="status">No published candles for {symbol}.</p>
      : <ChartScene key={`${datasetRevision}:${sessionDate}:${symbol}:${interval}`} candles={candles} symbol={symbol} book={book} symbolControls={symbolControls} viewControls={viewControls} layoutControls={layoutControls}
          firstDate={chart.data.candles[0].date} lastDate={chart.data.candles.at(-1)!.date} metrics={metadata.data??undefined} sessionDate={chart.data.asOfDate} events={events} revision={datasetRevision!} interval={interval} tileId={tileId} sync={sync} benchmark={benchmark.data ?? undefined} actionsRef={sceneActions}/>}
  </section>;
}
