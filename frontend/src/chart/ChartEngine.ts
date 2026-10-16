import {
  AreaSeries, BaselineSeries, BarSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries,
  LineStyle, LineType, PriceScaleMode, createChart, createSeriesMarkers, createTextWatermark,
  type IChartApi, type IPrimitivePaneView, type ISeriesApi, type ISeriesPrimitive, type ITextWatermarkPluginApi,
  type IPriceLine, type ISeriesMarkersPluginApi, type SeriesMarker, type LineWidth, type Logical, type MouseEventParams, type SeriesAttachedParameter, type Time,
} from 'lightweight-charts';
import { ema, validEmaLine, type Candle, type EmaLine } from './model';
import { DrawingBook, hitDrawing, indexTime, timeIndex, type DrawingProjection, type Pixel } from './drawings';
import { DrawingLayer } from './DrawingLayer';
import { rsi, macd, sma, bollinger, atr, stochastic, monthlyVwap, supertrend, defaultStudies, type ChartStudies } from './studies';
export type { ChartStudies } from './studies';
import type { ChartEvent } from './events';

// Match the reference screener's native candle and bar palette.
export const CHART_PALETTE = {up:'#089981',down:'#ef5350',volumeUp:'rgba(8,153,129,0.5)',volumeDown:'rgba(239,83,80,0.5)'};
export type ChartStyle = 'candles'|'hollowCandles'|'volumeCandles'|'bars'|'highLow'|'line'|'lineWithMarkers'|'stepLine'|'area'|'hlcArea'|'baseline';
export type ScaleMode = 'normal'|'logarithmic'|'percentage'|'indexed';
export type ChartAppearance = {
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
};
const scaleModes = {normal:PriceScaleMode.Normal,logarithmic:PriceScaleMode.Logarithmic,percentage:PriceScaleMode.Percentage,indexed:PriceScaleMode.IndexedTo100};
const withAlpha = (hex:string,opacity:number) => `${hex}${Math.round(opacity*255).toString(16).padStart(2,'0')}`;

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
  private studySeries:ISeriesApi<'Line'|'Histogram'>[]=[];
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
      timeScale:{borderVisible:false,rightOffset:6,barSpacing:8,fixLeftEdge:false,lockVisibleTimeRangeOnResize:true,shiftVisibleRangeOnNewBar:true},
      crosshair:{mode:CrosshairMode.Normal},
      localization:{locale:'en-IN',priceFormatter:(value:number)=>value.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})},
      kineticScroll:{mouse:true,touch:true},
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
    this.unsubscribe=book.subscribe(()=>{this.chart.applyOptions({handleScroll:book.getSnapshot().tool==='select' && !this.replayPicker});});
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
    this.reset();
  }

  private activeSeries():ISeriesApi<'Candlestick'|'Bar'|'Line'|'Area'|'Baseline'> {
    return this.price;
  }
  private createPriceSeries() {
    const a=this.currentAppearance;
    const up=a?.upColor??CHART_PALETTE.up;
    const down=a?.downColor??CHART_PALETTE.down;
    switch(this.style) {
      case 'candles':
      case 'volumeCandles':return this.chart.addSeries(CandlestickSeries,{
        upColor:a?.bodyVisible===false?'transparent':up,
        downColor:a?.bodyVisible===false?'transparent':down,
        borderVisible:a?.borderVisible!==false,
        borderUpColor:a?.borderUpColor??up,
        borderDownColor:a?.borderDownColor??down,
        wickVisible:a?.wickVisible!==false,
        wickUpColor:a?.wickUpColor??up,
        wickDownColor:a?.wickDownColor??down,
        priceLineVisible:a?.priceLineVisible!==false,
      });
      case 'hollowCandles':return this.chart.addSeries(CandlestickSeries,{
        upColor:'transparent',
        downColor:down,
        borderVisible:true,
        borderUpColor:up,
        borderDownColor:down,
        wickVisible:true,
        wickUpColor:up,
        wickDownColor:down,
        priceLineVisible:a?.priceLineVisible!==false,
      });
      case 'bars':return this.chart.addSeries(BarSeries,{upColor:up,downColor:down,thinBars:false,openVisible:false,priceLineVisible:a?.priceLineVisible!==false});
      case 'highLow':return this.chart.addSeries(BarSeries,{upColor:up,downColor:down,thinBars:true,openVisible:false,priceLineVisible:a?.priceLineVisible!==false});
      case 'line':return this.chart.addSeries(LineSeries,{color:this.accent,lineWidth:2,lineType:LineType.Simple});
      case 'lineWithMarkers':return this.chart.addSeries(LineSeries,{color:this.accent,lineWidth:2,lineType:LineType.Simple,crosshairMarkerVisible:true,pointMarkersVisible:true});
      case 'stepLine':return this.chart.addSeries(LineSeries,{color:this.accent,lineWidth:2,lineType:LineType.WithSteps});
      case 'area':return this.chart.addSeries(AreaSeries,{lineColor:this.accent,topColor:withAlpha(this.accent,.2),bottomColor:withAlpha(this.accent,0),lineWidth:2});
      case 'hlcArea':return this.chart.addSeries(AreaSeries,{lineColor:this.accent,topColor:withAlpha(this.accent,.35),bottomColor:withAlpha(this.accent,.05),lineWidth:2});
      case 'baseline':return this.chart.addSeries(BaselineSeries,{baseValue:{type:'price',price:this.candles[0]?.close??0},topLineColor:CHART_PALETTE.up,bottomLineColor:CHART_PALETTE.down});
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
      layout:{background:{type:ColorType.Solid,color:token('chart-background',token('surface','#ffffff'))},textColor:token('muted','#787b86')},
      grid:{vertLines:{color:token('chart-grid','#f0f0f0')},horzLines:{color:token('chart-grid','#f0f0f0')}},
      crosshair:{vertLine:{color:token('chart-crosshair','#aab8c5'),labelBackgroundColor:token('text','#131722')},horzLine:{color:token('chart-crosshair','#aab8c5'),labelBackgroundColor:token('text','#131722')}},
    });
    if(this.style==='line'||this.style==='lineWithMarkers'||this.style==='stepLine') this.price.applyOptions({color:this.accent});
    if(this.style==='area'||this.style==='hlcArea') this.price.applyOptions({lineColor:this.accent,topColor:withAlpha(this.accent,.2),bottomColor:withAlpha(this.accent,0)});
    this.invalidate();
  }
  private volumeData(bar:Candle) {
    return bar.volume===null?{time:bar.date}:{time:bar.date,value:bar.volume,color:bar.close>=bar.open?CHART_PALETTE.volumeUp:CHART_PALETTE.volumeDown};
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
  setAppearance(appearance:ChartAppearance) {
    this.currentAppearance=appearance;
    this.scaleMode=appearance.scaleMode;
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
          ...(appearance.crosshairColor?{color:appearance.crosshairColor}:{}),
          style:toLwcLineStyle(appearance.crosshairStyle),
        },
        horzLine:{
          visible:appearance.crosshair,
          labelVisible:appearance.crosshair,
          ...(appearance.crosshairColor?{color:appearance.crosshairColor}:{}),
          style:toLwcLineStyle(appearance.crosshairStyle),
        },
      },
      handleScroll:appearance.panEnabled!==false,
      handleScale:appearance.zoomEnabled!==false,
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
            color:appearance.watermarkColor||'rgba(154, 164, 178, 0.15)',
            fontSize:48,
          }],
        });
      } catch { /* watermark is optional enhancement */ }
    }

    if(this.style==='candles') {
      const up=appearance.upColor??CHART_PALETTE.up;
      const down=appearance.downColor??CHART_PALETTE.down;
      this.price.applyOptions({
        upColor:appearance.bodyVisible===false?'transparent':up,
        downColor:appearance.bodyVisible===false?'transparent':down,
        borderVisible:appearance.borderVisible!==false,
        borderUpColor:appearance.borderUpColor??up,
        borderDownColor:appearance.borderDownColor??down,
        wickVisible:appearance.wickVisible!==false,
        wickUpColor:appearance.wickUpColor??up,
        wickDownColor:appearance.wickDownColor??down,
        priceLineVisible:appearance.priceLineVisible!==false,
      });
    } else if(this.style==='bars') {
      const up=appearance.upColor??CHART_PALETTE.up;
      const down=appearance.downColor??CHART_PALETTE.down;
      this.price.applyOptions({
        upColor:up,
        downColor:down,
        priceLineVisible:appearance.priceLineVisible!==false,
      });
    }

    const separate=!!appearance.volumePane&&appearance.volume;
    if((this.volumeSeries.getPane().paneIndex()!==0)!==separate) {
      this.volumeSeries.moveToPane(separate?this.chart.panes().length:0);
      if(separate) this.volumeSeries.getPane().setStretchFactor(.25);
    }
    this.volumeSeries.priceScale().applyOptions({scaleMargins:{top:separate?.1:.8,bottom:0},visible:separate});
    const topMargin=typeof appearance.topMargin==='number'?appearance.topMargin/100:.13;
    const bottomMargin=typeof appearance.bottomMargin==='number'?appearance.bottomMargin/100:(appearance.volume&&!separate?.22:.06);
    this.chart.priceScale('right').applyOptions({
      mode:this.comparison&&!this.comparisonSeparate?PriceScaleMode.Percentage:scaleModes[appearance.scaleMode],
      invertScale:appearance.invertScale??false,
      scaleMargins:{top:topMargin,bottom:bottomMargin},
    });
    this.volumeSeries.applyOptions({visible:appearance.volume});
    this.showEvents=appearance.events??false;this.refreshMarkers();
    this.invalidate();
  }
  resetPriceScale=()=>this.chart.priceScale('right').setAutoScale(true);
  reset=()=>{
    this.layer.cancel();this.resetPriceScale();
    this.chart.timeScale().setVisibleLogicalRange({from:Math.max(0,this.candles.length-120),to:this.candles.length-1+6});
  };
  zoom(factor:number,anchor=.5) {
    const scale=this.chart.timeScale(),range=scale.getVisibleLogicalRange();if(!range) return;
    const count=Math.max(5,(range.to-range.from)*factor),delta=range.to-range.from-count;
    scale.setVisibleLogicalRange({from:range.from+delta*anchor,to:range.from+delta*anchor+count});
  }
  setRange(months:number|null) {
    if(!this.candles.length) return;
    if(months===null) {this.chart.timeScale().fitContent();return;}
    const last=this.candles.at(-1)!,boundary=new Date(`${last.date}T00:00:00Z`);
    boundary.setUTCMonth(boundary.getUTCMonth()-months);
    const from=this.candles.find(bar=>bar.date>=boundary.toISOString().slice(0,10))?.date??this.candles[0].date;
    this.chart.timeScale().setVisibleRange({from,to:last.date});
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
  restoreView(view:{from:string;to:string}) {this.chart.timeScale().setVisibleRange(view);}
  paneWeights() {return this.chart.panes().map(pane=>pane.getStretchFactor());}
  restorePaneWeights(weights:readonly number[]) {const panes=this.chart.panes();if(weights.length===panes.length) panes.forEach((pane,index)=>pane.setStretchFactor(weights[index]));}
  latest() {this.chart.timeScale().scrollToPosition(6,true);}
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
  setStudies(studies:Partial<ChartStudies>) {
    for(const series of this.studySeries) this.chart.removeSeries(series);
    this.studySeries=[];this.studies={...defaultStudies(),...studies};
    const panes=new Map<string,number>();
    for(const plot of this.studyPlots()) {
      if(plot.pane!=='price'&&!panes.has(plot.pane)) panes.set(plot.pane,this.chart.panes().length);
      const pane=plot.pane==='price'?0:panes.get(plot.pane)!;
      const series=this.chart.addSeries(plot.histogram?HistogramSeries:LineSeries,{color:plot.color,lineWidth:1,title:plot.title,priceLineVisible:false,lastValueVisible:!plot.histogram},pane);
      if(plot.pane!=='price') series.getPane().setStretchFactor(.3);
      for(const price of plot.levels??[]) series.createPriceLine({price,color:'#aab8c5',lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true});
      this.studySeries.push(series);
    }
    this.updateStudies();
  }
  private studyPlots() {
    const plots:Array<{title:string;color:string;values:(number|null)[];pane:string;histogram?:boolean;levels?:number[]}>=[];
    const add=(title:string,color:string,values:(number|null)[],pane='price',levels?:number[])=>plots.push({title,color,values,pane,levels});
    if(this.studies.rsi) add('RSI 14','#8b5cf6',rsi(this.candles),'rsi',[30,70]);
    if(this.studies.macd) {
      const values=macd(this.candles);
      add('MACD 12/26',this.accent,values.line,'macd');add('Signal 9','#f59e0b',values.signal,'macd');
      plots.push({title:'MACD histogram',color:CHART_PALETTE.volumeUp,values:values.histogram,pane:'macd',histogram:true});
    }
    if(this.studies.sma) add('SMA 50','#3b82f6',sma(this.candles.map(bar=>bar.close),50));
    if(this.studies.bollinger) {const values=bollinger(this.candles);add('BB 20 · upper','#78909c',values.upper);add('BB 20 · middle','#78909c',values.middle);add('BB 20 · lower','#78909c',values.lower);}
    if(this.studies.vwap) add('Monthly VWAP','#e09b26',monthlyVwap(this.candles));
    if(this.studies.atr) add('ATR 14','#e09b26',atr(this.candles),'atr');
    if(this.studies.stochastic) {const values=stochastic(this.candles);add('Stoch %K 14',this.accent,values.k,'stochastic',[20,80]);add('Stoch %D 3','#ef5350',values.d,'stochastic');}
    if(this.studies.supertrend) {const st=supertrend(this.candles,10,3);add('Supertrend 10 3',st.directions.at(-1)===-1?'#ef5350':'#089981',st.values,'price');}
    return plots;
  }
  private updateStudies(appended=false) {
    for(const [index,plot] of this.studyPlots().entries()) {
      const data=this.candles.map((bar,i)=>plot.values[i]===null?{time:bar.date}:{time:bar.date,value:plot.values[i]!,...(plot.histogram?{color:plot.values[i]!>=0?CHART_PALETTE.volumeUp:CHART_PALETTE.volumeDown}:{})});
      if(appended) this.studySeries[index].update(data.at(-1)!);else this.studySeries[index].setData(data);
    }
  }
  syncCrosshair(time:Time|undefined) {
    const bar=time===undefined?undefined:this.byDate.get(this.dateString(time));
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
    this.chart.applyOptions({handleScroll:!pick && this.book.getSnapshot().tool==='select'});this.invalidate();
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
    this.events.abort();this.theme.disconnect();this.unsubscribe();this.layer.destroy();
    this.chart.unsubscribeCrosshairMove(this.crosshair);this.chart.unsubscribeClick(this.click);this.markers.detach();this.chart.remove();
  }
}
