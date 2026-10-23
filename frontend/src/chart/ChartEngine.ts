import {
  AreaSeries, BaselineSeries, BarSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries,
  LineStyle, LineType, PriceScaleMode, createChart, createSeriesMarkers, createTextWatermark,
  type IChartApi, type IPrimitivePaneView, type ISeriesApi, type ISeriesPrimitive, type ITextWatermarkPluginApi,
  type IPriceLine, type ISeriesMarkersPluginApi, type SeriesMarker, type LineWidth, type Logical, type MouseEventParams, type SeriesAttachedParameter, type Time,
} from 'lightweight-charts';
import { ema, validEmaLine, type Candle, type EmaLine } from './model';
import { DrawingBook, hitDrawing, indexTime, timeIndex, type DrawingProjection, type Pixel } from './drawings';
import { DrawingLayer } from './DrawingLayer';
import { rsi, macd, sma, bollinger, atr, stochastic, monthlyVwap, supertrend, defaultStudies, getPriceSource, type ChartStudies } from './studies';
import { computeExtraStudies, enabledExtraStudies, studyLineColor, studyParams, studyTitle } from './extraStudies';
export type { ChartStudies } from './studies';
import { type StudyConfigs } from './studyConfigs';
export type { StudyConfigs } from './studyConfigs';
import type { ChartEvent } from './events';

// Match the reference screener's native candle and bar palette.
export const CHART_PALETTE = {up:'#089981',down:'#ef5350',volumeUp:'rgba(8,153,129,0.5)',volumeDown:'rgba(239,83,80,0.5)'};
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
  statusLogo?:boolean;
  statusTitle?:boolean;
  statusTitleMode?:'symbol'|'description'|'ticker';
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
  scaleTextColor?:string;
  scaleFontSize?:number;
  /** Last-value label on the price scale. */
  lastValueLabel?:boolean;
};
const scaleModes = {normal:PriceScaleMode.Normal,logarithmic:PriceScaleMode.Logarithmic,percentage:PriceScaleMode.Percentage,indexed:PriceScaleMode.IndexedTo100};
const withAlpha = (hex:string,opacity:number) => `${hex}${Math.round(opacity*255).toString(16).padStart(2,'0')}`;
const RIGHT_EDGE_BARS = 6;
const RIGHT_EDGE_PIXELS = 32;
const SCROLL_WITHOUT_WHEEL = {mouseWheel:false,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:true} as const;
const SCALE_WITH_WHEEL = {mouseWheel:true,pinch:true,axisPressedMouseMove:true,axisDoubleClickReset:true} as const;

/** Native TradingView rendering and navigation; Nexus owns data, tools and replay. */
export class ChartEngine {
  readonly chart:IChartApi;
  private price:ISeriesApi<'Candlestick'|'Bar'|'Line'|'Area'|'Baseline'>;
  private currentAppearance?:ChartAppearance;
  private watermarkPlugin?:ITextWatermarkPluginApi<Time>;
  private volumeSeries:ISeriesApi<'Histogram'>;
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
  private eventData:readonly ChartEvent[]=[];
  private eventCutoff='';
  private showEvents=false;
  private markerEvents=new Map<string,ChartEvent[]>();
  private studies:ChartStudies=defaultStudies();
  private studyConfigs:StudyConfigs={};
  private studySeries:ISeriesApi<'Line'|'Histogram'>[]=[];
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
      layout:{fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',fontSize:11,attributionLogo:false,panes:{enableResize:true}},
      rightPriceScale:{borderVisible:false,scaleMargins:{top:.13,bottom:.22}},
      timeScale:{borderVisible:false,rightOffset:RIGHT_EDGE_BARS,rightOffsetPixels:RIGHT_EDGE_PIXELS,barSpacing:8,fixLeftEdge:false,lockVisibleTimeRangeOnResize:true,shiftVisibleRangeOnNewBar:true},
      crosshair:{mode:CrosshairMode.Normal},
      localization:{locale:'en-IN'},
      kineticScroll:{mouse:true,touch:true},
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
        if (this.replayPicker) {
          const x=this.chart.timeScale().logicalToCoordinate(this.replayIndex as Logical);
          if(x===null) return;
          context.save();context.strokeStyle=this.accent;context.lineWidth=1;context.setLineDash([4,3]);
          context.beginPath();context.moveTo(x,0);context.lineTo(x,projection.bottom);context.stroke();context.restore();
        }
      });
    }})}];
    this.primitive={attached:({requestUpdate}:SeriesAttachedParameter)=>{this.invalidate=()=>{this.syncPriceLines();requestUpdate();};},paneViews:()=>paneViews,
      hitTest:(x,y)=>{const p=this.projection(),state=book.getSnapshot();const hit=p&&!state.hideAll?hitDrawing(state.drawings,{x,y},p,state.selectedId):null;return hit?{externalId:hit.drawing.id,zOrder:'top',cursorStyle:hit.handle!==null?'crosshair':'move'}:null;},
      priceAxisViews:()=>this.axisViews('price'),timeAxisViews:()=>this.axisViews('time'),
    };
    this.price.attachPrimitive(this.primitive);
    this.markers=createSeriesMarkers(this.price,[],{autoScale:false});
    this.setData();
    this.chart.subscribeCrosshairMove(this.crosshair);
    this.chart.subscribeClick(this.click);
    this.theme=new MutationObserver(()=>this.readTheme());
    this.theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    this.readTheme();
    this.unsubscribe=book.subscribe(()=>{this.chart.applyOptions({handleScroll:this.scrollOptions()});});
    const options={signal:this.events.signal,capture:true};
    host.addEventListener('pointerdown',this.down,options);
    host.addEventListener('pointermove',this.move,options);
    host.addEventListener('pointerup',this.up,options);
    host.addEventListener('pointercancel',this.cancelPointer,options);
    host.addEventListener('lostpointercapture',this.cancelPointer,options);
    // Lightweight Charts uses mouse/touch events; suppress only gestures owned by the drawing layer.
    host.addEventListener('mousedown',event=>{if(this.blockMouse){event.preventDefault();event.stopPropagation();}},options);
    host.addEventListener('touchstart',event=>{if(this.blockMouse){event.preventDefault();event.stopPropagation();}},{...options,passive:false});
    host.addEventListener('keydown',this.key,options);
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
    const common={priceLineVisible:a?.priceLineVisible!==false,lastValueVisible:a?.lastValueLabel!==false};
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
    this.chart.applyOptions({
      layout:{background:{type:ColorType.Solid,color:token('chart-background',token('surface','#ffffff'))},textColor:token('muted','#787b86'),panes:{separatorColor:token('line','#e8e8ed'),separatorHoverColor:token('line-strong','#d2d2d7')}},
      grid:{vertLines:{color:token('chart-grid','#f0f0f0')},horzLines:{color:token('chart-grid','#f0f0f0')}},
      crosshair:{vertLine:{color:token('chart-crosshair','#aab8c5'),labelBackgroundColor:token('text','#131722')},horzLine:{color:token('chart-crosshair','#aab8c5'),labelBackgroundColor:token('text','#131722')}},
    });
    // Theme tokens are defaults; the user's own colours win.
    if(this.currentAppearance) this.applyAppearanceColors(this.currentAppearance);
    else this.price.applyOptions(this.priceOptions());
    this.invalidate();
  }
  private volumeData(bar:Candle) {
    if(bar.volume===null) return {time:bar.date};
    const color=bar.close>=bar.open
      ? (this.studyConfigs.volume?.upColor ? withAlpha(this.studyConfigs.volume.upColor,.5) : CHART_PALETTE.volumeUp)
      : (this.studyConfigs.volume?.downColor ? withAlpha(this.studyConfigs.volume.downColor,.5) : CHART_PALETTE.volumeDown);
    return {time:bar.date,value:bar.volume,color};
  }
  private setData() {
    this.setPriceData();
    this.volumeSeries.setData(this.candles.map(bar=>this.volumeData(bar)));
    for(const {series,line} of this.averages.values()) this.setEmaData(series,line);
  }
  private isBarType():boolean {
    return ['candles','hollowCandles','volumeCandles','bars','highLow'].includes(this.style);
  }
  private priceData(bar:Candle) {
    return this.isBarType()
      ? {time:bar.date,open:bar.open,high:bar.high,low:bar.low,close:bar.close}
      : {time:bar.date,value:this.style==='hlcArea'?(bar.high+bar.low+bar.close)/3:bar.close};
  }
  private setPriceData() {this.price.setData(this.candles.map(bar=>this.priceData(bar)));}
  private setEmaData(series:ISeriesApi<'Line'>,line:EmaLine) {
    const values=ema(this.candles,line.period);
    series.setData(this.candles.map((bar,index)=>values[index]===null?{time:bar.date}:{time:bar.date,value:values[index]!}));
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
    this.activeSeries().detachPrimitive(this.primitive);
    const previous=this.price;
    this.style=style;
    const order=previous.seriesOrder();
    this.price=this.createPriceSeries();this.setPriceData();this.price.setSeriesOrder(order);this.chart.removeSeries(previous);
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
        fontSize:Math.max(9,Math.min(16,Math.round(appearance.scaleFontSize??11))),
      },
      grid:{
        horzLines:appearance.horzGridColor?{color:appearance.horzGridColor}:{},
        vertLines:appearance.vertGridColor?{color:appearance.vertGridColor}:{},
      },
    });
    this.price.applyOptions(this.priceOptions());
  }
  setAppearance(appearance:ChartAppearance) {
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
          labelVisible:appearance.crosshair,
          ...(appearance.crosshairTransparency !== undefined
            ? { color: withAlpha(appearance.crosshairColor || '#aab8c5', Math.max(0, Math.min(1, 1 - appearance.crosshairTransparency / 100))) }
            : appearance.crosshairColor ? { color: appearance.crosshairColor } : {}),
          style:toLwcLineStyle(appearance.crosshairStyle),
        },
        horzLine:{
          visible:appearance.crosshair,
          labelVisible:appearance.crosshair,
          ...(appearance.crosshairTransparency !== undefined
            ? { color: withAlpha(appearance.crosshairColor || '#aab8c5', Math.max(0, Math.min(1, 1 - appearance.crosshairTransparency / 100))) }
            : appearance.crosshairColor ? { color: appearance.crosshairColor } : {}),
          style:toLwcLineStyle(appearance.crosshairStyle),
        },
      },
      handleScroll:this.scrollOptions(),
      handleScale:appearance.zoomEnabled!==false?SCALE_WITH_WHEEL:false,
    });

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
      this.price.update(this.priceData(bar));
      this.volumeSeries.update(this.volumeData(bar));
      for(const {series,line} of this.averages.values()) {
        const value=ema(candles,line.period).at(-1);
        series.update(value===null || value===undefined?{time:bar.date}:{time:bar.date,value});
      }
    } else if(shortened) {
      const count=previous.length-candles.length;
      for(const series of [this.price,this.volumeSeries,...[...this.averages.values()].map(entry=>entry.series),...this.studySeries]) series.pop(count);
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
    for(const event of this.showEvents?this.eventData:[]) {
      if(event.date>this.eventCutoff||event.date<this.candles[0].date) continue;
      // Events fall on the closed aggregate containing them; daily holidays use the preceding session.
      let low=0,high=this.candles.length;
      while(low<high) {const mid=(low+high)>>>1;if(this.candles[mid].date<=event.date) low=mid+1;else high=mid;}
      const time=this.candles[Math.max(0,low-1)].date,key=`events:${time}`,entry=this.markerEvents.get(key);
      if(entry) entry.push(event);else this.markerEvents.set(key,[event]);
    }
    this.markers.setMarkers([...this.markerEvents].sort(([a],[b])=>a.localeCompare(b)).map(([id,events]):SeriesMarker<Time>=>({id,time:id.slice(7),position:'belowBar',shape:'circle',color:events.some(event=>event.kind==='earnings')?'#049981':events.some(event=>event.kind==='action')?'#f59e0b':'#187669',size:.6})));
  }
  /** Benchmark closes by session date, for relative-strength studies. Rebuild with setStudies after changing. */
  setBenchmark(benchmark:ReadonlyMap<string,number>|undefined) { this.benchmark=benchmark; }
  setStudyConfigs(configs:StudyConfigs) {
    // The caller applies the new visibility with setStudies immediately after.
    // Rebuilding here would create and remove every native series twice.
    const previous=this.studyConfigs.volume;
    this.studyConfigs=configs;
    if(previous?.upColor!==configs.volume?.upColor || previous?.downColor!==configs.volume?.downColor) {
      this.volumeSeries.setData(this.candles.map(bar=>this.volumeData(bar)));
    }
  }
  setStudies(studies:Partial<ChartStudies>) {
    for(const series of this.studySeries) this.chart.removeSeries(series);
    this.studySeries=[];this.studySeriesByPane.clear();this.studySeriesById.clear();this.studies={...defaultStudies(),...studies};
    const panes=new Map<string,number>();
    const plots=this.studyPlots();
    for(const plot of plots) {
      if(plot.pane!=='price'&&!panes.has(plot.pane)) panes.set(plot.pane,this.chart.panes().length);
      const pane=plot.pane==='price'?0:panes.get(plot.pane)!;
      const series=this.chart.addSeries(plot.histogram?HistogramSeries:LineSeries,{
        color:plot.color,
        lineWidth:(plot.lineWidth??1) as LineWidth,
        lineStyle:plot.lineStyle??LineStyle.Solid,
        title:plot.title,
        priceLineVisible:false,
        lastValueVisible:!plot.histogram&&!plot.dots,
        ...(plot.dots?{lineVisible:false,pointMarkersVisible:true,pointMarkersRadius:1.5}:{})
      },pane);
      if(plot.pane!=='price') series.getPane().setStretchFactor(.3);
      for(const level of plot.levels??[]) {
        series.createPriceLine({
          price:level.price,
          color:level.color??'#aab8c5',
          lineWidth:1 as LineWidth,
          lineStyle:level.lineStyle??LineStyle.Dashed,
          axisLabelVisible:true
        });
      }
      this.studySeries.push(series);
      if(plot.id) {
        if(!this.studySeriesById.has(plot.id)) this.studySeriesById.set(plot.id,[]);
        this.studySeriesById.get(plot.id)!.push(series);
      }
      if(!this.studySeriesByPane.has(plot.pane)) this.studySeriesByPane.set(plot.pane,[]);
      this.studySeriesByPane.get(plot.pane)!.push(series);
    }
    this.updateStudies(false,plots);
    this.updatePaneObservers();
    this.notifyPanesChange();
  }
  private studyPlots() {
    const toLineStyle=(s?:string)=>s==='dashed'?LineStyle.Dashed:s==='dotted'?LineStyle.Dotted:LineStyle.Solid;
    const plots:Array<{
      title:string;
      color:string;
      values:(number|null)[];
      pane:string;
      histogram?:boolean;
      lineWidth?:number;
      lineStyle?:LineStyle;
      levels?:Array<{price:number;color?:string;lineStyle?:LineStyle}>;
      id?:string;
      dots?:boolean;
    }>=[];
    const add=(title:string,color:string,values:(number|null)[],pane='price',lineWidth=1,lineStyle=LineStyle.Solid,levels?:Array<{price:number;color?:string;lineStyle?:LineStyle}>)=>plots.push({title,color,values,pane,lineWidth,lineStyle,levels});

    if(this.studies.rsi) {
      const cfg=this.studyConfigs.rsi;
      const period=cfg?.period??14;
      const source=cfg?.source??'close';
      const levels=cfg?.bandsVisible!==false?[
        {price:cfg?.oversold??30,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
        {price:cfg?.overbought??70,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
      ]:undefined;
      if(cfg?.lineVisible!==false) {
        add(`RSI ${period}`,cfg?.color??'#8b5cf6',rsi(this.candles,period,source),'rsi',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle),levels);
      }
    }
    if(this.studies.macd) {
      const cfg=this.studyConfigs.macd;
      const fast=cfg?.fast??12,slow=cfg?.slow??26,signal=cfg?.signal??9;
      const source=cfg?.source??'close';
      const values=macd(this.candles,fast,slow,signal,source);
      if(cfg?.macdVisible!==false) {
        add(`MACD ${fast}/${slow}`,cfg?.macdColor??this.accent,values.line,'macd',cfg?.macdWidth??1,toLineStyle(cfg?.macdStyle));
      }
      if(cfg?.signalVisible!==false) {
        add(`Signal ${signal}`,cfg?.signalColor??'#f59e0b',values.signal,'macd',cfg?.signalWidth??1,toLineStyle(cfg?.signalStyle));
      }
      if(cfg?.histVisible!==false) {
        plots.push({title:'MACD histogram',color:cfg?.histColor??CHART_PALETTE.volumeUp,values:values.histogram,pane:'macd',histogram:true});
      }
    }
    if(this.studies.sma) {
      const cfg=this.studyConfigs.sma;
      const period=cfg?.period??50;
      const source=cfg?.source??'close';
      if(cfg?.visible!==false) {
        add(`SMA ${period}`,cfg?.color??'#3b82f6',sma(this.candles.map(bar=>getPriceSource(bar,source)),period),'price',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle));
      }
    }
    if(this.studies.bollinger) {
      const cfg=this.studyConfigs.bollinger;
      const period=cfg?.period??20,multiplier=cfg?.multiplier??2;
      const source=cfg?.source??'close';
      const values=bollinger(this.candles,period,multiplier,source);
      if(cfg?.upperVisible!==false) {
        add(`BB ${period} · upper`,cfg?.upperColor??'#78909c',values.upper,'price',cfg?.upperWidth??1,toLineStyle(cfg?.upperStyle));
      }
      if(cfg?.middleVisible!==false) {
        add(`BB ${period} · middle`,cfg?.middleColor??'#78909c',values.middle,'price',cfg?.middleWidth??1,toLineStyle(cfg?.middleStyle??'dashed'));
      }
      if(cfg?.lowerVisible!==false) {
        add(`BB ${period} · lower`,cfg?.lowerColor??'#78909c',values.lower,'price',cfg?.lowerWidth??1,toLineStyle(cfg?.lowerStyle));
      }
    }
    if(this.studies.vwap) {
      const cfg=this.studyConfigs.vwap;
      if(cfg?.visible!==false) {
        add('Monthly VWAP',cfg?.color??'#e09b26',monthlyVwap(this.candles),'price',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle));
      }
    }
    if(this.studies.atr) {
      const cfg=this.studyConfigs.atr;
      const period=cfg?.period??14;
      if(cfg?.visible!==false) {
        add(`ATR ${period}`,cfg?.color??'#e09b26',atr(this.candles,period),'atr',cfg?.lineWidth??1,toLineStyle(cfg?.lineStyle));
      }
    }
    if(this.studies.stochastic) {
      const cfg=this.studyConfigs.stochastic;
      const period=cfg?.period??14,dPeriod=cfg?.dPeriod??3;
      const values=stochastic(this.candles,period,dPeriod);
      const levels=cfg?.bandsVisible!==false?[
        {price:cfg?.lower??20,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
        {price:cfg?.upper??80,color:cfg?.bandColor??'#aab8c5',lineStyle:LineStyle.Dashed},
      ]:undefined;
      if(cfg?.kVisible!==false) {
        add(`Stoch %K ${period}`,cfg?.kColor??this.accent,values.k,'stochastic',cfg?.kWidth??1,toLineStyle(cfg?.kStyle),levels);
      }
      if(cfg?.dVisible!==false) {
        add(`Stoch %D ${dPeriod}`,cfg?.dColor??'#ef5350',values.d,'stochastic',cfg?.dWidth??1,toLineStyle(cfg?.dStyle));
      }
    }
    if(this.studies.supertrend) {
      const cfg=this.studyConfigs.supertrend;
      const period=cfg?.period??10,multiplier=cfg?.multiplier??3;
      const st=supertrend(this.candles,period,multiplier);
      add(`Supertrend ${period} ${multiplier}`,st.directions.at(-1)===-1?(cfg?.downColor??'#ef5350'):(cfg?.upColor??'#089981'),st.values,'price',cfg?.lineWidth??2,toLineStyle(cfg?.lineStyle));
    }
    const extras=this.studyConfigs.extras;
    const extraValues=computeExtraStudies(this.candles,extras,{benchmark:this.benchmark});
    for(const def of enabledExtraStudies(extras)) {
      const state=extras?.[def.id],title=studyTitle(def,studyParams(def,state));
      const levels=def.levels?.map(price=>({price,color:'#aab8c5',lineStyle:LineStyle.Dashed}));
      def.lines.forEach((line,index)=>plots.push({
        title:index===0?title:'',color:studyLineColor(line,state),values:extraValues.get(`${def.id}:${line.key}`)!,
        pane:def.pane==='price'?'price':def.id,lineWidth:line.dots?2:1,lineStyle:line.dashed?LineStyle.Dashed:LineStyle.Solid,
        levels:index===0?levels:undefined,id:def.id,dots:line.dots,
      }));
    }
    return plots;
  }
  private updateStudies(appended=false,plots=this.studyPlots()) {
    for(const [index,plot] of plots.entries()) {
      const data=this.candles.map((bar,i)=>plot.values[i]===null?{time:bar.date}:{time:bar.date,value:plot.values[i]!,...(plot.histogram?{color:plot.values[i]!>=0?CHART_PALETTE.volumeUp:CHART_PALETTE.volumeDown}:{})});
      if(appended) this.studySeries[index].update(data.at(-1)!);else this.studySeries[index].setData(data);
    }
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
  setStudyVisibility(studyId:string,visible:boolean) {
    if(studyId==='volume') {
      this.volumeSeries.applyOptions({visible,lastValueVisible:visible&&this.volumeSeries.getPane().paneIndex()!==0});
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
    this.host.focus({preventScroll:true});const point=this.point(event),projection=this.projection();
    if(!projection || point.x>projection.width || point.y>projection.bottom) return;
    if(this.replayPicker) return;
    if(this.layer.down(point,event.pointerId)) {
      this.drawingPointer=event.pointerId;this.blockMouse=true;this.host.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();
    }
  };
  private move=(event:PointerEvent)=>{
    if(this.replayPicker) return;
    if(this.layer.move(this.point(event),event.pointerId)) {event.stopPropagation();}
  };
  private up=(event:PointerEvent)=>{
    if(this.drawingPointer!==event.pointerId) return;
    this.layer.up(this.point(event),event.pointerId);this.drawingPointer=null;
    if(this.host.hasPointerCapture(event.pointerId)) this.host.releasePointerCapture(event.pointerId);
  };
  private cancelPointer=()=>{this.layer.cancelPointer();this.drawingPointer=null;this.blockMouse=false;};
  private crosshair=(event:MouseEventParams<Time>)=>{
    if(this.replayPicker&&event.logical!==undefined) {this.replayIndex=Math.max(0,Math.min(this.candles.length-1,Math.round(event.logical)));this.invalidate();}
    const data=event.seriesData.get(this.activeSeries());
    const time=data?.time;
    const date=time===undefined?undefined:this.dateString(time);
    const bar=date?this.byDate.get(date):this.candles.at(-1);if(bar) this.inspect(bar);
  };
  private dateString(time:Time) {return typeof time==='string'?time:typeof time==='number'?new Date(time*1000).toISOString().slice(0,10):`${time.year}-${String(time.month).padStart(2,'0')}-${String(time.day).padStart(2,'0')}`;}
  private click=(event:MouseEventParams<Time>)=>{
    if(this.replayPicker&&event.logical!==undefined&&event.point&&event.point.y<=this.chart.paneSize(0).height) this.pickReplay(Math.max(0,Math.min(this.candles.length-1,Math.round(event.logical))));
    else if(typeof event.hoveredObjectId==='string') {const events=this.markerEvents.get(event.hoveredObjectId);if(events) this.inspectEvents(events);}
  };
  setReplayPicker(pick:((index:number)=>void)|null,cancel:()=>void=()=>{}) {
    this.layer.cancel();this.replayPicker=pick?{pick,cancel}:null;
    const range=this.chart.timeScale().getVisibleLogicalRange();this.replayIndex=Math.max(0,Math.min(this.candles.length-1,Math.round(range?(range.from+range.to)/2:0)));
    this.chart.applyOptions({handleScroll:this.scrollOptions()});this.invalidate();
  }
  private scrollOptions() {
    return !this.replayPicker && this.book.getSnapshot().tool==='select' && this.currentAppearance?.panEnabled!==false
      ? SCROLL_WITHOUT_WHEEL : false;
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
    if(this.layer.key(event)) return;
    if(!['Home','+','=','-','ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if(event.key==='Home') this.reset();
    else if(event.key==='ArrowLeft'||event.key==='ArrowRight') {const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange();if(range){const delta=(range.to-range.from)*.1*(event.key==='ArrowLeft'?-1:1);scale.setVisibleLogicalRange({from:range.from+delta,to:range.to+delta});}}
    else this.zoom(event.key==='-'?1.25:.8);
  };
  destroy() {
    if(this.disposed) return;this.disposed=true;
    this.hostObserver?.disconnect();
    this.paneObserver?.disconnect();
    this.events.abort();this.theme.disconnect();this.unsubscribe();this.layer.destroy();
    this.chart.unsubscribeCrosshairMove(this.crosshair);this.chart.unsubscribeClick(this.click);this.markers.detach();this.chart.remove();
  }
}
