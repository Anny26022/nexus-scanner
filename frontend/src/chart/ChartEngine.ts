import {
  AreaSeries, BaselineSeries, BarSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries,
  LineStyle, LineType, PriceScaleMode, createChart, createSeriesMarkers, createTextWatermark,
  type IChartApi, type IPrimitivePaneView, type ISeriesApi, type ISeriesPrimitive, type ITextWatermarkPluginApi,
  type IPriceLine, type ISeriesMarkersPluginApi, type SeriesMarker, type LineWidth, type Logical, type MouseEventParams, type SeriesAttachedParameter, type Time,
} from 'lightweight-charts';
import { validEmaLine, type Candle, type EmaLine } from './model';
import { DrawingBook, hitDrawing, indexTime, timeIndex, type DrawingProjection, type Pixel } from './drawings';
import { DrawingLayer } from './DrawingLayer';
import { defaultStudies, type ChartStudies } from './studies';
import { enabledExtraStudies, studyLineColor, studyParams, studyTitle } from './extraStudies';
import { studyKey, type StudyLines } from './studyCompute';
import { StudyStore } from './studyStore';
export type { ChartStudies } from './studies';
import { type StudyConfigs } from './studyConfigs';
export type { StudyConfigs } from './studyConfigs';
import { EVENT_BADGES, eventBadgeKey, type ChartEvent, type EventBadgeStyles } from './events';
import { currentTheme, forTheme } from './themeColors';
import { drawMarkerShape, markerStyle, type MarkerShape, type MarkerStyle } from './markerShapes';
import { computeSimpleVolume, type SimpleVolumeResult } from './simpleVolume';
import { SIMPLE_VOLUME_COLORS } from './studyConfigs';
import { themeElement } from '../embedding';

// Match the reference screener's native candle and bar palette.
export const CHART_PALETTE = {up:'#089981',down:'#ef5350',volumeUp:'rgba(8,153,129,0.5)',volumeDown:'rgba(239,83,80,0.5)'};
type StudyPlot={
  /** Identity: result key, line, pane and shape; a plot with the same key reuses its series. */
  key:string;
  title:string;color:string;values:(number|null)[];pane:string;
  histogram?:boolean;lineWidth?:number;lineStyle?:LineStyle;
  levels?:Array<{price:number;color?:string;lineStyle?:LineStyle}>;
  id?:string;dots?:boolean;
};
export type ChartStyle = 'candles'|'hollowCandles'|'volumeCandles'|'bars'|'highLow'|'line'|'lineWithMarkers'|'stepLine'|'area'|'hlcArea'|'baseline';
export type ScaleMode = 'normal'|'logarithmic'|'percentage'|'indexed';
export type ChartAppearance = {
  /** Price-pane legend shows only a summary chip. */
  legendCollapsed?:boolean;
  horizontalGrid:boolean;
  verticalGrid:boolean;
  crosshair:boolean;
  volume:boolean;
  scaleMode:ScaleMode;
  crosshairMode?:'normal'|'magnet'|'ohlc';
  volumePane?:boolean;
  events?:boolean;
  conflation?:boolean;
  // OpenAlgo Chart Settings:
  upColor?:string;
  downColor?:string;
  borderUpColor?:string;
  borderDownColor?:string;
  wickUpColor?:string;
  wickDownColor?:string;
  bodyVisible?:boolean;
  borderVisible?:boolean;
  wickVisible?:boolean;
  priceLineVisible?:boolean;
  highLowPriceLines?:boolean;
  colorByPreviousClose?:boolean;
  precision?:string;
  vertGridColor?:string;
  horzGridColor?:string;
  vertGridStyle?:'solid'|'dashed'|'dotted';
  horzGridStyle?:'solid'|'dashed'|'dotted';
  crosshairColor?:string;
  crosshairStyle?:'solid'|'dashed'|'dotted';
  crosshairTransparency?:number;
  watermarkVisible?:boolean;
  watermarkText?:string;
  watermarkColor?:string;
  watermarkOpacity?:number;
  topMargin?:number;
  bottomMargin?:number;
  statusMarketStatus?:boolean;
  statusOhlc?:boolean;
  statusBarChange?:boolean;
  statusVolume?:boolean;
  statusIndicators?:boolean;
  statusBackground?:boolean;
  statusBackgroundColor?:string;
  statusBackgroundOpacity?:number;
  timezone?:string;
  invertScale?:boolean;
  sessionClock?:boolean;
  barCountdown?:boolean;
  panEnabled?:boolean;
  zoomEnabled?:boolean;
  mousePan?:'both'|'horizontal';
  defaultVisibleBars?:number;
  /** Line, step, marker and area styles. */
  lineColor?:string;
  lineWidth?:number;
  /** Canvas and scale text. */
  backgroundColor?:string;
  /** Colours picked per theme (see themeColors.ts); the top-level colour fields are the resolved view. */
  themeColors?:Partial<Record<'light'|'dark',import('./themeColors').ThemeColors>>;
  scaleTextColor?:string;
  scaleFontSize?:number;
  /** Last-value label on the price scale. */
  lastValueLabel?:boolean;
  /** Colour and visibility of each event letter in the bottom strip. */
  eventStyles?:EventBadgeStyles;
  /** Dotted line and axis label at the previous bar's close (opt-in, like the other price guides). */
  prevCloseLine?:boolean;
};
const WEEKDAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** Crosshair time label as TradingView writes it: "Fri 09 Aug '24". */
export function crosshairDate(date:string) {
  const parsed=new Date(`${date}T00:00:00Z`);
  if(Number.isNaN(parsed.getTime())) return date;
  return `${WEEKDAYS[parsed.getUTCDay()]} ${String(parsed.getUTCDate()).padStart(2,'0')} ${MONTHS[parsed.getUTCMonth()]} '${String(parsed.getUTCFullYear()).slice(2)}`;
}
/** Drawings copied with Ctrl/⌘+C, shared by every chart on the page. */
let drawingClipboard:import('./drawings').Drawing|null=null;
const scaleModes = {normal:PriceScaleMode.Normal,logarithmic:PriceScaleMode.Logarithmic,percentage:PriceScaleMode.Percentage,indexed:PriceScaleMode.IndexedTo100};
const withAlpha = (hex:string,opacity:number) => {
  const alpha=hex.length===9?parseInt(hex.slice(7),16)/255:1;
  return `${hex.slice(0,7)}${Math.round(alpha*opacity*255).toString(16).padStart(2,'0')}`;
};
const RIGHT_EDGE_BARS = 6;
const RIGHT_EDGE_PIXELS = 32;
const SCROLL_WITHOUT_WHEEL = {mouseWheel:false,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:true} as const;
// The wheel is handled by ChartEngine.wheel (TradingView-style); pinch and axis drags stay native.
const SCALE_WITH_WHEEL = {mouseWheel:false,pinch:true,axisPressedMouseMove:true,axisDoubleClickReset:true} as const;
/** Wheel zoom per pixel of vertical delta; ~10% per notch, like TradingView. */
const WHEEL_ZOOM_RATE = .0011;

/** Native TradingView rendering and navigation; Nexus owns data, tools and replay. */
export class ChartEngine {
  readonly chart:IChartApi;
  private price:ISeriesApi<'Candlestick'|'Bar'|'Line'|'Area'|'Baseline'>;
  private currentAppearance?:ChartAppearance;
  private watermarkPlugin?:ITextWatermarkPluginApi<Time>;
  private volumeSeries:ISeriesApi<'Histogram'>;
  /** Invisible line that only puts the volume average's value on the volume scale, as TradingView does. */
  private volumeAverage:ISeriesApi<'Line'>|null=null;
  private volumeVisible=true;
  private averages = new Map<string,{series:ISeriesApi<'Line'>;line:EmaLine}>();
  private layer:DrawingLayer;
  private primitive:ISeriesPrimitive;
  private invalidate = () => {};
  private events = new AbortController();
  private theme:MutationObserver;
  private unsubscribe:()=>void;
  private times:number[];
  private byDate:Map<string,Candle>;
  private style:ChartStyle='candles';
  private replayPicker:{pick:(index:number)=>void;cancel:()=>void}|null=null;
  private replayIndex=0;
  private drawingPointer:number|null=null;
  private blockMouse=false;
  private accent='#187669';
  private disposed=false;
  private priceLines=new Map<string,IPriceLine>();
  private markers:ISeriesMarkersPluginApi<Time>;
  private volumeMarkers?:ISeriesMarkersPluginApi<Time>;
  private simpleVolume:SimpleVolumeResult|null=null;
  private volumeNoise='#7c7c87';
  private eventData:readonly ChartEvent[]=[];
  private eventCutoff='';
  private showEvents=false;
  private markerEvents=new Map<string,ChartEvent[]>();
  private studies:ChartStudies=defaultStudies();
  private studyConfigs:StudyConfigs={};
  private studySeries:ISeriesApi<'Line'|'Histogram'>[]=[];
  /** Drawn indicator lines by identity, so setStudies keeps the ones that did not change. */
  private studyEntries=new Map<string,{series:ISeriesApi<'Line'|'Histogram'>;values:(number|null)[];candles:readonly Candle[]}>();
  private studyPlotList:StudyPlot[]=[];
  // Indicator results. Without a shared store the engine computes its own on this thread.
  private studyStore=new StudyStore(false);
  private ownStudyStore=true;
  private missingStudies=new Set<string>();
  private studySeriesByPane=new Map<string,ISeriesApi<'Line'|'Histogram'>[]>();
  // Price overlays share the 'price' pane key, so visibility is also tracked per study.
  private studySeriesById=new Map<string,ISeriesApi<'Line'|'Histogram'>[]>();
  private benchmark:ReadonlyMap<string,number>|undefined;
  private onPanesChange?:()=>void;
  private maximizedPane:number|null=null;
  private hostObserver?:ResizeObserver;
  private paneObserver?:ResizeObserver;
  private comparison:ISeriesApi<'Line'>|null=null;
  private comparisonData:readonly Candle[]=[];
  private comparisonSeparate=false;
  private scaleMode:ScaleMode='normal';
  private drawingBars:DrawingProjection['bars']=[];

  constructor(private host:HTMLDivElement,private candles:readonly Candle[],private inspect:(bar:Candle)=>void,private book=new DrawingBook(),private inspectEvents:(events:readonly ChartEvent[])=>void=()=>{}) {
    this.times=candles.map(bar=>Date.parse(bar.date));
    this.drawingBars=candles.map((bar,index)=>({...bar,time:this.times[index]}));
    this.byDate=new Map(candles.map(bar=>[bar.date,bar]));
    this.chart=createChart(host,{
      autoSize:true,
      layout:{fontFamily:'-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',fontSize:12,attributionLogo:false,panes:{enableResize:true}},
      // Grid lines start hidden; the Canvas settings turn them on.
      grid:{vertLines:{visible:false},horzLines:{visible:false}},
      rightPriceScale:{borderVisible:false,scaleMargins:{top:.13,bottom:.22}},
      timeScale:{borderVisible:false,rightOffset:RIGHT_EDGE_BARS,rightOffsetPixels:RIGHT_EDGE_PIXELS,barSpacing:8,fixLeftEdge:false,lockVisibleTimeRangeOnResize:true,shiftVisibleRangeOnNewBar:true},
      crosshair:{mode:CrosshairMode.Normal},
      localization:{locale:'en-IN',timeFormatter:(time:Time)=>crosshairDate(this.dateString(time))},
      // TradingView stops a mouse drag where you release it; touch keeps its momentum.
      kineticScroll:{mouse:false,touch:true},
      handleScroll:SCROLL_WITHOUT_WHEEL,
      handleScale:SCALE_WITH_WHEEL,
    });
    this.price=this.createPriceSeries();
    this.volumeSeries=this.chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume',lastValueVisible:false,priceLineVisible:false});
    this.volumeSeries.priceScale().applyOptions({scaleMargins:{top:.8,bottom:0},visible:false});
    this.layer=new DrawingLayer(book,()=>this.projection(),()=>this.invalidate());
    const paneViews:readonly IPrimitivePaneView[]=[{zOrder:()=> 'top',renderer:()=>({draw:target=>{
      target.useMediaCoordinateSpace(({context})=>{
        const projection=this.projection();
        if (!projection) return;
        this.layer.draw(context,projection,this.accent);
        this.drawUpcomingEarnings(context,projection.bottom);
        this.drawBandChanges(context);
        this.drawSnorts(context);
        this.drawSizingLines(context);
        this.drawHoverPoint(context);
        this.drawMeasure(context);
        if (this.replayPicker) {
          const x=this.chart.timeScale().logicalToCoordinate(this.replayIndex as Logical);
          if(x===null) return;
          context.save();context.strokeStyle=this.accent;context.lineWidth=1;context.setLineDash([4,3]);
          context.beginPath();context.moveTo(x,0);context.lineTo(x,projection.bottom);context.stroke();context.restore();
        }
      });
    }})}];
    this.primitive={attached:({requestUpdate}:SeriesAttachedParameter)=>{this.invalidate=()=>{this.syncPriceLines();requestUpdate();};},paneViews:()=>paneViews,
      hitTest:(x,y)=>{const p=this.projection(),state=this.book.getSnapshot();const hit=p&&!state.hideAll?hitDrawing(state.drawings,{x,y},p,state.selectedId):null;return hit?{externalId:hit.drawing.id,zOrder:'top',cursorStyle:hit.handle!==null?'crosshair':'move'}:null;},
      priceAxisViews:()=>this.axisViews('price'),timeAxisViews:()=>this.axisViews('time'),
    };
    this.price.attachPrimitive(this.primitive);
    this.markers=createSeriesMarkers(this.price,[],{autoScale:false});
    this.setData();
    this.chart.subscribeCrosshairMove(this.crosshair);
    this.chart.subscribeClick(this.click);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onVisibleRange);
    this.theme=new MutationObserver(()=>this.readTheme());
    this.theme.observe(themeElement(),{attributes:true,attributeFilter:['data-theme']});
    this.readTheme();
    this.unsubscribe=this.watchBook();
    const options={signal:this.events.signal,capture:true};
    host.addEventListener('wheel',this.wheel,{signal:this.events.signal,passive:false});
    host.addEventListener('pointerdown',this.down,options);
    host.addEventListener('pointermove',this.move,options);
    host.addEventListener('pointerup',this.up,options);
    host.addEventListener('pointercancel',this.cancelPointer,options);
    host.addEventListener('lostpointercapture',this.cancelPointer,options);
    // Lightweight Charts uses mouse/touch events; suppress only gestures owned by the drawing layer.
    host.addEventListener('mousedown',event=>{if(this.blockMouse){event.preventDefault();event.stopPropagation();}},options);
    host.addEventListener('touchstart',event=>{if(this.blockMouse){event.preventDefault();event.stopPropagation();}},{...options,passive:false});
    this.setKeyTarget(host);
    host.addEventListener('dblclick',event=>{if(this.layer.finish()) {event.preventDefault();event.stopPropagation();}},options);
    this.hostObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{this.notifyPanesChange();}):undefined;
    this.hostObserver?.observe(host);
    this.reset();
  }

  private activeSeries():ISeriesApi<'Candlestick'|'Bar'|'Line'|'Area'|'Baseline'> {
    return this.price;
  }
  /** Colours and lines for the current style, from the appearance; shared by creation and live updates. */
  private priceOptions() {
    const a=this.currentAppearance;
    const up=a?.upColor??CHART_PALETTE.up;
    const down=a?.downColor??CHART_PALETTE.down;
    const line=a?.lineColor??this.accent;
    const lineWidth=Math.max(1,Math.min(4,Math.round(a?.lineWidth??2))) as LineWidth;
    const digits=a?.precision&&a.precision!=='default'?Math.max(0,Math.min(4,Number(a.precision))):null;
    const common={priceLineVisible:a?.priceLineVisible===true,lastValueVisible:a?.lastValueLabel!==false,
      priceFormat:digits===null?{type:'price' as const,precision:2,minMove:.01}:{type:'price' as const,precision:digits,minMove:1/10**digits}};
    switch(this.style) {
      case 'candles':
      case 'volumeCandles':return {...common,
        upColor:a?.bodyVisible===false?'transparent':up,
        downColor:a?.bodyVisible===false?'transparent':down,
        borderVisible:a?.borderVisible!==false,
        borderUpColor:a?.borderUpColor??up,
        borderDownColor:a?.borderDownColor??down,
        wickVisible:a?.wickVisible!==false,
        wickUpColor:a?.wickUpColor??up,
        wickDownColor:a?.wickDownColor??down,
      };
      case 'hollowCandles':return {...common,
        upColor:'transparent',
        downColor:a?.bodyVisible===false?'transparent':down,
        borderVisible:true,
        borderUpColor:a?.borderUpColor??up,
        borderDownColor:a?.borderDownColor??down,
        wickVisible:a?.wickVisible!==false,
        wickUpColor:a?.wickUpColor??up,
        wickDownColor:a?.wickDownColor??down,
      };
      case 'bars':
      case 'highLow':return {...common,upColor:up,downColor:down};
      case 'line':
      case 'lineWithMarkers':
      case 'stepLine':return {...common,color:line,lineWidth};
      case 'area':return {...common,lineColor:line,topColor:withAlpha(line.slice(0,7),.2),bottomColor:withAlpha(line.slice(0,7),0),lineWidth};
      case 'hlcArea':return {...common,lineColor:line,topColor:withAlpha(line.slice(0,7),.35),bottomColor:withAlpha(line.slice(0,7),.05),lineWidth};
      case 'baseline':return {...common,topLineColor:up,bottomLineColor:down,topFillColor1:withAlpha(up.slice(0,7),.28),topFillColor2:withAlpha(up.slice(0,7),.05),bottomFillColor1:withAlpha(down.slice(0,7),.05),bottomFillColor2:withAlpha(down.slice(0,7),.28),lineWidth};
    }
  }
  private createPriceSeries() {
    const options=this.priceOptions();
    switch(this.style) {
      case 'candles':
      case 'volumeCandles':
      case 'hollowCandles':return this.chart.addSeries(CandlestickSeries,options);
      case 'bars':return this.chart.addSeries(BarSeries,{...options,thinBars:false,openVisible:false});
      case 'highLow':return this.chart.addSeries(BarSeries,{...options,thinBars:true,openVisible:false});
      case 'line':return this.chart.addSeries(LineSeries,{...options,lineType:LineType.Simple});
      case 'lineWithMarkers':return this.chart.addSeries(LineSeries,{...options,lineType:LineType.Simple,crosshairMarkerVisible:true,pointMarkersVisible:true});
      case 'stepLine':return this.chart.addSeries(LineSeries,{...options,lineType:LineType.WithSteps});
      case 'area':
      case 'hlcArea':return this.chart.addSeries(AreaSeries,options);
      case 'baseline':return this.chart.addSeries(BaselineSeries,{...options,baseValue:{type:'price',price:this.candles[0]?.close??0}});
    }
  }
  private syncPriceLines() {
    const drawings=this.layer.drawings().filter(d=>d.kind==='horizontal'),series=this.activeSeries();
    for(const [id,line] of this.priceLines) if(!drawings.some(d=>d.id===id)) {series.removePriceLine(line);this.priceLines.delete(id);}
    for(const d of drawings) {
      const options={price:d.a.price,color:d.color==='accent'?this.accent:d.color,lineWidth:Math.round(d.width) as LineWidth,lineStyle:d.dash==='dashed'?LineStyle.Dashed:d.dash==='dotted'?LineStyle.Dotted:LineStyle.Solid,axisLabelVisible:true};
      const line=this.priceLines.get(d.id);
      if(line) line.applyOptions(options);else this.priceLines.set(d.id,series.createPriceLine(options));
    }
  }
  private axisViews(axis:'price'|'time') {
    const selected=this.layer.drawings().find(d=>d.id===this.book.getSnapshot().selectedId),p=this.projection();
    if(!selected||!p||(axis==='price'&&selected.kind==='horizontal')) return [];
    const anchor=selected.a,point=p.toPixel(anchor);
    return [{coordinate:()=>axis==='price'?point.y:point.x,text:()=>axis==='price'?anchor.price.toLocaleString('en-IN',{maximumFractionDigits:2}):new Date(anchor.time).toISOString().slice(0,10),textColor:()=> '#ffffff',backColor:()=>this.accent,visible:()=>true,tickVisible:()=>true}];
  }
  private readTheme() {
    const style=getComputedStyle(this.host);
    const token=(name:string,fallback:string)=>style.getPropertyValue(`--${name}`).trim()||fallback;
    this.accent=token('accent','#187669');
    const noise=token('volume-noise','#7c7c87');
    if(noise!==this.volumeNoise) {
      this.volumeNoise=noise;
      if(this.simpleVolume&&this.candles.length) this.volumeSeries.setData(this.candles.map((bar,index)=>this.volumeData(bar,index)));
    }
    this.chart.applyOptions({
      layout:{background:{type:ColorType.Solid,color:token('chart-background',token('surface','#ffffff'))},textColor:token('muted','#787b86'),panes:{separatorColor:token('line','#e8e8ed'),separatorHoverColor:token('line-strong','#d2d2d7')}},
      grid:{vertLines:{color:token('chart-grid','#f0f0f0')},horzLines:{color:token('chart-grid','#f0f0f0')}},
      crosshair:{vertLine:{color:token('chart-crosshair','#aab8c5'),labelBackgroundColor:token('text','#131722')},horzLine:{color:token('chart-crosshair','#aab8c5'),labelBackgroundColor:token('text','#131722')}},
    });
    // Theme tokens are defaults; the user's own colours for this theme win.
    if(this.savedAppearance) this.setAppearance(this.savedAppearance);
    else this.price.applyOptions(this.priceOptions());
    this.invalidate();
  }
  private simpleMode() { return (this.studyConfigs.volume?.mode??'simple')==='simple'; }
  /** Recomputes Simple Volume colours, labels and snorts for the current candles. */
  private computeVolume(appended=false) {
    const cfg=this.studyConfigs.volume;
    this.simpleVolume=this.simpleMode()?computeSimpleVolume(this.candles,{ppvLength:cfg?.ppvLength??10,maLength:cfg?.maLength??50,dryFraction:cfg?.dryFraction??.2}):null;
    this.syncVolumeAverage(appended);
    this.refreshVolumeMarkers();
    this.refreshMarkers();
  }
  /** Simple Volume's colour for a bar, or null for classic colouring. */
  /** Sky blue for highest-volume records (HVE/HVY/HVQ), or null when the bar isn't one. */
  private recordVolumeColor(index:number) {
    const cfg=this.studyConfigs.volume,result=this.simpleVolume;
    if(!result||cfg?.showLabels===false) return null;
    const record=result.labels.some(label=>label.index===index&&label.text.startsWith('HV'));
    if(!record) return null;
    const up=index>0&&this.candles[index].close>this.candles[index-1].close;
    return up||cfg?.recordUpOnly!==true?cfg?.recordColor??SIMPLE_VOLUME_COLORS.record:null;
  }
  private simpleVolumeColor(index:number) {
    const kind=this.simpleVolume?.kinds[index];
    if(!kind) return null;
    const cfg=this.studyConfigs.volume;
    const record=this.recordVolumeColor(index);
    if(record) return record;
    if(kind==='ppv') return cfg?.ppvColor??SIMPLE_VOLUME_COLORS.ppv;
    if(kind==='up') return cfg?.aboveUpColor??SIMPLE_VOLUME_COLORS.up;
    if(kind==='down') return cfg?.aboveDownColor??SIMPLE_VOLUME_COLORS.down;
    if(kind==='dry'&&cfg?.showDry!==false) return cfg?.dryColor??SIMPLE_VOLUME_COLORS.dry;
    return cfg?.noiseColor??this.volumeNoise;
  }
  private syncVolumeAverage(appended=false) {
    if(!this.volumeSeries) return;
    const pane=this.volumeSeries.getPane().paneIndex();
    const show=pane!==0&&this.volumeVisible&&this.currentAppearance?.volume!==false&&Boolean(this.simpleVolume);
    if(!show) {
      if(this.volumeAverage) {this.chart.removeSeries(this.volumeAverage);this.volumeAverage=null;}
      return;
    }
    if(this.volumeAverage&&this.volumeAverage.getPane().paneIndex()!==pane) {this.chart.removeSeries(this.volumeAverage);this.volumeAverage=null;}
    const existing=Boolean(this.volumeAverage);
    this.volumeAverage??=this.chart.addSeries(LineSeries,{color:'#8e2a35',lineVisible:false,pointMarkersVisible:false,crosshairMarkerVisible:false,
      priceLineVisible:false,lastValueVisible:true,priceFormat:{type:'volume'},title:''},pane);
    const average=this.simpleVolume!.average;
    if(appended&&existing) {
      const index=this.candles.length-1,bar=this.candles[index],value=average[index];
      this.volumeAverage.update(value==null?{time:bar.date}:{time:bar.date,value});
      return;
    }
    this.volumeAverage.setData(this.candles.map((bar,index)=>average[index]===null||average[index]===undefined?{time:bar.date}:{time:bar.date,value:average[index]!}));
  }
  private refreshVolumeMarkers() {
    const result=this.simpleVolume,cfg=this.studyConfigs.volume;
    if(!this.volumeMarkers) this.volumeMarkers=createSeriesMarkers(this.volumeSeries,[],{autoScale:true});
    const markers:SeriesMarker<Time>[]=[];
    if(result&&cfg?.showLabels!==false) for(const label of result.labels) {
      const bar=this.candles[label.index];
      const low=label.text.startsWith('L');
      markers.push({id:`vol:${label.text}`,time:bar.date,position:'aboveBar',shape:'circle',size:0,text:low?label.text.slice(2):label.text,
        color:low?cfg?.dryColor??SIMPLE_VOLUME_COLORS.dry:cfg?.recordColor??SIMPLE_VOLUME_COLORS.record});
    }
    this.volumeMarkers.setMarkers(markers);
  }
  private volumeData(bar:Candle,index=this.candles.indexOf(bar)) {
    if(bar.volume===null) return {time:bar.date};
    const simple=this.simpleVolumeColor(index);
    if(simple) return {time:bar.date,value:bar.volume,color:simple};
    const color=bar.close>=bar.open
      ? (this.studyConfigs.volume?.upColor ? withAlpha(this.studyConfigs.volume.upColor,.5) : CHART_PALETTE.volumeUp)
      : (this.studyConfigs.volume?.downColor ? withAlpha(this.studyConfigs.volume.downColor,.5) : CHART_PALETTE.volumeDown);
    return {time:bar.date,value:bar.volume,color};
  }
  private setData() {
    this.setPriceData();
    this.computeVolume();
    this.volumeSeries.setData(this.candles.map((bar,index)=>this.volumeData(bar,index)));
    for(const {series,line} of this.averages.values()) this.setEmaData(series,line);
  }
  private isBarType():boolean {
    return ['candles','hollowCandles','volumeCandles','bars','highLow'].includes(this.style);
  }
  private priceData(bar:Candle,index=this.candles.indexOf(bar)) {
    if(!this.isBarType()) return {time:bar.date,value:this.style==='hlcArea'?(bar.high+bar.low+bar.close)/3:bar.close};
    const ohlc={time:bar.date,open:bar.open,high:bar.high,low:bar.low,close:bar.close};
    const a=this.currentAppearance;
    const previous=index>0?this.candles[index-1]:undefined;
    if(!a?.colorByPreviousClose||!previous) return ohlc;
    // Direction is today's close against yesterday's close, not against today's open.
    const up=bar.close>=previous.close;
    const body=up?a.upColor??CHART_PALETTE.up:a.downColor??CHART_PALETTE.down;
    if(this.style==='bars'||this.style==='highLow') return {...ohlc,color:body};
    const border=up?a.borderUpColor??body:a.borderDownColor??body;
    const wick=up?a.wickUpColor??body:a.wickDownColor??body;
    const hollow=this.style==='hollowCandles'&&bar.close>bar.open;
    return {...ohlc,color:a.bodyVisible===false||hollow?'transparent':body,borderColor:border,wickColor:wick};
  }
  private setPriceData() {this.price.setData(this.candles.map((bar,index)=>this.priceData(bar,index)));this.updateHighLowLines();this.updatePrevCloseLine();}
  private highLowLines:{series:ISeriesApi<'Candlestick'|'Bar'|'Line'|'Area'|'Baseline'>;lines:IPriceLine[]}|null=null;
  private highLowFrame=0;
  private upcomingEarnings:{date:string;line:boolean}|null=null;
  private eventPane:ReturnType<IChartApi['panes']>[number]|null=null;
  private eventStrip:{index:number;key:string;badges:{letter:string;color:string}[]}[]=[];
  private eventStripPrimitive={
    paneViews:()=>[{zOrder:()=>'top' as const,renderer:()=>({draw:(target:{useMediaCoordinateSpace:(f:(scope:{context:CanvasRenderingContext2D;mediaSize:{width:number;height:number}})=>void)=>void})=>
      target.useMediaCoordinateSpace(({context,mediaSize})=>this.drawEventStrip(context,mediaSize.height))})}],
    hitTest:(x:number,y:number)=>this.eventStripHit(x,y),
  };
  /** Group visible events by bar into lettered badges, honouring each letter's style. */
  private syncEventStrip() {
    const styles=this.currentAppearance?.eventStyles;
    this.eventStrip=[...this.markerEvents].map(([key,events])=>{
      const date=key.slice(7);
      let low=0,high=this.candles.length;
      while(low<high) {const mid=(low+high)>>>1;if(this.candles[mid].date<=date) low=mid+1;else high=mid;}
      const seen=new Set<string>(),badges:{letter:string;color:string}[]=[];
      for(const event of events) {
        const badgeKey=eventBadgeKey(event),definition=EVENT_BADGES.find(item=>item[0]===badgeKey)!;
        if(styles?.[badgeKey]?.visible===false||seen.has(badgeKey)) continue;
        seen.add(badgeKey);badges.push({letter:definition[1],color:styles?.[badgeKey]?.color??definition[3]});
      }
      return {index:Math.max(0,low-1),key,badges};
    }).filter(group=>group.badges.length);
    // Keep a clear row under the volume bars for the badges, as TradingView does.
    const separate=this.volumeSeries&&this.volumeSeries.getPane().paneIndex()!==0;
    if(separate) this.volumeSeries.priceScale().applyOptions({scaleMargins:{top:.1,bottom:this.eventStrip.length?.24:0}});
    this.attachEventStrip();
  }
  /** The strip lives in the lowest pane, like TradingView's events row above the time axis. */
  private attachEventStrip() {
    const panes=this.chart.panes?.();
    const lowest=panes?.at(-1)??null;
    if(lowest===this.eventPane) {this.invalidate();return;}
    try {this.eventPane?.detachPrimitive(this.eventStripPrimitive as never);} catch { /* pane already removed */ }
    this.eventPane=lowest;
    lowest?.attachPrimitive?.(this.eventStripPrimitive as never);
    this.invalidate();
  }
  private eventStripX(index:number,badge:number,count:number) {
    const x=this.chart.timeScale().logicalToCoordinate(index as Logical);
    return x===null?null:x+(badge-(count-1)/2)*15;
  }
  private drawEventStrip(context:CanvasRenderingContext2D,height:number) {
    if(!this.eventStrip.length) return;
    const surface=getComputedStyle(this.host).getPropertyValue('--surface').trim()||'#ffffff';
    context.save();
    context.font='600 9px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
    context.textAlign='center';context.textBaseline='middle';
    const y=height-11;
    for(const group of this.eventStrip) group.badges.forEach((badge,i)=>{
      const x=this.eventStripX(group.index,i,group.badges.length);
      if(x===null) return;
      context.beginPath();context.arc(x,y,6.5,0,Math.PI*2);
      context.fillStyle=surface;context.fill();
      context.lineWidth=1.25;context.strokeStyle=badge.color;context.stroke();
      context.fillStyle=badge.color;context.fillText(badge.letter,x,y+.5);
    });
    context.restore();
  }
  private eventStripAt(x:number,y:number) {
    const height=this.eventPane?.getHeight?.()??0;
    if(!height||Math.abs(y-(height-11))>9) return null;
    for(const group of this.eventStrip) for(let i=0;i<group.badges.length;i++) {
      const at=this.eventStripX(group.index,i,group.badges.length);
      if(at!==null&&Math.abs(x-at)<=8) return {key:group.key,x:at};
    }
    return null;
  }
  private eventStripHit(x:number,y:number) {
    const hit=this.eventStripAt(x,y);
    return hit&&{externalId:hit.key,zOrder:'top' as const,cursorStyle:'pointer'};
  }
  private hoveredEvent:string|null=null;
  private eventHover:(hover:{events:readonly ChartEvent[];x:number;bottom:number}|null)=>void=()=>{};
  /** Reports the badge under the pointer: its centre x and the distance from the host's bottom to the badge's top. */
  onEventHover(callback:typeof this.eventHover) {this.eventHover=callback;}
  private syncEventHover(event:MouseEventParams<Time>) {
    const lowest=(this.chart.panes?.().length??1)-1;
    const hit=event.point&&(event.paneIndex??0)===lowest?this.eventStripAt(event.point.x,event.point.y):null;
    const styles=this.currentAppearance?.eventStyles;
    const events=hit?this.markerEvents.get(hit.key)?.filter(item=>styles?.[eventBadgeKey(item)]?.visible!==false):undefined;
    const key=events?.length?hit!.key:null;
    if(key===this.hoveredEvent) return;
    this.hoveredEvent=key;
    if(!key||!events||!hit) {this.eventHover(null);return;}
    const left=this.chart.priceScale('left').width?.()??0;
    this.eventHover({events,x:hit.x+left,bottom:(this.chart.timeScale().height?.()??0)+11+9});
  }
  private sizingLines:{lines:readonly {price:number;color:string;label:string}[];offset:number;length:number}={lines:[],offset:3,length:4};
  /** Position-sizing stops: short lines `offset` bars past the last bar, `length` bars long, labelled on the right. */
  setSizingLines(lines:readonly {price:number;color:string;label:string}[],offset=3,length=4) {
    this.sizingLines={lines,offset,length};this.invalidate();
  }
  private drawSizingLines(context:CanvasRenderingContext2D) {
    const {lines,offset,length}=this.sizingLines;
    if(!lines.length||!this.candles.length) return;
    const scale=this.chart.timeScale(),last=this.candles.length-1;
    const start=scale.logicalToCoordinate((last+offset) as Logical),end=scale.logicalToCoordinate((last+offset+length) as Logical);
    if(start===null||end===null) return;
    // Keep the line inside the pane so its label, drawn above the right end, is never cut by the price axis.
    const width=scale.width(),x2=Math.min(end,width-4),x1=Math.min(start,x2-12);
    context.save();
    context.font='11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
    context.textAlign='right';context.textBaseline='bottom';context.lineWidth=1;
    context.fillStyle=getComputedStyle(this.host).getPropertyValue('--text').trim()||'#131722';
    for(const line of lines) {
      const y=this.price.priceToCoordinate(line.price);
      if(y===null) continue;
      const at=Math.round(y)+.5;
      context.strokeStyle=line.color;context.beginPath();context.moveTo(x1,at);context.lineTo(x2,at);context.stroke();
      context.fillText(line.label,x2,at-2);
    }
    context.restore();
  }
  /** Bull Snorts below the candle, in the volume settings' shape and colour. */
  private drawSnorts(context:CanvasRenderingContext2D) {
    const cfg=this.studyConfigs.volume;
    if(!this.simpleVolume||cfg?.showSnort===false) return;
    const scale=this.chart.timeScale();
    for(const index of this.simpleVolume.snorts) {
      const bar=this.candles[index];if(!bar) continue;
      const x=scale.logicalToCoordinate(index as Logical),y=this.price.priceToCoordinate(bar.low);
      if(x===null||y===null) continue;
      drawMarkerShape(context,cfg?.snortShape??'square',x,y+10,8,cfg?.snortColor??SIMPLE_VOLUME_COLORS.snort);
    }
  }
  private crosshairLogical:number|null=null;
  private measure:{from:{logical:number;price:number};to:{logical:number;price:number}}|null=null;
  private measurePointer:number|null=null;
  private dragStart:{y:number;auto:boolean}|null=null;
  private prevCloseLine:{series:ISeriesApi<'Candlestick'|'Bar'|'Line'|'Area'|'Baseline'>;line:IPriceLine}|null=null;
  /** Called with a short spoken summary after keyboard navigation (for an aria-live region). */
  announce:(text:string)=>void=()=>{};
  private drawHoverPoint(context:CanvasRenderingContext2D) {
    if(this.crosshairLogical===null||this.currentAppearance?.crosshair===false||this.replayPicker) return;
    const bar=this.candles[this.crosshairLogical];
    if(!bar) return;
    const x=this.chart.timeScale().logicalToCoordinate(this.crosshairLogical as Logical),y=this.price.priceToCoordinate(bar.close);
    if(x===null||y===null) return;
    context.save();context.fillStyle='#2962ff';
    context.beginPath();context.arc(x,y,3,0,Math.PI*2);context.fill();context.restore();
  }
  /** Previous bar's close as a dashed line with an axis label. */
  private updatePrevCloseLine() {
    if(this.prevCloseLine) {
      if(this.prevCloseLine.series===this.price) this.price.removePriceLine(this.prevCloseLine.line);
      this.prevCloseLine=null;
    }
    const previous=this.candles.at(-2);
    if(this.currentAppearance?.prevCloseLine!==true||!previous) return;
    const muted=getComputedStyle(this.host).getPropertyValue('--muted').trim()||'#86868b';
    this.prevCloseLine={series:this.price,line:this.price.createPriceLine({price:previous.close,color:muted,lineWidth:1,lineStyle:LineStyle.Dotted,axisLabelVisible:true,title:''})};
  }
  /** Shift + drag: price change, %, bars and days between two points, like TradingView's quick measure. */
  private drawMeasure(context:CanvasRenderingContext2D) {
    const m=this.measure;
    if(!m) return;
    const scale=this.chart.timeScale(),series=this.activeSeries();
    const x1=scale.logicalToCoordinate(m.from.logical as Logical),x2=scale.logicalToCoordinate(m.to.logical as Logical);
    const y1=series.priceToCoordinate(m.from.price),y2=series.priceToCoordinate(m.to.price);
    if(x1===null||x2===null||y1===null||y2===null) return;
    const up=m.to.price>=m.from.price,color=up?'#2962ff':'#f23645';
    const change=m.to.price-m.from.price,percent=m.from.price?change/Math.abs(m.from.price)*100:0;
    const bars=Math.round(m.to.logical-m.from.logical);
    const day=(logical:number)=>{const index=Math.round(logical),candle=this.candles[Math.max(0,Math.min(this.candles.length-1,index))];
      return candle?Date.parse(candle.date)+(index-Math.max(0,Math.min(this.candles.length-1,index)))*86_400_000:0;};
    const days=Math.round((day(m.to.logical)-day(m.from.logical))/86_400_000);
    context.save();
    context.fillStyle=up?'rgba(41,98,255,.12)':'rgba(242,54,69,.12)';
    context.fillRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1));
    context.strokeStyle=color;context.lineWidth=1;
    const midX=(x1+x2)/2,midY=(y1+y2)/2;
    const arrow=(fromX:number,fromY:number,toX:number,toY:number)=>{
      context.beginPath();context.moveTo(fromX,fromY);context.lineTo(toX,toY);context.stroke();
      const angle=Math.atan2(toY-fromY,toX-fromX);
      context.beginPath();context.moveTo(toX,toY);context.lineTo(toX-6*Math.cos(angle-.5),toY-6*Math.sin(angle-.5));
      context.moveTo(toX,toY);context.lineTo(toX-6*Math.cos(angle+.5),toY-6*Math.sin(angle+.5));context.stroke();
    };
    if(Math.abs(y2-y1)>8) arrow(midX,y1,midX,y2);
    if(Math.abs(x2-x1)>8) arrow(x1,midY,x2,midY);
    const lines=[`${change>=0?'':'−'}${Math.abs(change).toFixed(2)} (${percent>=0?'':'−'}${Math.abs(percent).toFixed(2)}%)`,`${bars} bars, ${days}d`];
    context.font='12px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
    const width=Math.max(...lines.map(line=>context.measureText(line).width))+16,height=38;
    const boxX=midX-width/2,boxY=up?Math.min(y1,y2)-height-6:Math.max(y1,y2)+6;
    context.fillStyle=color;context.beginPath();context.roundRect(boxX,boxY,width,height,4);context.fill();
    context.fillStyle='#ffffff';context.textAlign='center';context.textBaseline='middle';
    context.fillText(lines[0],midX,boxY+12);context.fillText(lines[1],midX,boxY+27);
    context.restore();
  }
  /** Whether the latest bar is on screen (otherwise the chart offers "jump to latest"). */
  isLatestVisible() {
    // By position, not index: the time scale's logical indices need not match this.candles.
    const last=this.candles.at(-1),scale=this.chart.timeScale();
    if(!last) return true;
    const x=scale.timeToCoordinate(last.date);
    return x!==null&&x<=scale.width();
  }
  /** Fit every bar on screen. */
  fitAll() {this.setRange(null);}
  private describeLatestVisible() {
    const range=this.chart.timeScale().getVisibleLogicalRange();
    const index=Math.max(0,Math.min(this.candles.length-1,Math.floor(range?.to??this.candles.length-1)));
    const bar=this.candles[index];
    if(bar) this.announce(`${crosshairDate(bar.date)}: open ${bar.open}, high ${bar.high}, low ${bar.low}, close ${bar.close}`);
  }
  private bandChanges:readonly {date:string;from:string;to:string}[]=[];
  /** Past NSE price-band changes, drawn as labels above the candle on each change date. */
  private bandStyles:Partial<Record<string,MarkerStyle>>={};
  setBandChanges(changes:readonly {date:string;from:string;to:string}[],styles:Partial<Record<string,MarkerStyle>>={}) {this.bandChanges=changes;this.bandStyles=styles;this.invalidate();}
  /** Bar index for each visible band change (the bar containing its date), within the replay cutoff. */
  private bandChangeBars() {
    const out:{index:number;to:string}[]=[];
    for(const change of this.bandChanges) {
      if(change.date>this.eventCutoff||!this.candles.length||change.date<this.candles[0].date) continue;
      let low=0,high=this.candles.length;
      while(low<high) {const mid=(low+high)>>>1;if(this.candles[mid].date<=change.date) low=mid+1;else high=mid;}
      out.push({index:Math.max(0,low-1),to:change.to});
    }
    return out;
  }
  /** As in the reference script: the new band as text, a small coloured square, and a fine dotted line down to the candle. */
  private drawBandChanges(context:CanvasRenderingContext2D) {
    if(!this.bandChanges.length) return;
    const scale=this.chart.timeScale(),text=getComputedStyle(this.host).getPropertyValue('--band-label').trim()||'#1a3a8f';
    context.save();
    context.font='12px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
    context.textAlign='center';context.textBaseline='bottom';
    for(const {index,to} of this.bandChangeBars()) {
      const x=scale.logicalToCoordinate(index as Logical),top=this.price.priceToCoordinate(this.candles[index].high);
      if(x===null||top===null) continue;
      const band=Number.parseFloat(to),key=to==='No Band'?'NB':String(band);
      const style=markerStyle(this.bandStyles[key],{visible:true,shape:'square' as MarkerShape,
        color:band===20?'#2962ff':band===10?'#4caf50':band===5?'#fbc02d':band===2?'#f23645':'#9598a1'});
      if(!style.visible) continue;
      const color=style.color,square=top-22;
      context.strokeStyle=color;context.lineWidth=1;context.setLineDash([1.5,2.5]);
      context.beginPath();context.moveTo(Math.round(x)+.5,square+6);context.lineTo(Math.round(x)+.5,top-3);context.stroke();
      context.setLineDash([]);
      drawMarkerShape(context,style.shape,Math.round(x),square+3,7,color);
      context.fillStyle=text;context.fillText(to==='No Band'?'NB':`${to}%`,x,square-3);
    }
    context.restore();
  }
  /** Bar position of a date: an existing bar, or bars counted past the last one (weekdays, weeks or months). */
  private logicalForDate(date:string):number|null {
    const count=this.candles.length;
    if(!count||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const last=this.candles[count-1].date;
    if(date<=last) {
      let low=0,high=count;
      while(low<high) {const mid=(low+high)>>>1;if(this.candles[mid].date<=date) low=mid+1;else high=mid;}
      return Math.max(0,low-1);
    }
    const gaps:number[]=[];
    for(let index=Math.max(1,count-20);index<count;index++) gaps.push((Date.parse(this.candles[index].date)-Date.parse(this.candles[index-1].date))/86_400_000);
    gaps.sort((a,b)=>a-b);
    const gap=gaps.length?gaps[gaps.length>>1]:1;
    const from=new Date(`${last}T00:00:00Z`),to=new Date(`${date}T00:00:00Z`);
    if(gap>=20) return count-1+(to.getUTCFullYear()-from.getUTCFullYear())*12+to.getUTCMonth()-from.getUTCMonth();
    if(gap>=5) return count-1+Math.ceil((to.getTime()-from.getTime())/(7*86_400_000));
    let sessions=0;
    for(const day=new Date(from);day<to;) {day.setUTCDate(day.getUTCDate()+1);if(day.getUTCDay()%6!==0) sessions++;}
    return count-1+sessions;
  }
  /** Upcoming results date: a purple "E" (and optional dotted line) on that future bar, as in the QE Ultra script. */
  setUpcomingEarnings(value:{date:string;line:boolean}|null) {
    const changed=value?.date!==this.upcomingEarnings?.date;
    this.upcomingEarnings=value;
    // Bring the label into view when the latest bar is on screen.
    const logical=value?this.logicalForDate(value.date):null,scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange();
    if(changed&&logical!==null&&range&&range.to>=this.candles.length-1&&logical+8>range.to) scale.setVisibleLogicalRange({from:range.from,to:logical+8});
    this.invalidate();
  }
  private drawUpcomingEarnings(context:CanvasRenderingContext2D,bottom:number) {
    const value=this.upcomingEarnings,last=this.candles.at(-1);
    if(!value||!last) return;
    const logical=this.logicalForDate(value.date);
    const x=logical===null?null:this.chart.timeScale().logicalToCoordinate(logical as Logical);
    if(x===null||x<0) return;
    // Along the bottom of the price pane, like TradingView's earnings icons, clear of the UC/LC tags.
    const y=bottom-14;
    const color='#9c27b0';
    context.save();
    if(value.line) {context.strokeStyle=color;context.lineWidth=2;context.setLineDash([2,3]);context.beginPath();context.moveTo(x,0);context.lineTo(x,bottom);context.stroke();context.setLineDash([]);}
    context.fillStyle=color;
    context.beginPath();context.roundRect(x-9,y-9,18,18,5);context.fill();
    context.fillStyle='#ffffff';context.font='700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';context.textAlign='center';context.textBaseline='middle';
    context.fillText('E',x,y+.5);
    context.restore();
  }
  private bandGuideValues: readonly number[] = [];
  private bandGuideLines: IPriceLine[] = [];
  setPriceBandGuides(values: readonly number[]) {
    for (const line of this.bandGuideLines) this.price.removePriceLine(line);
    this.bandGuideValues = values;
    this.bandGuideLines = values.filter(value => Number.isFinite(value) && value > 0).map((price, index) => this.price.createPriceLine({
      // Next-session upper (UC) and lower (LC) circuit, blue and red as in the reference indicator.
      price, title: index === 0 ? 'UC' : 'LC', color: index === 0 ? '#2962ff' : '#f23645', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true,
    }));
  }
  /** High and low of the visible bars, drawn as labelled price lines. */
  private updateHighLowLines() {
    if(this.highLowLines) {
      if(this.highLowLines.series===this.price) for(const line of this.highLowLines.lines) this.price.removePriceLine(line);
      this.highLowLines=null;
    }
    if(!this.currentAppearance?.highLowPriceLines||!this.candles.length) return;
    const range=this.chart.timeScale().getVisibleLogicalRange();
    const from=Math.max(0,Math.floor(range?.from??0)),to=Math.min(this.candles.length-1,Math.ceil(range?.to??this.candles.length-1));
    if(to<from) return;
    let high=-Infinity,low=Infinity;
    for(let index=from;index<=to;index++) {high=Math.max(high,this.candles[index].high);low=Math.min(low,this.candles[index].low);}
    const muted=getComputedStyle(this.host).getPropertyValue('--muted').trim()||'#86868b';
    const line=(price:number,title:string)=>this.price.createPriceLine({price,title,color:muted,lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true});
    this.highLowLines={series:this.price,lines:[line(high,'H'),line(low,'L')]};
  }
  private onVisibleRange=()=>{
    if(!this.currentAppearance?.highLowPriceLines) return;
    cancelAnimationFrame(this.highLowFrame);
    this.highLowFrame=requestAnimationFrame(()=>this.updateHighLowLines());
  };
  /** Shows the latest `count` bars (the "Default visible bars" setting). */
  showLastBars(count:number) {
    if(!this.candles.length||count<=0) return;
    this.setLatestRange(Math.max(0,this.candles.length-Math.round(count)));
  }
  private setEmaData(series:ISeriesApi<'Line'>,line:EmaLine) {
    const values=this.studyLines(studyKey.ema(line.period))?.value;
    this.requestMissingStudies();
    series.setData(values?this.candles.map((bar,index)=>values[index]===null?{time:bar.date}:{time:bar.date,value:values[index]!}):[]);
  }
  /**
   * Shares a chart's indicator results with its legend. The store holds the full history and computes in a
   * background worker, so replayed prefixes read cached values and nothing recomputes per bar.
   */
  setStudyStore(store:StudyStore) {this.studyStore=store;this.ownStudyStore=false;}
  /** Redraws indicators whose results arrived since the last draw. */
  refreshStudies() {
    this.setStudies(this.studies);
    for(const {series,line} of this.averages.values()) this.setEmaData(series,line);
  }
  private studyLines(key:string):StudyLines|undefined {
    if(this.ownStudyStore) {this.studyStore.setInputs(this.candles,this.benchmark);return this.studyStore.getNow(key);}
    const lines=this.studyStore.take(key);
    if(!lines) this.missingStudies.add(key);
    return lines;
  }
  private requestMissingStudies() {
    if(!this.missingStudies.size) return;
    this.studyStore.request([...this.missingStudies]);this.missingStudies.clear();
  }
  setEmaLines(lines:readonly EmaLine[]) {
    if(lines.length>5 || !lines.every(validEmaLine)) return;
    for(const [id,{series}] of this.averages) if(!lines.some(line=>line.id===id && line.enabled)) {this.chart.removeSeries(series);this.averages.delete(id);}
    for(const line of lines.filter(line=>line.enabled)) {
      let entry=this.averages.get(line.id);
      if(!entry) {entry={series:this.chart.addSeries(LineSeries,{lastValueVisible:false,priceLineVisible:false,crosshairMarkerVisible:false}),line};this.averages.set(line.id,entry);}
      entry.line={...line};
      entry.series.applyOptions({color:withAlpha(line.color,line.opacity),lineWidth:line.width as LineWidth,lineStyle:line.style==='dashed'?LineStyle.Dashed:line.style==='dotted'?LineStyle.Dotted:LineStyle.Solid});
      this.setEmaData(entry.series,line);
    }
  }
  setStyle(style:ChartStyle) {
    if(style===this.style) return;
    const range=this.chart.timeScale().getVisibleLogicalRange();
    for(const line of this.priceLines.values()) this.activeSeries().removePriceLine(line);
    this.priceLines.clear();this.markers.detach();
    for (const line of this.bandGuideLines) this.price.removePriceLine(line);
    this.bandGuideLines = [];
    this.activeSeries().detachPrimitive(this.primitive);
    const previous=this.price;
    this.style=style;
    const order=previous.seriesOrder();
    this.price=this.createPriceSeries();this.setPriceData();this.price.setSeriesOrder(order);this.chart.removeSeries(previous);
    this.setPriceBandGuides(this.bandGuideValues);
    this.activeSeries().attachPrimitive(this.primitive);
    this.markers=createSeriesMarkers(this.activeSeries(),[],{autoScale:false});this.refreshMarkers();
    if(range) this.chart.timeScale().setVisibleLogicalRange(range);
    this.invalidate();
  }
  private applyAppearanceColors(appearance:ChartAppearance) {
    const style=getComputedStyle(this.host);
    const token=(name:string,fallback:string)=>style.getPropertyValue(`--${name}`).trim()||fallback;
    this.chart.applyOptions({
      layout:{
        background:{type:ColorType.Solid,color:appearance.backgroundColor||token('chart-background',token('surface','#ffffff'))},
        textColor:appearance.scaleTextColor||token('muted','#787b86'),
        fontSize:Math.max(9,Math.min(16,Math.round(appearance.scaleFontSize??12))),
      },
      grid:{
        horzLines:appearance.horzGridColor?{color:appearance.horzGridColor}:{},
        vertLines:appearance.vertGridColor?{color:appearance.vertGridColor}:{},
      },
    });
    this.price.applyOptions(this.priceOptions());
    const signature=JSON.stringify([appearance.colorByPreviousClose,appearance.upColor,appearance.downColor,appearance.borderUpColor,appearance.borderDownColor,appearance.wickUpColor,appearance.wickDownColor,appearance.bodyVisible]);
    if(signature!==this.barColorSignature) {
      const perBar=appearance.colorByPreviousClose||JSON.parse(this.barColorSignature||'[false]')[0];
      this.barColorSignature=signature;
      if(perBar&&this.candles.length) this.setPriceData();
    }
    this.updateHighLowLines();
    this.updatePrevCloseLine();
  }
  private barColorSignature='';
  private savedAppearance?:ChartAppearance;
  setAppearance(saved:ChartAppearance) {
    this.savedAppearance=saved;
    const appearance=forTheme(saved,currentTheme());
    this.currentAppearance=appearance;
    this.scaleMode=appearance.scaleMode;
    this.applyAppearanceColors(appearance);
    const toLwcLineStyle=(s?:string)=>s==='dashed'?LineStyle.Dashed:s==='dotted'?LineStyle.Dotted:LineStyle.Solid;
    this.chart.applyOptions({
      timeScale:{
        enableConflation:appearance.conflation??false,
        fixLeftEdge:false,
      },
      grid:{
        horzLines:{
          visible:appearance.horizontalGrid,
          ...(appearance.horzGridColor?{color:appearance.horzGridColor}:{}),
          style:toLwcLineStyle(appearance.horzGridStyle),
        },
        vertLines:{
          visible:appearance.verticalGrid,
          ...(appearance.vertGridColor?{color:appearance.vertGridColor}:{}),
          style:toLwcLineStyle(appearance.vertGridStyle),
        },
      },
      crosshair:{
        mode:appearance.crosshairMode==='magnet'?CrosshairMode.Magnet:appearance.crosshairMode==='ohlc'?CrosshairMode.MagnetOHLC:CrosshairMode.Normal,
        vertLine:{
          visible:appearance.crosshair,
          width:1,
          labelVisible:appearance.crosshair,
          ...(appearance.crosshairTransparency !== undefined
            ? { color: withAlpha(appearance.crosshairColor || '#aab8c5', Math.max(0, Math.min(1, 1 - appearance.crosshairTransparency / 100))) }
            : appearance.crosshairColor ? { color: appearance.crosshairColor } : {}),
          style:toLwcLineStyle(appearance.crosshairStyle),
        },
        horzLine:{
          visible:false,
          labelVisible:appearance.crosshair,
          ...(appearance.crosshairTransparency !== undefined
            ? { color: withAlpha(appearance.crosshairColor || '#aab8c5', Math.max(0, Math.min(1, 1 - appearance.crosshairTransparency / 100))) }
            : appearance.crosshairColor ? { color: appearance.crosshairColor } : {}),
          style:toLwcLineStyle(appearance.crosshairStyle),
        },
      },
      handleScroll:this.scrollOptions(),
      handleScale:appearance.zoomEnabled!==false
        ? {...SCALE_WITH_WHEEL,axisPressedMouseMove:{time:true,price:appearance.mousePan!=='horizontal'}}
        : false,
    });
    // Horizontal-only drag keeps the price scale fitted to the visible bars.
    if(appearance.mousePan==='horizontal') this.chart.priceScale('right').applyOptions({autoScale:true});

    if(this.watermarkPlugin) {
      this.watermarkPlugin.detach();
      this.watermarkPlugin=undefined;
    }
    if(appearance.watermarkVisible&&this.chart.panes().length>0) {
      try {
        const pane=this.chart.panes()[0];
        this.watermarkPlugin=createTextWatermark(pane,{
          horzAlign:'center',
          vertAlign:'center',
          lines:[{
            text:appearance.watermarkText||'',
            color:appearance.watermarkColor?withAlpha(appearance.watermarkColor.slice(0,7),appearance.watermarkOpacity??.15):'rgba(154, 164, 178, 0.15)',
            fontSize:48,
          }],
        });
      } catch { /* watermark is optional enhancement */ }
    }

    const separate=!!appearance.volumePane&&appearance.volume;
    // Leave the volume pane empty before moving volume back, so the pane is removed.
    if(!separate&&this.volumeAverage) {this.chart.removeSeries(this.volumeAverage);this.volumeAverage=null;}
    if((this.volumeSeries.getPane().paneIndex()!==0)!==separate) {
      this.volumeSeries.moveToPane(separate?this.chart.panes().length:0);
      if(separate) this.volumeSeries.getPane().setStretchFactor(.25);
    }
    this.volumeSeries.applyOptions({
      priceScaleId:separate?'right':'volume',
      lastValueVisible:separate,
      visible:appearance.volume,
    });
    this.volumeSeries.priceScale().applyOptions({scaleMargins:{top:separate?.1:.8,bottom:0},visible:separate});
    this.syncVolumeAverage();
    const topMargin=typeof appearance.topMargin==='number'?appearance.topMargin/100:.13;
    const bottomMargin=typeof appearance.bottomMargin==='number'?appearance.bottomMargin/100:(appearance.volume&&!separate?.22:.06);
    this.chart.priceScale('right').applyOptions({
      mode:this.comparison&&!this.comparisonSeparate?PriceScaleMode.Percentage:scaleModes[appearance.scaleMode],
      invertScale:appearance.invertScale??false,
      scaleMargins:{top:topMargin,bottom:bottomMargin},
    });
    this.showEvents=appearance.events??false;this.refreshMarkers();
    this.updatePaneObservers();
    this.notifyPanesChange();
    this.invalidate();
  }
  resetPriceScale=()=>this.chart.priceScale('right').setAutoScale(true);
  reset=()=>{
    this.layer.cancel();this.resetPriceScale();
    this.setLatestRange(Math.max(0,this.candles.length-120));
  };
  zoom(factor:number,anchor=.5) {
    const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange();if(!range) return;
    const count=Math.max(5,(range.to-range.from)*factor),delta=range.to-range.from-count;
    scale.setVisibleLogicalRange({from:range.from+delta*anchor,to:range.from+delta*anchor+count});
  }
  setRange(months:number|null) {
    if(!this.candles.length) return;
    if(months===null) {this.setLatestRange(0);return;}
    const last=this.candles.at(-1)!,boundary=new Date(`${last.date}T00:00:00Z`);
    boundary.setUTCMonth(boundary.getUTCMonth()-months);
    const from=this.candles.findIndex(bar=>bar.date>=boundary.toISOString().slice(0,10));
    this.setLatestRange(Math.max(0,from));
  }
  private setLatestRange(from:number) {
    const scale=this.chart.timeScale(),width=scale.width(),last=this.candles.length-1;
    const pixelBars=width>RIGHT_EDGE_PIXELS?Math.ceil(RIGHT_EDGE_PIXELS*(last-from)/(width-RIGHT_EDGE_PIXELS)):0;
    scale.setVisibleLogicalRange({from,to:last+Math.max(RIGHT_EDGE_BARS,pixelBars)});
  }
  setCandles(candles:readonly Candle[]) {
    const previous=this.candles;
    // Replay passes immutable prefixes; appended bars use native incremental updates.
    const appended=candles.length===previous.length+1 && previous.every((bar,index)=>bar===candles[index]);
    const shortened=candles.length<previous.length&&candles.every((bar,index)=>bar===previous[index]);
    const range=this.chart.timeScale().getVisibleLogicalRange();
    this.candles=candles;this.times=candles.map(bar=>Date.parse(bar.date));this.byDate=new Map(candles.map(bar=>[bar.date,bar]));
    this.drawingBars=candles.map((bar,index)=>({...bar,time:this.times[index]}));
    if(appended) {
      const bar=candles.at(-1)!;
      this.price.update(this.priceData(bar,candles.length-1));
      this.updatePrevCloseLine();
      this.computeVolume(true);
      this.volumeSeries.update(this.volumeData(bar,candles.length-1));
      for(const {series,line} of this.averages.values()) {
        const value=this.studyLines(studyKey.ema(line.period))?.value[candles.length-1];
        series.update(value===null || value===undefined?{time:bar.date}:{time:bar.date,value});
      }
    } else if(shortened) {
      const count=previous.length-candles.length;
      for(const series of [this.price,this.volumeSeries,...[...this.averages.values()].map(entry=>entry.series),...this.studySeries,...(this.volumeAverage?[this.volumeAverage]:[])]) series.pop(count);
    } else this.setData();
    // Native append following honors a user who has panned away. Rewinds preserve the view.
    if(!appended&&range) this.chart.timeScale().setVisibleLogicalRange(range);
    if(!shortened) this.updateStudies(appended);
    this.updateComparison();this.refreshMarkers();
    this.layer.cancel();this.inspect(candles.at(-1)!);
  }
  takeScreenshot() {return this.chart.takeScreenshot(true,false);}
  savedView() {
    const range=this.chart.timeScale().getVisibleRange();
    return range?{from:this.dateString(range.from),to:this.dateString(range.to)}:undefined;
  }
  restoreView(view:{from:string;to:string}) {
    const last=this.candles.at(-1);
    if(last&&view.to>=last.date) {
      const from=this.candles.findIndex(bar=>bar.date>=view.from);
      this.setLatestRange(from<0?Math.max(0,this.candles.length-120):from);
    } else this.chart.timeScale().setVisibleRange(view);
  }
  paneWeights() {return this.chart.panes().map(pane=>pane.getStretchFactor());}
  restorePaneWeights(weights:readonly number[]) {const panes=this.chart.panes();if(weights.length===panes.length) panes.forEach((pane,index)=>pane.setStretchFactor(weights[index]));}
  latest() {
    const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange(),width=scale.width();
    const pixelBars=range&&width>0?Math.ceil(RIGHT_EDGE_PIXELS*(range.to-range.from)/width):0;
    scale.scrollToPosition(Math.max(RIGHT_EDGE_BARS,pixelBars),true);
  }
  goToDate(date:string):boolean {
    const scale=this.chart.timeScale(),index=scale.timeToIndex(date,true),range=scale.getVisibleLogicalRange();
    if(index===null||!range||date<this.candles[0].date||date>this.candles.at(-1)!.date) return false;
    const half=(range.to-range.from)/2;scale.setVisibleLogicalRange({from:index-half,to:index+half});return true;
  }
  setEvents(events:readonly ChartEvent[],cutoff:string) {this.eventData=events;this.eventCutoff=cutoff;this.refreshMarkers();}
  private refreshMarkers() {
    if(!this.markers) return;
    this.markerEvents.clear();
    for(const event of this.eventData) {
      if (!this.showEvents && !(this.studyConfigs.fundamentals?.enabled && this.studyConfigs.fundamentals.earningsMarkers !== false && this.fundamentalsVisible && event.kind === 'earnings')) continue;
      if(event.date>this.eventCutoff||event.date<this.candles[0].date) continue;
      // Events fall on the closed aggregate containing them; daily holidays use the preceding session.
      let low=0,high=this.candles.length;
      while(low<high) {const mid=(low+high)>>>1;if(this.candles[mid].date<=event.date) low=mid+1;else high=mid;}
      const time=this.candles[Math.max(0,low-1)].date,key=`events:${time}`,entry=this.markerEvents.get(key);
      if(entry) entry.push(event);else this.markerEvents.set(key,[event]);
    }
    // Events are drawn as lettered badges in the bottom strip (see drawEventStrip), not as candle markers.
    const eventMarkers:SeriesMarker<Time>[]=[];
    this.syncEventStrip();
    // Bull Snorts: a small purple square under the candle.
    // Bull Snorts are drawn on the canvas with their configurable shape (drawSnorts).
    const snorts:SeriesMarker<Time>[]=[];
    this.invalidate();
    this.markers.setMarkers([...eventMarkers,...snorts].sort((a,b)=>String(a.time).localeCompare(String(b.time))));
  }
  /** Late benchmark data refreshes relative strength without rebuilding the chart or its panes. */
  setBenchmark(benchmark:ReadonlyMap<string,number>|undefined) {
    if (this.benchmark === benchmark) return;
    this.benchmark=benchmark;
    if (this.studySeries.length && this.studyConfigs.extras?.rs?.enabled) this.updateStudies();
  }
  setStudyConfigs(configs:StudyConfigs) {
    // The caller applies the new visibility with setStudies immediately after.
    // Rebuilding here would create and remove every native series twice.
    const previous=this.studyConfigs.volume;
    this.studyConfigs=configs;
    this.refreshMarkers();
    if(JSON.stringify({...previous,visibility:undefined,separatePane:undefined})!==JSON.stringify({...configs.volume,visibility:undefined,separatePane:undefined})) {
      this.computeVolume();
      this.volumeSeries.setData(this.candles.map((bar,index)=>this.volumeData(bar,index)));
      this.refreshMarkers();
    }
  }
  setStudies(studies:Partial<ChartStudies>) {
    this.studies={...defaultStudies(),...studies};
    const plots=this.studyPlots();
    const next=new Map<string,{series:ISeriesApi<'Line'|'Histogram'>;values:(number|null)[];candles:readonly Candle[]}>();
    const wanted=new Set(plots.map(plot=>plot.key));
    // Lines that stay are kept as they are; only removed or new ones touch the chart.
    for(const [key,entry] of this.studyEntries) if(!wanted.has(key)) this.chart.removeSeries(entry.series);
    const paneOf=new Map<string,number>(),created=new Set<string>();
    for(const plot of plots) {
      const kept=this.studyEntries.get(plot.key);
      if(kept&&plot.pane!=='price') paneOf.set(plot.pane,kept.series.getPane().paneIndex());
    }
    this.studySeries=[];this.studySeriesByPane.clear();this.studySeriesById.clear();
    for(const plot of plots) {
      const options={color:plot.color,lineWidth:(plot.lineWidth??1) as LineWidth,lineStyle:plot.lineStyle??LineStyle.Solid,title:plot.title};
      let entry=this.studyEntries.get(plot.key);
      if(entry) entry.series.applyOptions(options);
      else {
        if(plot.pane!=='price'&&!paneOf.has(plot.pane)) {paneOf.set(plot.pane,this.chart.panes().length);created.add(plot.pane);}
        const series=this.chart.addSeries(plot.histogram?HistogramSeries:LineSeries,{
          ...options,
          priceLineVisible:false,
          lastValueVisible:!plot.histogram&&!plot.dots,
          ...(plot.dots?{lineVisible:false,pointMarkersVisible:true,pointMarkersRadius:1.5}:{})
        },plot.pane==='price'?0:paneOf.get(plot.pane)!);
        if(created.delete(plot.pane)) series.getPane().setStretchFactor(.3);
        for(const level of plot.levels??[]) {
          series.createPriceLine({
            price:level.price,
            color:level.color??'#aab8c5',
            lineWidth:1 as LineWidth,
            lineStyle:level.lineStyle??LineStyle.Dashed,
            axisLabelVisible:true
          });
        }
        entry={series,values:[],candles:[]};
      }
      if(entry.values!==plot.values||entry.candles!==this.candles) {
        entry.series.setData(this.studyData(plot));
        entry.values=plot.values;entry.candles=this.candles;
      }
      next.set(plot.key,entry);
      this.studySeries.push(entry.series);
      if(plot.id) {
        if(!this.studySeriesById.has(plot.id)) this.studySeriesById.set(plot.id,[]);
        this.studySeriesById.get(plot.id)!.push(entry.series);
      }
      if(!this.studySeriesByPane.has(plot.pane)) this.studySeriesByPane.set(plot.pane,[]);
      this.studySeriesByPane.get(plot.pane)!.push(entry.series);
    }
    this.studyEntries=next;this.studyPlotList=plots;
    this.updatePaneObservers();
    this.notifyPanesChange();
  }
  /**
   * What each enabled indicator draws. Values come from the study store; an indicator whose result is still
   * being computed is left out and appears on the next refreshStudies.
   */
  private studyPlots():StudyPlot[] {
    const toLineStyle=(s?:string)=>s==='dashed'?LineStyle.Dashed:s==='dotted'?LineStyle.Dotted:LineStyle.Solid;
    const plots:StudyPlot[]=[];
    const add=(key:string,line:string,title:string,color:string,pane='price',lineWidth=1,lineStyle=LineStyle.Solid,levels?:StudyPlot['levels'],extra:Partial<StudyPlot>={})=>{
      const values=this.studyLines(key)?.[line];
      if(!values) return;
      plots.push({key:[key,line,pane,extra.histogram?1:0,extra.dots?1:0,JSON.stringify(levels??[])].join('|'),title,color,values,pane,lineWidth,lineStyle,levels,...extra});
    };

    if(this.studies.rsi) {
      const cfg=this.studyConfigs.rsi;
      const period=cfg?.period??14;
      const levels=cfg?.bandsVisible!==false?[
        {price:cfg?.oversold??30,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
        {price:cfg?.overbought??70,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
      ]:undefined;
      if(cfg?.lineVisible!==false) {
        add(studyKey.rsi(period,cfg?.source??'close'),'value',`RSI ${period}`,cfg?.color??'#8b5cf6','rsi',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle),levels);
      }
    }
    if(this.studies.macd) {
      const cfg=this.studyConfigs.macd;
      const fast=cfg?.fast??12,slow=cfg?.slow??26,signal=cfg?.signal??9;
      const key=studyKey.macd(fast,slow,signal,cfg?.source??'close');
      if(cfg?.macdVisible!==false) {
        add(key,'line',`MACD ${fast}/${slow}`,cfg?.macdColor??this.accent,'macd',cfg?.macdWidth??1,toLineStyle(cfg?.macdStyle));
      }
      if(cfg?.signalVisible!==false) {
        add(key,'signal',`Signal ${signal}`,cfg?.signalColor??'#f59e0b','macd',cfg?.signalWidth??1,toLineStyle(cfg?.signalStyle));
      }
      if(cfg?.histVisible!==false) {
        add(key,'histogram','MACD histogram',cfg?.histColor??CHART_PALETTE.volumeUp,'macd',1,LineStyle.Solid,undefined,{histogram:true});
      }
    }
    if(this.studies.sma) {
      const cfg=this.studyConfigs.sma;
      const period=cfg?.period??50;
      if(cfg?.visible!==false) {
        add(studyKey.sma(period,cfg?.source??'close'),'value',`SMA ${period}`,cfg?.color??'#3b82f6','price',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle));
      }
    }
    if(this.studies.bollinger) {
      const cfg=this.studyConfigs.bollinger;
      const period=cfg?.period??20,multiplier=cfg?.multiplier??2;
      const key=studyKey.bollinger(period,multiplier,cfg?.source??'close');
      if(cfg?.upperVisible!==false) {
        add(key,'upper',`BB ${period} · upper`,cfg?.upperColor??'#78909c','price',cfg?.upperWidth??1,toLineStyle(cfg?.upperStyle));
      }
      if(cfg?.middleVisible!==false) {
        add(key,'middle',`BB ${period} · middle`,cfg?.middleColor??'#78909c','price',cfg?.middleWidth??1,toLineStyle(cfg?.middleStyle??'dashed'));
      }
      if(cfg?.lowerVisible!==false) {
        add(key,'lower',`BB ${period} · lower`,cfg?.lowerColor??'#78909c','price',cfg?.lowerWidth??1,toLineStyle(cfg?.lowerStyle));
      }
    }
    if(this.studies.vwap) {
      const cfg=this.studyConfigs.vwap;
      if(cfg?.visible!==false) {
        add(studyKey.vwap(),'value','Monthly VWAP',cfg?.color??'#e09b26','price',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle));
      }
    }
    if(this.studies.atr) {
      const cfg=this.studyConfigs.atr;
      const period=cfg?.period??14;
      if(cfg?.visible!==false) {
        add(studyKey.atr(period),'value',`ATR ${period}`,cfg?.color??'#e09b26','atr',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle));
      }
    }
    if(this.studies.stochastic) {
      const cfg=this.studyConfigs.stochastic;
      const period=cfg?.period??14,dPeriod=cfg?.dPeriod??3;
      const key=studyKey.stochastic(period,dPeriod);
      const levels=cfg?.bandsVisible!==false?[
        {price:cfg?.lower??20,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
        {price:cfg?.upper??80,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
      ]:undefined;
      if(cfg?.kVisible!==false) {
        add(key,'k',`Stoch %K ${period}`,cfg?.kColor??this.accent,'stochastic',cfg?.kWidth??1,toLineStyle(cfg?.kStyle),levels);
      }
      if(cfg?.dVisible!==false) {
        add(key,'d',`Stoch %D ${dPeriod}`,cfg?.dColor??'#ef5350','stochastic',cfg?.dWidth??1,toLineStyle(cfg?.dStyle));
      }
    }
    if(this.studies.supertrend) {
      const cfg=this.studyConfigs.supertrend;
      const period=cfg?.period??10,multiplier=cfg?.multiplier??3;
      const key=studyKey.supertrend(period,multiplier);
      // Coloured by the direction at the latest shown bar (a replayed prefix reads the full history).
      const direction=this.studyLines(key)?.direction[this.candles.length-1];
      add(key,'value',`Supertrend ${period} ${multiplier}`,direction===-1?(cfg?.downColor??'#ef5350'):(cfg?.upColor??'#089981'),'price',cfg?.lineWidth??2,toLineStyle(cfg?.lineStyle));
    }
    const extras=this.studyConfigs.extras;
    for(const def of enabledExtraStudies(extras)) {
      const state=extras?.[def.id],params=studyParams(def,state),title=studyTitle(def,params),key=studyKey.extra(def.id,params);
      const levels=def.levels?.map(price=>({price,color:'#aab8c5',lineStyle:LineStyle.Dashed}));
      def.lines.forEach((line,index)=>add(key,line.key,index===0?title:'',studyLineColor(line,state),
        def.pane==='price'?'price':def.id,line.dots?2:1,line.dashed?LineStyle.Dashed:LineStyle.Solid,index===0?levels:undefined,{id:def.id,dots:line.dots}));
    }
    this.requestMissingStudies();
    return plots;
  }
  private studyData(plot:StudyPlot) {
    return this.candles.map((bar,i)=>plot.values[i]===null||plot.values[i]===undefined?{time:bar.date}:{time:bar.date,value:plot.values[i]!,...(plot.histogram?{color:plot.values[i]!>=0?CHART_PALETTE.volumeUp:CHART_PALETTE.volumeDown}:{})});
  }
  /** New candles: a replay step appends one point per line; anything else redraws from the store. */
  private updateStudies(appended=false) {
    if(!appended) {this.setStudies(this.studies);return;}
    // A shared store already holds the full history; an engine's own store recomputes for the new prefix.
    const plots=this.ownStudyStore?this.studyPlots():this.studyPlotList;
    const index=this.candles.length-1,bar=this.candles[index];
    for(const plot of plots) {
      const entry=this.studyEntries.get(plot.key);
      if(!entry) continue;
      entry.values=plot.values;
      const value=plot.values[index];
      entry.series.update(value===null||value===undefined?{time:bar.date}:{time:bar.date,value,...(plot.histogram?{color:value>=0?CHART_PALETTE.volumeUp:CHART_PALETTE.volumeDown}:{})});
      entry.candles=this.candles;
    }
    this.studyPlotList=plots;
  }
  setOnPanesChange(cb:()=>void) { this.onPanesChange=cb; }
  private updatePaneObservers() {
    if(typeof ResizeObserver==='undefined') return;
    if(!this.paneObserver) {
      this.paneObserver=new ResizeObserver(()=>{this.notifyPanesChange();});
    } else {
      this.paneObserver.disconnect();
    }
    const panes=this.chart.panes();
    for(const p of panes) {
      const el=typeof p.getHTMLElement==='function'?p.getHTMLElement():null;
      if(el) this.paneObserver.observe(el);
    }
  }
  notifyPanesChange() {
    this.attachEventStrip();
    this.onPanesChange?.();
    if(typeof requestAnimationFrame!=='undefined') {
      requestAnimationFrame(()=>{
        this.onPanesChange?.();
        requestAnimationFrame(()=>{
          this.onPanesChange?.();
        });
      });
    }
    if(typeof setTimeout!=='undefined') {
      setTimeout(()=>this.onPanesChange?.(),40);
    }
  }
  getPaneOffsets():Array<{paneIndex:number;top:number;height:number}> {
    const panes=this.chart.panes();
    if(!panes||panes.length===0) return [];
    const hostRect=this.host?.getBoundingClientRect?.();
    const totalHeight=hostRect?.height&&hostRect.height>0?hostRect.height:(this.chart.paneSize?this.chart.paneSize().height:500);

    // 1. Try real DOM element bounding boxes first (pixel-perfect)
    if(hostRect&&hostRect.height>0) {
      let domValid=true;
      const domOffsets:Array<{paneIndex:number;top:number;height:number}>=[];
      for(let i=0;i<panes.length;i++) {
        const el=typeof panes[i].getHTMLElement==='function'?panes[i].getHTMLElement():null;
        if(!el) {domValid=false;break;}
        const r=el.getBoundingClientRect();
        if(r.height<=0) {domValid=false;break;}
        domOffsets.push({
          paneIndex:i,
          top:Math.max(0,Math.round(r.top-hostRect.top)),
          height:Math.round(r.height),
        });
      }
      if(domValid&&domOffsets.length===panes.length) {
        return domOffsets;
      }
    }

    // 2. Check if pane heights from getHeight() are already allocated
    const heights=panes.map(p=>(typeof p.getHeight==='function'?p.getHeight():0));
    const hasUnallocated=panes.length>1&&(heights.some(h=>h===0)||heights[0]>=totalHeight-10);

    if(hasUnallocated) {
      // Immediate calculation from stretch factors so new panes NEVER jump to the bottom!
      const weights=panes.map((p,idx)=>{
        const sf=typeof p.getStretchFactor==='function'?p.getStretchFactor():(idx===0?1:0.3);
        return sf>0?sf:(idx===0?1:0.3);
      });
      const totalWeight=weights.reduce((a,b)=>a+b,0);
      let top=0;
      const estOffsets:Array<{paneIndex:number;top:number;height:number}>=[];
      for(let i=0;i<panes.length;i++) {
        const h=Math.round((weights[i]/totalWeight)*totalHeight);
        estOffsets.push({paneIndex:i,top,height:h});
        top+=h;
      }
      return estOffsets;
    }

    // 3. Fallback: accumulate getHeight()
    let top=0;
    const offsets:Array<{paneIndex:number;top:number;height:number}>=[];
    for(let i=0;i<panes.length;i++) {
      const height=heights[i];
      offsets.push({paneIndex:i,top,height});
      top+=height;
    }
    return offsets;
  }
  getPanesCount(): number {
    return this.chart.panes()?.length ?? 0;
  }
  getPaneElement(paneIndex: number): HTMLElement | null {
    const panes = this.chart.panes();
    if (!panes || paneIndex < 0 || paneIndex >= panes.length) return null;
    const p = panes[paneIndex];
    const row = typeof p.getHTMLElement === 'function' ? p.getHTMLElement() : null;
    if (!row) return null;
    return (row.querySelector('td > div') as HTMLElement) || (row.querySelector('div') as HTMLElement) || row;
  }
  getStudyPaneIndex(studyId:string):number {
    if(studyId==='price') return 0;
    if(studyId==='volume') {
      return this.currentAppearance?.volumePane&&this.currentAppearance?.volume
        ? this.volumeSeries.getPane().paneIndex()
        : 0;
    }
    const seriesList=this.studySeriesByPane.get(studyId);
    if(seriesList&&seriesList.length>0) {
      return seriesList[0].getPane().paneIndex();
    }
    return -1;
  }
  movePane(paneIndex:number,direction:'up'|'down') {
    const panes=this.chart.panes();
    const target=direction==='up'?paneIndex-1:paneIndex+1;
    if(target>=0&&target<panes.length) {
      panes[paneIndex].moveTo(target);
      this.updatePaneObservers();
      this.notifyPanesChange();
    }
  }
  maximizePane(paneIndex:number) {
    const panes=this.chart.panes();
    if(this.maximizedPane===paneIndex) {
      this.maximizedPane=null;
      panes[0].setStretchFactor(1);
      for(let i=1;i<panes.length;i++) panes[i].setStretchFactor(.3);
    } else {
      this.maximizedPane=paneIndex;
      for(let i=0;i<panes.length;i++) {
        panes[i].setStretchFactor(i===paneIndex?6:.05);
      }
    }
    this.updatePaneObservers();
    this.notifyPanesChange();
  }
  private fundamentalsVisible = true;
  setStudyVisibility(studyId:string,visible:boolean) {
    if (studyId === 'fundamentals') {this.fundamentalsVisible = visible; this.refreshMarkers(); return;}
    if(studyId==='volume') {
      this.volumeSeries.applyOptions({visible,lastValueVisible:visible&&this.volumeSeries.getPane().paneIndex()!==0});
      this.volumeVisible=visible;this.syncVolumeAverage();
      return;
    }
    const seriesList=this.studySeriesById.get(studyId)??this.studySeriesByPane.get(studyId);
    if(seriesList) {
      for(const s of seriesList) s.applyOptions({visible});
    }
  }
  syncCrosshair(time:Time|undefined) {
    // Aggregated W/M bars use their first session as the timestamp. Snap to
    // the latest available bar at or before the source date, never a future bar.
    let bar:Candle|undefined;
    if(time!==undefined) {
      const date=this.dateString(time);
      let low=0,high=this.candles.length;
      while(low<high) {const mid=(low+high)>>>1;if(this.candles[mid].date<=date) low=mid+1;else high=mid;}
      bar=this.candles[low-1];
    }
    if(bar) {this.chart.setCrosshairPosition(bar.close,bar.date,this.price);this.inspect(bar);}
    else {this.chart.clearCrosshairPosition();this.inspect(this.candles.at(-1)!);}
  }
  setComparison(symbol:string,candles:readonly Candle[],separate=false) {
    if(this.comparison) this.chart.removeSeries(this.comparison);
    this.comparison=null;this.comparisonData=candles;this.comparisonSeparate=separate;
    if(symbol&&candles.length) {
      this.comparison=this.chart.addSeries(LineSeries,{color:'#e09b26',lineWidth:2,title:symbol,priceScaleId:'right',priceLineVisible:false},separate?this.chart.panes().length:0);
      if(separate) this.comparison.getPane().setStretchFactor(.4);
      this.updateComparison();
    }
    this.chart.priceScale('right').applyOptions({mode:this.comparison&&!separate?PriceScaleMode.Percentage:scaleModes[this.scaleMode]});
  }
  private updateComparison() {
    // Exact date intersection prevents comparison-only sessions from shifting the replay indices.
    const dates=new Set(this.candles.map(bar=>bar.date));
    this.comparison?.setData(this.comparisonData.filter(bar=>dates.has(bar.date)).map(bar=>({time:bar.date,value:bar.close})));
  }
  private projection():DrawingProjection|null {
    if(!this.times.length) return null;
    const size=this.chart.paneSize(),scale=this.chart.timeScale(),series=this.activeSeries();
    return {width:size.width,top:0,bottom:size.height,firstTime:this.times[0],lastTime:this.times.at(-1)!,bars:this.drawingBars,
      toPixel:anchor=>{const logical=timeIndex(this.times,anchor.time);return {x:(Number.isInteger(logical)&&this.times[logical]===anchor.time?scale.timeToCoordinate(new Date(anchor.time).toISOString().slice(0,10)):null)??scale.logicalToCoordinate(logical as Logical)??-10000,y:series.priceToCoordinate(anchor.price)??-10000};},
      toAnchor:point=>{const time=scale.coordinateToTime(point.x);return {time:time?Date.parse(this.dateString(time)):indexTime(this.times,Math.round(scale.coordinateToLogical(point.x)??0)),price:series.coordinateToPrice(point.y)??0};},
    };
  }
  private point(event:MouseEvent):Pixel {const rect=this.host.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};}
  private down=(event:PointerEvent)=>{
    this.blockMouse=false;if(event.button!==0) return;
    this.keyTarget.focus({preventScroll:true});const point=this.point(event),projection=this.projection();
    if(!projection || point.x>projection.width || point.y>projection.bottom) return;
    if(this.replayPicker) return;
    // Shift + drag measures; a plain click clears the last measurement.
    if(event.shiftKey&&this.book.getSnapshot().tool==='select'&&point.y<=this.chart.paneSize(0).height) {
      const logical=this.chart.timeScale().coordinateToLogical(point.x),price=this.activeSeries().coordinateToPrice(point.y);
      if(logical!==null&&price!==null) {
        const at={logical:Math.round(logical),price};
        this.measure={from:at,to:{...at}};this.measurePointer=event.pointerId;this.blockMouse=true;
        this.host.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();this.invalidate();
        return;
      }
    }
    if(this.measure) {this.measure=null;this.invalidate();}
    this.dragStart={y:event.clientY,auto:this.isAutoScale()};
    if(this.layer.down(point,event.pointerId)) {
      this.drawingPointer=event.pointerId;this.blockMouse=true;this.host.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();
    }
  };
  private move=(event:PointerEvent)=>{
    if(this.replayPicker) return;
    if(this.measurePointer===event.pointerId&&this.measure) {
      const point=this.point(event),logical=this.chart.timeScale().coordinateToLogical(point.x),price=this.activeSeries().coordinateToPrice(point.y);
      if(logical!==null&&price!==null) {this.measure={...this.measure,to:{logical:Math.round(logical),price}};this.invalidate();}
      event.stopPropagation();return;
    }
    if(this.layer.move(this.point(event),event.pointerId)) {event.stopPropagation();}
  };
  private up=(event:PointerEvent)=>{
    if(this.measurePointer===event.pointerId) {
      this.measurePointer=null;this.blockMouse=false;
      if(this.host.hasPointerCapture(event.pointerId)) this.host.releasePointerCapture(event.pointerId);
      return;
    }
    // A drag that barely moved vertically should not have switched auto-fit off (3px wobble, as in TradingView).
    const start=this.dragStart;this.dragStart=null;
    if(start?.auto&&Math.abs(event.clientY-start.y)<=3&&!this.isAutoScale()) this.setAutoScale(true);
    if(this.drawingPointer!==event.pointerId) return;
    this.layer.up(this.point(event),event.pointerId);this.drawingPointer=null;
    if(this.host.hasPointerCapture(event.pointerId)) this.host.releasePointerCapture(event.pointerId);
  };
  private cancelPointer=()=>{this.layer.cancelPointer();this.drawingPointer=null;this.blockMouse=false;};
  private crosshair=(event:MouseEventParams<Time>)=>{
    const logical=event.logical===undefined||!event.point||(event.paneIndex??0)!==0?null:Math.round(event.logical);
    if(logical!==this.crosshairLogical) {this.crosshairLogical=logical;this.invalidate();}
    if(this.replayPicker&&event.logical!==undefined) {this.replayIndex=Math.max(0,Math.min(this.candles.length-1,Math.round(event.logical)));this.invalidate();}
    const data=event.seriesData.get(this.activeSeries());
    const time=data?.time;
    const date=time===undefined?undefined:this.dateString(time);
    const bar=date?this.byDate.get(date):this.candles.at(-1);if(bar) this.inspect(bar);
    this.syncEventHover(event);
  };
  private dateString(time:Time) {return typeof time==='string'?time:typeof time==='number'?new Date(time*1000).toISOString().slice(0,10):`${time.year}-${String(time.month).padStart(2,'0')}-${String(time.day).padStart(2,'0')}`;}
  private click=(event:MouseEventParams<Time>)=>{
    if(this.replayPicker&&event.logical!==undefined&&event.point&&event.point.y<=this.chart.paneSize(0).height) this.pickReplay(Math.max(0,Math.min(this.candles.length-1,Math.round(event.logical))));
    else {
      // Event badges live in the lowest pane; resolve the click there as well as through hit testing.
      const lowest=(this.chart.panes?.().length??1)-1;
      const hit=typeof event.hoveredObjectId==='string'?event.hoveredObjectId
        :event.point&&(event as {paneIndex?:number}).paneIndex===lowest?this.eventStripHit(event.point.x,event.point.y)?.externalId:undefined;
      const events=hit?this.markerEvents.get(hit):undefined;
      if(events) {this.hoveredEvent=null;this.eventHover(null);this.inspectEvents(events);}
    }
  };
  setReplayPicker(pick:((index:number)=>void)|null,cancel:()=>void=()=>{}) {
    this.layer.cancel();this.replayPicker=pick?{pick,cancel}:null;
    const range=this.chart.timeScale().getVisibleLogicalRange();this.replayIndex=Math.max(0,Math.min(this.candles.length-1,Math.round(range?(range.from+range.to)/2:0)));
    this.chart.applyOptions({handleScroll:this.scrollOptions()});this.invalidate();
  }
  /**
   * TradingView's wheel: vertical scroll zooms with the right edge fixed, a sideways swipe
   * (or Shift + wheel) pans through time, and a trackpad pinch (Ctrl + wheel) zooms.
   */
  private wheel=(event:WheelEvent)=>{
    const appearance=this.currentAppearance;
    if(this.replayPicker||!this.candles.length) return;
    const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange(),width=scale.width();
    if(!range||width<=0) return;
    const unit=event.deltaMode===1?16:event.deltaMode===2?width:1;
    // Over the price axis, the wheel stretches prices around the pointer, as in TradingView.
    const rect=this.host.getBoundingClientRect(),pointX=event.clientX-rect.left,pointY=event.clientY-rect.top;
    if(pointX>width&&pointY<this.chart.paneSize(0).height&&!event.shiftKey) {
      const priceScale=this.chart.priceScale('right'),visible=priceScale.getVisibleRange?.(),anchor=this.activeSeries().coordinateToPrice(pointY);
      if(!visible||anchor===null||appearance?.zoomEnabled===false) return;
      event.preventDefault();
      const factor=Math.exp(event.deltaY*unit*WHEEL_ZOOM_RATE);
      priceScale.applyOptions({autoScale:false});
      priceScale.setVisibleRange({from:anchor+(visible.from-anchor)*factor,to:anchor+(visible.to-anchor)*factor});
      return;
    }
    const dx=(event.shiftKey&&!event.deltaX?event.deltaY:event.deltaX)*unit,dy=(event.shiftKey?0:event.deltaY)*unit;
    const bars=range.to-range.from;
    if(Math.abs(dx)>Math.abs(dy)) {
      if(appearance?.panEnabled===false) return;
      event.preventDefault();
      const shift=dx/(width/bars);
      scale.setVisibleLogicalRange({from:range.from+shift,to:range.to+shift});
      return;
    }
    if(!dy||appearance?.zoomEnabled===false) return;
    event.preventDefault();
    // Pinch gestures arrive as ctrl+wheel with small deltas; scale them up to feel the same.
    const factor=Math.exp(dy*WHEEL_ZOOM_RATE*(event.ctrlKey?4:1));
    const count=Math.max(5,Math.min(this.candles.length*1.5+RIGHT_EDGE_BARS,bars*factor));
    scale.setVisibleLogicalRange({from:range.to-count,to:range.to});
  };
  /** Price-scale auto-fit (TradingView's "A"); dragging the price axis turns it off. */
  isAutoScale() {return this.chart.priceScale('right').options().autoScale!==false;}
  setAutoScale(on:boolean) {this.chart.priceScale('right').applyOptions({autoScale:on});}
  private scrollOptions() {
    return !this.replayPicker && this.book.getSnapshot().tool==='select' && this.currentAppearance?.panEnabled!==false
      ? (this.currentAppearance?.mousePan==='horizontal'?{...SCROLL_WITHOUT_WHEEL,vertTouchDrag:false}:SCROLL_WITHOUT_WHEEL) : false;
  }
  /** Ctrl/⌘ + C copies the selected drawing, V pastes it a few bars later, D duplicates it. */
  private drawingClipboardKey(event:KeyboardEvent) {
    if(!(event.ctrlKey||event.metaKey)||event.altKey) return false;
    const key=event.key.toLowerCase(),state=this.book.getSnapshot(),selected=state.drawings.find(item=>item.id===state.selectedId);
    if(key==='c'&&selected) {drawingClipboard=selected;event.preventDefault();return true;}
    if((key==='v'&&drawingClipboard)||(key==='d'&&selected)) {
      const source=key==='d'?selected!:drawingClipboard!;
      const gap=this.times.length>1?(this.times.at(-1)!-this.times[0])/(this.times.length-1):86_400_000;
      const shift=(anchor:{time:number;price:number})=>({...anchor,time:anchor.time+gap*5});
      this.book.addPoints(source.kind,(source.points??[source.a,source.b]).map(shift));
      const added=this.book.getSnapshot().selectedId;
      if(added) this.book.update(added,{color:source.color,width:source.width,dash:source.dash,text:source.text,levels:source.levels});
      event.preventDefault();return true;
    }
    return false;
  }
  private pickReplay(index:number) {const picker=this.replayPicker;this.setReplayPicker(null);picker?.pick(index);}
  private key=(event:KeyboardEvent)=>{
    if(event.defaultPrevented) return;
    if(this.replayPicker && ['Escape','Enter','ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();event.stopPropagation();
      if(event.key==='Escape') {const cancel=this.replayPicker.cancel;this.setReplayPicker(null);cancel();}
      else if(event.key==='Enter') this.pickReplay(this.replayIndex);
      else {
        this.replayIndex=Math.max(0,Math.min(this.candles.length-1,this.replayIndex+(event.key==='ArrowLeft'?-1:1)));
        const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange();
        if(range && (this.replayIndex<range.from || this.replayIndex>range.to)) {const delta=this.replayIndex<range.from?this.replayIndex-range.from:this.replayIndex-range.to;scale.setVisibleLogicalRange({from:range.from+delta,to:range.to+delta});}
        this.invalidate();
      }
      return;
    }
    if(event.key==='Escape'&&this.measure) {event.preventDefault();this.measure=null;this.invalidate();return;}
    if(this.drawingClipboardKey(event)) return;
    if(this.layer.key(event)) return;
    if(!['Home','+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const command=event.ctrlKey||event.metaKey;
    if(event.key==='Home') this.reset();
    else if(event.key==='ArrowLeft'||event.key==='ArrowRight') {
      // Two bars a press, ten with Ctrl/⌘, as in TradingView.
      const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange();
      if(range){const delta=(command?10:2)*(event.key==='ArrowLeft'?-1:1);scale.setVisibleLogicalRange({from:range.from+delta,to:range.to+delta});}
    }
    else if(event.key==='ArrowUp'||event.key==='ArrowDown') {
      const priceScale=this.chart.priceScale('right'),visible=priceScale.getVisibleRange?.();
      if(visible){const delta=(visible.to-visible.from)*.1*(event.key==='ArrowUp'?1:-1);priceScale.applyOptions({autoScale:false});priceScale.setVisibleRange({from:visible.from+delta,to:visible.to+delta});}
    }
    else this.zoom(event.key==='-'?1.25:.8);
    this.describeLatestVisible();
  };
  private keyTarget!:HTMLElement;
  private keyEvents=new AbortController();
  /** The focusable element that takes keyboard shortcuts: the scene's container, wherever the canvas lives. */
  setKeyTarget(target:HTMLElement) {
    this.keyEvents.abort();this.keyEvents=new AbortController();this.keyTarget=target;
    target.addEventListener('keydown',this.key,{signal:this.keyEvents.signal,capture:true});
  }
  private watchBook() {return this.book.subscribe(()=>{this.chart.applyOptions({handleScroll:this.scrollOptions()});});}
  /**
   * Shows another symbol or interval on this chart. Panes, indicator series and settings are kept, so a switch
   * only replaces data instead of tearing the chart down and rebuilding every pane (the slow part of a switch).
   * The caller re-applies the new symbol's overlays (events, bands, comparison, view) right after.
   */
  adopt(candles:readonly Candle[],inspect:(bar:Candle)=>void,book:DrawingBook,inspectEvents:(events:readonly ChartEvent[])=>void=()=>{}) {
    this.inspect=inspect;this.inspectEvents=inspectEvents;
    if(book!==this.book) {
      this.unsubscribe();this.layer.destroy();
      this.book=book;this.layer=new DrawingLayer(book,()=>this.projection(),()=>this.invalidate());
      this.unsubscribe=this.watchBook();
      this.chart.applyOptions({handleScroll:this.scrollOptions()});
    }
    // Nothing from the previous symbol may show on the new one.
    this.eventData=[];this.bandChanges=[];this.upcomingEarnings=null;this.sizingLines={lines:[],offset:3,length:4};
    this.setPriceBandGuides([]);this.setComparison('',[]);
    this.measure=null;this.measurePointer=null;this.replayPicker=null;this.hoveredEvent=null;this.eventHover(null);
    this.setCandles(candles);
    this.latest();
  }
  /** Detaches the previous scene's callbacks while the engine waits to be adopted. */
  park() {
    this.onPanesChange=undefined;this.eventHover=()=>{};this.inspect=()=>{};this.inspectEvents=()=>{};
    this.announce=()=>{};this.replayPicker=null;
  }
  destroy() {
    if(this.disposed) return;this.disposed=true;
    this.hostObserver?.disconnect();
    this.paneObserver?.disconnect();
    this.events.abort();this.keyEvents.abort();this.theme.disconnect();this.unsubscribe();this.layer.destroy();
    cancelAnimationFrame(this.highLowFrame);this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onVisibleRange);
    this.chart.unsubscribeCrosshairMove(this.crosshair);this.chart.unsubscribeClick(this.click);this.markers.detach();this.chart.remove();
  }
}
