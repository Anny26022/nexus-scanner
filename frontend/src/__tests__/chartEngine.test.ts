import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChartEngine, CHART_PALETTE } from '../chart/ChartEngine';
import { defaultEmaLines, type Candle } from '../chart/model';
import { DrawingBook } from '../chart/drawings';

const native=vi.hoisted(()=>{
  const series:Array<ReturnType<typeof makeSeries>>=[];
  const scale={applyOptions:vi.fn(),setAutoScale:vi.fn()};
  const pane={paneIndex:vi.fn(()=>0),setStretchFactor:vi.fn()};
  const markers={setMarkers:vi.fn(),detach:vi.fn()};
  function makeSeries(type:string) {
    return {type,setData:vi.fn(),update:vi.fn(),pop:vi.fn(),applyOptions:vi.fn(),attachPrimitive:vi.fn((primitive:{attached?:(input:unknown)=>void})=>primitive.attached?.({requestUpdate:vi.fn()})),detachPrimitive:vi.fn(),priceToCoordinate:vi.fn((price:number)=>price),coordinateToPrice:vi.fn((y:number)=>y),priceScale:vi.fn(()=>scale),getPane:vi.fn(()=>pane),moveToPane:vi.fn(),seriesOrder:vi.fn(()=>0),setSeriesOrder:vi.fn(),createPriceLine:vi.fn(()=>({applyOptions:vi.fn()})),removePriceLine:vi.fn()};
  }
  const time={getVisibleLogicalRange:vi.fn(()=>({from:0,to:5})),setVisibleLogicalRange:vi.fn(),setVisibleRange:vi.fn(),fitContent:vi.fn(),logicalToCoordinate:vi.fn((index:number)=>index*10),coordinateToLogical:vi.fn((x:number)=>x/10),timeToCoordinate:vi.fn(()=>null),coordinateToTime:vi.fn(()=>null),timeToIndex:vi.fn(()=>1),scrollToPosition:vi.fn()};
  const chart={
    addSeries:vi.fn((type:string)=>{
      const result=makeSeries(type);
      series.push(result);return result;
    }),
    removeSeries:vi.fn(),applyOptions:vi.fn(),priceScale:vi.fn(()=>scale),timeScale:vi.fn(()=>time),paneSize:vi.fn(()=>({width:800,height:500})),
    panes:vi.fn(()=>[pane]),subscribeClick:vi.fn(),unsubscribeClick:vi.fn(),subscribeCrosshairMove:vi.fn(),unsubscribeCrosshairMove:vi.fn(),takeScreenshot:vi.fn(),remove:vi.fn(),
  };
  return {chart,series,time,scale,pane,markers,createSeriesMarkers:vi.fn(()=>markers),createChart:vi.fn(()=>chart)};
});
vi.mock('lightweight-charts',()=>({
  createChart:native.createChart,createSeriesMarkers:native.createSeriesMarkers,CandlestickSeries:'Candlestick',BarSeries:'Bar',LineSeries:'Line',HistogramSeries:'Histogram',AreaSeries:'Area',BaselineSeries:'Baseline',
  ColorType:{Solid:'solid'},CrosshairMode:{Normal:0,Magnet:1,MagnetOHLC:3},LineStyle:{Solid:0,Dotted:1,Dashed:2},PriceScaleMode:{Normal:0,Logarithmic:1,Percentage:2,IndexedTo100:3},
}));
const candles:Candle[] = [
  {date:'2026-10-01',open:10,high:12,low:9,close:11,volume:100},
  {date:'2026-10-02',open:11,high:12,low:9,close:10,volume:null},
  {date:'2026-10-05',open:10,high:14,low:9,close:13,volume:200},
];
beforeEach(()=>{vi.clearAllMocks();native.series.length=0;});
afterEach(()=>{document.body.replaceChildren();});
function setup(input:readonly Candle[]=candles) {
  const host=document.createElement('div');document.body.append(host);
  const inspect=vi.fn();return {engine:new ChartEngine(host,input,inspect),inspect};
}
it('uses matching reference bodies, borders and wicks with thicker HLC bars and preserves missing volume',()=>{
  const {engine}=setup();
  expect(native.createChart).toHaveBeenCalledWith(expect.any(HTMLElement),expect.objectContaining({autoSize:true,layout:expect.objectContaining({attributionLogo:false})}));
  expect(native.chart.addSeries).toHaveBeenCalledWith('Candlestick',expect.objectContaining({upColor:'#089981',downColor:'#ef5350',wickUpColor:'#089981',wickDownColor:'#ef5350',borderVisible:true,borderUpColor:'#089981',borderDownColor:'#ef5350'}));
  expect(CHART_PALETTE.volumeUp).toBe('rgba(8,153,129,0.5)');
  const volume=native.series.find(series=>series.type==='Histogram')!;
  expect(volume.setData).toHaveBeenCalledWith([
    {time:'2026-10-01',value:100,color:CHART_PALETTE.volumeUp},
    {time:'2026-10-02'},
    {time:'2026-10-05',value:200,color:CHART_PALETTE.volumeUp},
  ]);
  const primitive=native.series[0].attachPrimitive.mock.calls[0][0];
  engine.setStyle('bars');
  expect(native.chart.addSeries).toHaveBeenCalledWith('Bar',expect.objectContaining({upColor:'#089981',downColor:'#ef5350',thinBars:false,openVisible:false}));
  expect(native.series[0].detachPrimitive).toHaveBeenCalledWith(primitive);
  expect(native.series.at(-1)!.attachPrimitive).toHaveBeenCalledWith(primitive);
  engine.destroy();
});
it('keeps unrevealed prices and indicator values out of replay and appends the next closed bar incrementally',()=>{
  const {engine}=setup(candles.slice(0,1));
  engine.setEmaLines([{...defaultEmaLines()[0],period:2}]);
  const candle=native.series[0],average=native.series.at(-1)!;
  expect(candle.setData.mock.lastCall?.[0]).toEqual([{time:'2026-10-01',open:10,high:12,low:9,close:11}]);
  expect(average.setData.mock.lastCall?.[0]).toEqual([{time:'2026-10-01'}]);
  candle.setData.mockClear();average.setData.mockClear();
  engine.setCandles(candles.slice(0,2));
  expect(candle.setData).not.toHaveBeenCalled();
  expect(candle.update).toHaveBeenCalledWith({time:'2026-10-02',open:11,high:12,low:9,close:10});
  expect(average.update).toHaveBeenCalledWith({time:'2026-10-02',value:10.5});
  engine.setCandles(candles.slice(0,1));
  expect(candle.pop).toHaveBeenCalledWith(1);
  expect(average.pop).toHaveBeenCalledWith(1);
  expect(candle.setData).not.toHaveBeenCalled();
  engine.destroy();
});
it('wires native scale modes, crosshair readouts, image export and teardown',()=>{
  const {engine,inspect}=setup();
  engine.setAppearance({horizontalGrid:false,verticalGrid:true,crosshair:false,volume:false,scaleMode:'logarithmic'});
  expect(native.scale.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({mode:1,scaleMargins:{top:.13,bottom:.06}}));
  const crosshair=native.chart.subscribeCrosshairMove.mock.calls[0][0];
  crosshair({seriesData:new Map([[native.series[0],{time:{year:2026,month:10,day:2}}]])});
  expect(inspect).toHaveBeenLastCalledWith(candles[1]);
  engine.takeScreenshot();expect(native.chart.takeScreenshot).toHaveBeenCalledWith(true,false);
  engine.destroy();engine.destroy();
  expect(native.chart.unsubscribeCrosshairMove).toHaveBeenCalledWith(crosshair);
  expect(native.chart.remove).toHaveBeenCalledOnce();
});
it('uses native clicks for replay, date navigation and native append following',()=>{
  const {engine}=setup(candles.slice(0,2)),pick=vi.fn();
  engine.setReplayPicker(pick);
  const click=native.chart.subscribeClick.mock.calls[0][0];
  click({logical:1,point:{x:10,y:50}});
  expect(pick).toHaveBeenCalledWith(1);
  native.time.setVisibleLogicalRange.mockClear();
  engine.setCandles(candles);
  expect(native.time.setVisibleLogicalRange).not.toHaveBeenCalled();
  expect(engine.goToDate('2026-10-02')).toBe(true);
  expect(engine.goToDate('2020-01-01')).toBe(false);
  engine.latest();expect(native.time.scrollToPosition).toHaveBeenCalledWith(6,true);
  engine.destroy();expect(native.chart.unsubscribeClick).toHaveBeenCalledWith(click);
});
it('renders horizontal drawings with native price lines through edits, undo and style replacement',()=>{
  const book=new DrawingBook(),host=document.createElement('div');document.body.append(host);
  const engine=new ChartEngine(host,candles,vi.fn(),book);
  book.add('horizontal',{time:Date.parse(candles[0].date),price:11});
  const id=book.getSnapshot().drawings[0].id,price=native.series[0];
  expect(price.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:11,axisLabelVisible:true}));
  book.update(id,{a:{time:Date.parse(candles[0].date),price:12}});
  expect(price.createPriceLine.mock.results[0].value.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({price:12}));
  engine.setStyle('area');
  expect(native.chart.removeSeries).toHaveBeenCalledWith(price);
  const area=native.series.at(-1)!;
  expect(area.type).toBe('Area');expect(area.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:12}));
  book.undo();expect(area.createPriceLine.mock.results[0].value.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({price:11}));
  book.undo();expect(area.removePriceLine).toHaveBeenCalled();engine.destroy();
});
it('groups optional event markers and excludes future events and comparison sessions in replay',()=>{
  const {engine}=setup(candles.slice(0,2));
  engine.setEvents([{id:'1',date:'2026-10-01',kind:'earnings',title:'Results'},{id:'2',date:'2026-10-01',kind:'news',title:'News'},{id:'3',date:'2026-10-05',kind:'action',title:'Split'}],'2026-10-02');
  expect(native.markers.setMarkers).toHaveBeenLastCalledWith([]);
  engine.setAppearance({horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal',events:true,volumePane:true,crosshairMode:'ohlc'});
  expect(native.series[1].moveToPane).toHaveBeenCalledWith(1);
  expect(native.markers.setMarkers.mock.lastCall?.[0]).toEqual([expect.objectContaining({time:'2026-10-01',id:'events:2026-10-01'})]);
  engine.setComparison('TCS',[...candles,{...candles[1],date:'2026-10-03'}]);
  const comparison=native.series.at(-1)!;
  expect(comparison.setData.mock.lastCall?.[0]).toEqual([{time:'2026-10-01',value:11},{time:'2026-10-02',value:10}]);
  engine.setCandles(candles.slice(0,1));
  expect(comparison.setData.mock.lastCall?.[0]).toEqual([{time:'2026-10-01',value:11}]);
  engine.setStudies({rsi:true,macd:true});
  expect(native.chart.addSeries).toHaveBeenCalledWith('Line',expect.objectContaining({title:'RSI 14'}),1);
  engine.setStudies({rsi:false,macd:false});engine.destroy();
});
it('updates and rewinds every additional study from the same revealed candle prefix',()=>{
  const history=Array.from({length:60},(_,index)=>({...candles[0],date:new Date(Date.UTC(2026,0,index+1)).toISOString().slice(0,10),open:index+10,high:index+12,low:index+9,close:index+11}));
  const {engine}=setup(history.slice(0,55));
  engine.setStudies({sma:true,bollinger:true,vwap:true,atr:true,stochastic:true});
  const studies=native.series.slice(2);
  expect(studies).toHaveLength(8);
  for(const series of studies) {
    const data=series.setData.mock.lastCall?.[0] as Array<{time:string}>;
    expect(data).toHaveLength(55);expect(data.at(-1)?.time).toBe(history[54].date);
    series.setData.mockClear();
  }
  engine.setCandles(history.slice(0,56));
  for(const series of studies) {expect(series.update).toHaveBeenCalledWith(expect.objectContaining({time:history[55].date}));expect(series.setData).not.toHaveBeenCalled();}
  engine.setCandles(history.slice(0,54));
  for(const series of studies) expect(series.pop).toHaveBeenCalledWith(2);
  engine.destroy();
});
