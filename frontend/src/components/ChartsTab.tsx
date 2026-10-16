import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CandlestickChart, ChartNoAxesColumn, ChartNoAxesCombined, Eye, EyeOff, Maximize2, Minimize2, Minus, Pause, Pencil, Play, Plus, RotateCcw, Settings, Settings2, SkipBack, SkipForward, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import { ChartEngine, type ChartAppearance, type ChartStudies, type ChartStyle } from '../chart/ChartEngine';
import { ReplayClock } from '../chart/ReplayClock';
import { aggregate, ema, validateCandles, type Candle, type Interval } from '../chart/model';
import { DrawingBook } from '../chart/drawings';
import { DrawingToolbar } from './DrawingToolbar';
import { DrawingContextToolbar } from './DrawingContextToolbar';
import { EmaSettings, EMA_PREFS_KEY, loadEmaLines } from './EmaSettings';
import { ChartLegend, updateCandleValues, type ChartMetrics } from './ChartLegend';
import { ChartDialog } from './ChartDialog';
import { ChartContextMenu } from './ChartContextMenu';
import { SymbolWithLogo } from './SymbolWithLogo';
import { ChartComparison } from './ChartComparison';
import { chartEvents, revealedThrough, type ChartEvent } from '../chart/events';
import { defaultStudies, supertrend } from '../chart/studies';
import { chartStorage, loadGrid, loadScene, loadNamedLayouts, saveNamedLayouts, exportWorkspaceDocumentJson, importWorkspaceDocumentJson, writeChartStorage, savedDrawingBook, type GridSettings, type SceneSettings, type TileSettings, type SavedLayout } from '../chart/storage';
import { ChartSync } from '../chart/ChartSync';
import { ChartLayoutPicker } from './ChartLayoutPicker';
import { chartLayout, layoutAreas, MAX_CHARTS } from '../chart/layouts';
import { ChartSettingsDialog } from './ChartSettingsDialog';
import { Download, Upload } from 'lucide-react';

const ranges=[[1,'1mo'],[3,'3mo'],[6,'6mo'],[12,'1y'],[24,'2y'],[null,'All']] as const;

function ChartScene({candles, symbol, book, firstDate, lastDate,metrics,sessionDate,symbolControls,viewControls,events,revision,interval,tileId,sync}: {candles: readonly Candle[]; symbol: string;book:DrawingBook;firstDate:string;lastDate:string;metrics?:ChartMetrics;sessionDate:string;symbolControls:ReactNode;viewControls:ReactNode;events:readonly ChartEvent[];revision:string;interval:Interval;tileId:string;sync:ChartSync}) {
  const [saved]=useState(()=>loadScene(tileId));
  const paneChoice=useRef(saved.paneWeights);
  const engine = useRef<ChartEngine | null>(null);
  const quote = useRef<HTMLOutputElement>(null);
  const previousByDate=useMemo(()=>new Map(candles.map((bar,index)=>[bar.date,candles[index-1]])),[candles]);
  const [emaLines,setEmaLines]=useState(()=>saved.emaLines??loadEmaLines());
  const emaChoice=useRef(emaLines);
  const [style,setStyle]=useState<ChartStyle>(saved.style??'candles');
  const styleChoice=useRef<ChartStyle>(style);
  const [range,setRange]=useState<number|null|undefined>(saved.range);
  const rangeChoice=useRef<number|null|undefined>(range);
  const [drawingsOpen,setDrawingsOpen]=useState(false);
  const [indicatorsOpen,setIndicatorsOpen]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [context,setContext]=useState<{x:number;y:number}|null>(null);
  const [appearance,setAppearance]=useState<ChartAppearance>({horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal',...saved.appearance,volumePane:saved.appearance?.volumePane??true});
  const appearanceChoice=useRef(appearance);
  const [studies,setStudies]=useState<ChartStudies>(saved.studies??defaultStudies());
  const studyChoice=useRef(studies);
  const [comparison,setComparison]=useState<{symbol:string;separate:boolean}|null>(saved.comparison??null);
  const persist=(change:Partial<SceneSettings>)=>writeChartStorage(`scene.${tileId}.v1`,{...loadScene(tileId),...change});
  const comparisonChoice=useRef<{symbol:string;candles:readonly Candle[];separate:boolean}>({symbol:'',candles:[],separate:false});
  const onComparison=useCallback((symbol:string,candles:readonly Candle[],separate:boolean)=>{
    comparisonChoice.current={symbol,candles,separate};engine.current?.setComparison(symbol,candles,separate);
    if(paneChoice.current) engine.current?.restorePaneWeights(paneChoice.current);
  },[]);
  const applyStudies=(next:ChartStudies)=>{studyChoice.current=next;setStudies(next);engine.current?.setStudies({...next,vwap:interval==='D'&&next.vwap});persist({studies:next});};
  const applyComparison=(next:typeof comparison)=>{setComparison(next);persist({comparison:next});if(!next) onComparison('',[],false);};
  const [eventDetails,setEventDetails]=useState<readonly ChartEvent[]|null>(null);
  const [clock]=useState(()=>new ReplayClock(candles.length));
  const replay=useSyncExternalStore(clock.subscribe,clock.getSnapshot,clock.getSnapshot);
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
      const revealed=()=>clock.getSnapshot().index===null?candles:candles.slice(0,clock.getSnapshot().index!+1);
      chart = new ChartEngine(host, revealed(), bar => {
        if (quote.current) updateCandleValues(quote.current,bar,previousByDate.get(bar.date));
      },activeBook,setEventDetails);
      chart.setEmaLines(emaChoice.current);
      chart.setStyle(styleChoice.current);
      chart.setAppearance(appearanceChoice.current);
      chart.setStudies({...studyChoice.current,vwap:interval==='D'&&studyChoice.current.vwap});
      chart.setEvents(events,revealedThrough(candles,clock.getSnapshot().index,lastDate));
      const comparison=comparisonChoice.current;chart.setComparison(comparison.symbol,comparison.candles,comparison.separate);
      if (rangeChoice.current!==undefined) chart.setRange(rangeChoice.current);
      if(saved.view&&clock.getSnapshot().index===null) chart.restoreView(saved.view);
      if(paneChoice.current) chart.restorePaneWeights(paneChoice.current);
      if (selectingChoice.current) chart.setReplayPicker(startReplay,cancelSelection);
      let previousIndex=clock.getSnapshot().index;
      const unsubscribe=clock.subscribe(()=>{
        const index=clock.getSnapshot().index;
        if (index!==previousIndex) { previousIndex=index; chart.setCandles(revealed());chart.setEvents(events,revealedThrough(candles,index,lastDate)); }
      });
      engine.current = chart;
      const normalView=clock.getSnapshot().index===null,epoch=sync.persistenceEpoch;
      const unlink=normalView?sync.connect(chart,host):()=>{};
      let timer:ReturnType<typeof setTimeout>|undefined;
      const saveView=()=>{
        if(!normalView||clock.getSnapshot().index!==null||selectingChoice.current||epoch!==sync.persistenceEpoch) return;
        const view=chart.savedView(),paneWeights=chart.paneWeights();paneChoice.current=paneWeights;
        writeChartStorage(`scene.${tileId}.v1`,{...loadScene(tileId),style:styleChoice.current,appearance:appearanceChoice.current,studies:studyChoice.current,emaLines:emaChoice.current,range:rangeChoice.current,view,paneWeights});
      };
      const scheduleSave=()=>{clearTimeout(timer);timer=setTimeout(saveView,200);};
      chart.chart.timeScale().subscribeVisibleTimeRangeChange(scheduleSave);
      host.addEventListener('pointerup',scheduleSave,true);window.addEventListener('pagehide',saveView);
      saveView();
      return () => { clearTimeout(timer);saveView();window.removeEventListener('pagehide',saveView);host.removeEventListener('pointerup',scheduleSave,true);chart.chart.timeScale().unsubscribeVisibleTimeRangeChange(scheduleSave);unlink();unsubscribe(); chart.destroy(); if (engine.current === chart) engine.current = null; };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chart rendering unavailable.');
      return;
    }
  }, [candles,activeBook,clock,previousByDate,startReplay,cancelSelection,events,lastDate,interval,sync,saved.view,tileId]);
  const applyAppearance=(change:Partial<typeof appearance>)=>{
    const next={...appearanceChoice.current,...change};
    appearanceChoice.current=next;setAppearance(next);engine.current?.setAppearance(next);
    persist({appearance:next});
  };
  return <>
    <header className="chart-topbar">
      {symbolControls}
      <div className="chart-bar-divider" aria-hidden="true" />
      <label className="chart-style-select" title="Chart style">
        {style==='candles'?<CandlestickChart size={16}/>:style==='bars'?<ChartNoAxesColumn size={16}/>:<ChartNoAxesCombined size={16}/>}
        <select aria-label="Chart style" value={style} onChange={event=>{const next=event.target.value as ChartStyle;setStyle(next);styleChoice.current=next;engine.current?.setStyle(next);persist({style:next});}}><option value="candles">Candles</option><option value="bars">HLC bars</option><option value="line">Line</option><option value="area">Area</option><option value="baseline">Baseline</option></select>
      </label>
      <button type="button" className="chart-toolbar-button" aria-label="Indicators" title="Indicators" onClick={()=>setIndicatorsOpen(true)}><SlidersHorizontal size={15}/><span>Indicators</span></button>
      <button type="button" className="chart-icon-button chart-drawing-toggle" aria-label={drawingsOpen?'Hide drawing tools':'Show drawing tools'} title="Drawing tools" aria-pressed={drawingsOpen} onClick={()=>{if(drawingsOpen) activeBook.setTool('select');setDrawingsOpen(value=>!value);}}><Pencil size={15}/></button>
      <button type="button" className="chart-toolbar-button chart-replay-toggle" aria-label="Replay" title="Bar replay" aria-pressed={selecting || replay.index!==null} onClick={()=>{
        if (selecting || replay.index!==null) exitReplay(); else selectBar();
      }}><Play size={14}/><span>Replay</span></button>
      <span className="chart-topbar-spacer" />
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
      {drawingsOpen && <DrawingToolbar book={activeBook} firstDate={firstDate} lastDate={currentBar.date}/>}
      <div className="chart-plot">
      <DrawingContextToolbar book={activeBook} />
      <div className="chart-overlay-legend">
        <ChartLegend symbol={symbol} bar={currentBar} previous={previousByDate.get(currentBar.date)} quoteRef={quote}
          metrics={replay.index===null&&!selecting?metrics:undefined} sessionDate={replay.index===null&&!selecting?sessionDate:undefined}/>
        <div className="chart-indicator-legend">
          {emaLines.map(line=>{
            const values=ema(candles,line.period);
            const val=values.at(-1);
            return (
              <div key={line.id} className="chart-indicator-row">
                <span className="chart-indicator-title" style={{color:line.enabled?line.color:'var(--muted)'}} onClick={()=>setIndicatorsOpen(true)}>
                  <span className="chart-indicator-bullet">●</span>
                  <span>EMA {line.period}</span>
                  {line.enabled&&val!==null&&val!==undefined&&<span className="chart-indicator-val">{val.toFixed(2)}</span>}
                </span>
                <span className="chart-indicator-actions">
                  <button type="button" className="chart-indicator-action-btn" title={line.enabled?'Hide EMA':'Show EMA'} onClick={()=>{
                    const next=emaLines.map(l=>l.id===line.id?{...l,enabled:!l.enabled}:l);
                    setEmaLines(next);emaChoice.current=next;engine.current?.setEmaLines(next);persist({emaLines:next});
                  }}>
                    {line.enabled?<Eye size={12}/>:<EyeOff size={12}/>}
                  </button>
                  <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={()=>setIndicatorsOpen(true)}>
                    <Settings size={12}/>
                  </button>
                  <button type="button" className="chart-indicator-action-btn delete" title="Remove" onClick={()=>{
                    const next=emaLines.filter(l=>l.id!==line.id);
                    setEmaLines(next);emaChoice.current=next;engine.current?.setEmaLines(next);persist({emaLines:next});
                  }}>
                    <Trash2 size={12}/>
                  </button>
                </span>
              </div>
            );
          })}

          {studies.supertrend && (()=>{
            const st=supertrend(candles,10,3);
            const val=st.values.at(-1);
            const isUp=st.directions.at(-1)===1;
            return (
              <div className="chart-indicator-row">
                <span className="chart-indicator-title" style={{color:isUp?'#089981':'#ef5350'}} onClick={()=>setIndicatorsOpen(true)}>
                  <span className="chart-indicator-bullet">●</span>
                  <span>Supertrend 10 3</span>
                  {val!==null&&val!==undefined&&<span className="chart-indicator-val">{val.toFixed(2)}</span>}
                </span>
                <span className="chart-indicator-actions">
                  <button type="button" className="chart-indicator-action-btn" title="Hide/Show" onClick={()=>applyStudies({...studies,supertrend:!studies.supertrend})}>
                    <Eye size={12}/>
                  </button>
                  <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={()=>setIndicatorsOpen(true)}>
                    <Settings size={12}/>
                  </button>
                  <button type="button" className="chart-indicator-action-btn delete" title="Remove" onClick={()=>applyStudies({...studies,supertrend:false})}>
                    <Trash2 size={12}/>
                  </button>
                </span>
              </div>
            );
          })()}

          {studies.rsi && (
            <div className="chart-indicator-row">
              <span className="chart-indicator-title" style={{color:'#8b5cf6'}} onClick={()=>setIndicatorsOpen(true)}>
                <span className="chart-indicator-bullet">●</span>
                <span>RSI 14</span>
              </span>
              <span className="chart-indicator-actions">
                <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={()=>setIndicatorsOpen(true)}>
                  <Settings size={12}/>
                </button>
                <button type="button" className="chart-indicator-action-btn delete" title="Remove" onClick={()=>applyStudies({...studies,rsi:false})}>
                  <Trash2 size={12}/>
                </button>
              </span>
            </div>
          )}

          {studies.macd && (
            <div className="chart-indicator-row">
              <span className="chart-indicator-title" style={{color:'var(--accent)'}} onClick={()=>setIndicatorsOpen(true)}>
                <span className="chart-indicator-bullet">●</span>
                <span>MACD 12 26 9</span>
              </span>
              <span className="chart-indicator-actions">
                <button type="button" className="chart-indicator-action-btn" title="Settings" onClick={()=>setIndicatorsOpen(true)}>
                  <Settings size={12}/>
                </button>
                <button type="button" className="chart-indicator-action-btn delete" title="Remove" onClick={()=>applyStudies({...studies,macd:false})}>
                  <Trash2 size={12}/>
                </button>
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="chart-actions-zone" role="group" aria-label="Chart controls">
        <div className="chart-actions">
          <button type="button" className="button button-icon" aria-label="Zoom in" title="Zoom in (+)" onClick={() => engine.current?.zoom(.8)}><Plus size={15}/></button>
          <button type="button" className="button button-icon" aria-label="Zoom out" title="Zoom out (-)" onClick={() => engine.current?.zoom(1.25)}><Minus size={15}/></button>
          <button type="button" className="button button-icon" aria-label="Reset chart view" title="Reset chart view (Home)" onClick={() => engine.current?.reset()}><RotateCcw size={14}/></button>
          <button type="button" className="button button-ghost chart-auto-btn" title="Restore automatic price scaling" onClick={() => engine.current?.resetPriceScale()}>Auto</button>
        </div>
      </div>
      {error ? <p role="alert" className="notice">{error}</p> : <div ref={attach} className="nexus-chart-canvas" role="group" tabIndex={0} onContextMenu={event=>{event.preventDefault();setContext({x:event.clientX,y:event.clientY});}} onKeyDownCapture={event=>{
        if ((event.key==='ContextMenu') || (event.key==='F10' && event.shiftKey)) {event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();setContext({x:rect.left+24,y:rect.top+24});}
        if (replay.index!==null && [' ','ArrowRight','ArrowLeft'].includes(event.key)) {event.preventDefault();event.stopPropagation(); if(event.key===' ') clock.toggle();else clock.step(event.key==='ArrowLeft'?-1:1);}
      }}
        aria-label={`${symbol} ${style==='candles'?'candlestick':style==='bars'?'HLC':style}${appearance.volume?' and volume':''} chart`} aria-describedby={`chart-keyboard-help-${tileId}`}
      />}
      {context && <ChartContextMenu {...context} onClose={()=>setContext(null)}>
        <button type="button" role="menuitem" onClick={()=>{engine.current?.reset();setContext(null);}}>Reset chart view</button>
        <button type="button" role="menuitem" onClick={()=>{engine.current?.resetPriceScale();setContext(null);}}>Restore automatic scale</button>
        <button type="button" role="menuitem" onClick={()=>{setSettingsOpen(true);setContext(null);}}>Chart settings</button>
        <button type="button" role="menuitem" onClick={()=>{selectBar();setContext(null);}}>Start bar replay</button>
        <button type="button" role="menuitem" onClick={()=>{const image=engine.current?.takeScreenshot();if(image){const link=document.createElement('a');link.download=`${symbol}-chart.png`;link.href=image.toDataURL('image/png');link.click();}setContext(null);}}>Save chart image</button>
      </ChartContextMenu>}
      </div>
    </div>
    <footer className="chart-statusbar">
      <div className="chart-ranges" role="group" aria-label="Visible date range">{ranges.map(([months,label])=><button type="button" key={label} aria-pressed={range===months} onClick={()=>{setRange(months);rangeChoice.current=months;engine.current?.setRange(months);persist({range:months});}}>{label}</button>)}</div>
      <select className="chart-range-select" aria-label="Visible date range" value={range===undefined?'custom':range===null?'all':range} onChange={event=>{const months=event.target.value==='all'?null:Number(event.target.value);setRange(months);rangeChoice.current=months;engine.current?.setRange(months);persist({range:months});}}><option value="custom" disabled>Range</option>{ranges.map(([months,label])=><option key={label} value={months??'all'}>{label}</option>)}</select>
      <button type="button" className="chart-latest" onClick={()=>engine.current?.latest()}>Latest</button>
      {comparison && <ChartComparison {...comparison} revision={revision} interval={interval} onData={onComparison}/>}
    </footer>
    {indicatorsOpen && <ChartDialog title="Indicators" onClose={()=>setIndicatorsOpen(false)}><div className="chart-settings-form">
      <label><span>Supertrend · 10, 3</span><input aria-label="Supertrend 10 3" type="checkbox" checked={studies.supertrend ?? false} onChange={event=>applyStudies({...studies,supertrend:event.target.checked})}/></label>
      <label><span>RSI · 14</span><input aria-label="RSI 14" type="checkbox" checked={studies.rsi} onChange={event=>applyStudies({...studies,rsi:event.target.checked})}/></label>
      <label><span>MACD · 12 / 26 / 9</span><input aria-label="MACD 12/26/9" type="checkbox" checked={studies.macd} onChange={event=>applyStudies({...studies,macd:event.target.checked})}/></label>
      {([['sma','SMA · 50'],['bollinger','Bollinger Bands · 20, 2σ'],['vwap','Monthly VWAP · daily bars'],['atr','ATR · 14'],['stochastic','Stochastic · 14 / 3']] as const).map(([key,label])=><label key={key}><span>{label}</span><input aria-label={label} type="checkbox" disabled={key==='vwap'&&interval!=='D'} checked={studies[key]&&(key!=='vwap'||interval==='D')} onChange={event=>applyStudies({...studies,[key]:event.target.checked})}/></label>)}
    </div><EmaSettings lines={emaLines} onApply={lines=>{
      setEmaLines(lines);emaChoice.current=lines;engine.current?.setEmaLines(lines);setIndicatorsOpen(false);
      persist({emaLines:lines});
      try {localStorage.setItem(EMA_PREFS_KEY,JSON.stringify(lines));} catch { /* Preference storage is optional. */ }
    }}/></ChartDialog>}
    {settingsOpen && <ChartSettingsDialog appearance={appearance} chartStyle={style} symbol={symbol} comparison={comparison} firstDate={firstDate} lastDate={currentBar.date} onClose={()=>setSettingsOpen(false)} onApply={(nextAppearance,nextStyle,nextComparison)=>{
      applyAppearance(nextAppearance);
      if(nextStyle!==style) {setStyle(nextStyle);styleChoice.current=nextStyle;engine.current?.setStyle(nextStyle);persist({style:nextStyle});}
      applyComparison(nextComparison);
    }} onGoToDate={date=>{const moved=engine.current?.goToDate(date)??false;if(moved) {setRange(undefined);rangeChoice.current=undefined;}return moved;}} onEvents={()=>setEventDetails(events.filter(event=>event.date<=revealedThrough(candles,replay.index,lastDate)))}/>}
    {eventDetails && <ChartDialog title="Published events" onClose={()=>setEventDetails(null)}><div className="chart-event-list">{eventDetails.length?eventDetails.map(event=><article key={event.id}><small>{event.date} · {event.kind==='action'?'Corporate action':event.kind==='earnings'?'Earnings filing':'News'}</small><p>{event.title}</p></article>):<p>No published events in this history.</p>}</div></ChartDialog>}
    <p id={`chart-keyboard-help-${tileId}`} className="sr-only">Two clicks or drag to draw. Select to move; drag handles to reshape. Delete removes. Ctrl or Command Z undoes. Escape cancels. Scroll or pinch zooms. Drag the right price scale to stretch or compress prices; double-click it to restore automatic scaling. Drag pane separators to resize. Alt Enter maximizes or restores the chart. While selecting a replay bar, use Left and Right then Enter, or click a bar. During replay, Space plays or pauses and Left or Right steps one bar.</p>
  </>;
}

export default function ChartsTab({datasetRevision}:{datasetRevision?:string}) {
  const [grid,setGrid]=useState(()=>loadGrid());
  const gridChoice=useRef(grid);
  const [sync]=useState(()=>Object.assign(new ChartSync(),{enabled:true,dates:grid.links.dates,crosshairs:grid.links.crosshair}));
  const [layouts,setLayouts]=useState(loadNamedLayouts);
  const [layoutsOpen,setLayoutsOpen]=useState(false);
  const [layoutName,setLayoutName]=useState('');
  const [layoutError,setLayoutError]=useState('');
  const [generation,setGeneration]=useState(0);
  const warning=useSyncExternalStore(chartStorage.subscribe,chartStorage.getSnapshot,chartStorage.getSnapshot);
  const updateGrid=useCallback((change:Partial<GridSettings>)=>{
    const next={...gridChoice.current,...change};gridChoice.current=next;sync.dates=next.links.dates;sync.crosshairs=next.links.crosshair;setGrid(next);writeChartStorage('grid.v1',next);
  },[sync]);
  const updateTile=useCallback((id:string,tile:TileSettings)=>{
    const {links}=gridChoice.current;
    updateGrid({tiles:gridChoice.current.tiles.map((current,index)=>String(index)===id?tile:{symbol:links.symbol?tile.symbol:current.symbol,interval:links.interval?tile.interval:current.interval})});
  },[updateGrid]);
  return <div className="chart-desk">
    <div className="chart-desk-toolbar" role="group" aria-label="Chart layout">
      <button type="button" onClick={()=>setLayoutsOpen(true)}>Layouts</button>
      <ChartLayoutPicker value={grid.layout} links={grid.links} onLayout={layout=>updateGrid({layout,count:chartLayout(layout).count})} onLinks={links=>updateGrid({links})}/>
    </div>
    {warning&&<p role="status" className="notice">{warning}</p>}
    <div className={`chart-grid chart-grid-${grid.count}`} style={{gridTemplateColumns:`repeat(${chartLayout(grid.layout).columns},minmax(${chartLayout(grid.layout).minColumnWidth}px,1fr))`,gridTemplateRows:`repeat(${chartLayout(grid.layout).rows.length},minmax(260px,1fr))`,gridTemplateAreas:layoutAreas(chartLayout(grid.layout).rows)}}>
      {grid.tiles.slice(0,grid.count).map((tile,index)=><ChartTile key={`${generation}:${index}:${tile.symbol}:${tile.interval}`} datasetRevision={datasetRevision} tileId={String(index)} initial={tile} onChange={updateTile} sync={sync} area={String.fromCharCode(97+index)}/>)}
    </div>
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

function ChartTile({datasetRevision,tileId,initial,onChange,sync,area}: {datasetRevision?:string;tileId:string;initial:TileSettings;onChange:(tileId:string,settings:TileSettings)=>void;sync:ChartSync;area:string}) {
  const [draft, setDraft] = useState(initial.symbol);
  const {symbol,interval}=initial;
  const [inputError, setInputError] = useState('');
  const [expanded,setExpanded] = useState(false);
  const book=savedDrawingBook(symbol);
  const changeInterval=(next:Interval)=>onChange(tileId,{symbol,interval:next});
  const metadata=useQuery({
    queryKey:['chart-metrics',datasetRevision,symbol],
    queryFn:async()=>{
      const result=await screenerApi.runScreen({datasetRevision,universe:'custom',customSymbols:[symbol],asOfDate:'',page:1,pageSize:1,expressionTree:{type:'group',operator:'all',children:[]}});
      if (result.immutableRevision!==datasetRevision) throw new Error('Chart metrics revision mismatch');
      return result.rows.find(row=>row.symbol===symbol)??null;
    },
    enabled:Boolean(datasetRevision),retry:false,staleTime:Infinity,
  });
  const chart = useQuery({
    queryKey: ['chart', datasetRevision, symbol],
    queryFn: async () => {
      const snapshot = await screenerApi.getChart(symbol, datasetRevision);
      return {...snapshot, candles: validateCandles(snapshot.candles)};
    },
    enabled: Boolean(datasetRevision),
    retry: false,
    staleTime: Infinity,
  });
  const candles = useMemo(() => aggregate(chart.data?.candles ?? [], interval), [chart.data, interval]);
  const events=useMemo(()=>chart.data?chartEvents(chart.data):[],[chart.data]);
  const symbolControls=<><form className="chart-symbol-search" onSubmit={event => {
        event.preventDefault();
        const next = draft.trim().toUpperCase();
        if (!/^[A-Z0-9_&.\-]{1,40}$/.test(next)) { setInputError('Enter a scanner symbol, such as RELIANCE.'); return; }
        setInputError(''); setDraft(next);onChange(tileId,{symbol:next,interval});
      }}>
        <SymbolWithLogo symbol={symbol} showText={false} className="chart-symbol-logo"/>
        <input aria-label="Chart symbol" placeholder="Symbol..." value={draft} onChange={event => setDraft(event.target.value)} autoComplete="off" spellCheck={false}/>
        <button type="submit" className="chart-load-btn" aria-label="Load" title="Load symbol"><ArrowRight size={13}/></button>
      </form>
      <div className="chart-bar-divider" aria-hidden="true" />
      <div className="chart-intervals" role="group" aria-label="Candle interval">
        {(['D', 'W', 'M'] as const).map(value => <button type="button" key={value} aria-pressed={interval === value}
          aria-label={value === 'D' ? 'Daily candles' : value === 'W' ? 'Weekly candles' : 'Monthly candles'} onClick={() => changeInterval(value)}>{value==='D'?'1D':value==='W'?'1W':'1M'}</button>)}
      </div>
      <select className="chart-interval-select" aria-label="Candle interval" value={interval} onChange={event=>changeInterval(event.target.value as Interval)}><option value="D">1D</option><option value="W">1W</option><option value="M">1M</option></select></>;
  const viewControls=<><button type="button" className="button button-icon chart-expand" aria-label={expanded?'Restore chart':'Maximize chart'}
        aria-pressed={expanded} title={`${expanded?'Restore':'Maximize'} chart (Alt/⌥ Enter)`} onClick={()=>setExpanded(value=>!value)}>
        {expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}
      </button></>;
  return <section style={{gridArea:area}} className={`chart-workspace${expanded?' chart-workspace-expanded':''}`} aria-label={expanded?'Nexus charts':`Chart ${Number(tileId)+1} · ${symbol}`}
    role={expanded?'dialog':undefined} aria-modal={expanded?true:undefined} onKeyDown={event=>{
      if (event.altKey && event.key==='Enter') { event.preventDefault(); setExpanded(value=>!value); }
      if (expanded && event.key==='Escape') { event.preventDefault(); setExpanded(false); }
      if (expanded && event.key==='Tab') {
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary, [tabindex="0"], a[href]')).filter(element=>element.getClientRects().length>0);
        const first=controls[0],last=controls.at(-1);
        if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    {(chart.isError || chart.isPending || !candles.length) && <header className="chart-topbar">{symbolControls}<span className="chart-topbar-spacer"/>{viewControls}</header>}
    {inputError && <p role="alert" className="notice">{inputError}</p>}
    {chart.isError ? <div role="alert" className="chart-status"><p>{chart.error.message}</p><button type="button" className="button button-ghost" onClick={() => void chart.refetch()}>Retry</button></div>
      : chart.isPending ? <p className="chart-status" role="status">Loading chart history…</p>
      : !candles.length ? <p className="chart-status" role="status">No published candles for {symbol}.</p>
      : <ChartScene key={`${datasetRevision}:${symbol}:${interval}`} candles={candles} symbol={symbol} book={book} symbolControls={symbolControls} viewControls={viewControls}
          firstDate={chart.data.candles[0].date} lastDate={chart.data.candles.at(-1)!.date} metrics={metadata.data??undefined} sessionDate={chart.data.asOfDate} events={events} revision={datasetRevision!} interval={interval} tileId={tileId} sync={sync}/>}
  </section>;
}
