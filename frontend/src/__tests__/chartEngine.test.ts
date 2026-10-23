import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChartEngine, CHART_PALETTE } from '../chart/ChartEngine';
import { defaultEmaLines, type Candle } from '../chart/model';
import { DrawingBook } from '../chart/drawings';
import { defaultStudyConfigs } from '../chart/studyConfigs';

const native=vi.hoisted(()=>{
  const series:Array<ReturnType<typeof makeSeries>>=[];
  const scale={applyOptions:vi.fn(),setAutoScale:vi.fn(),options:vi.fn(()=>({autoScale:true})),getVisibleRange:vi.fn(()=>({from:100,to:200})),setVisibleRange:vi.fn()};
  const pane={paneIndex:vi.fn(()=>0),setStretchFactor:vi.fn()};
  const markers={setMarkers:vi.fn(),detach:vi.fn()};
  function makeSeries(type:string) {
    return {type,setData:vi.fn(),update:vi.fn(),pop:vi.fn(),applyOptions:vi.fn(),attachPrimitive:vi.fn((primitive:{attached?:(input:unknown)=>void})=>primitive.attached?.({requestUpdate:vi.fn()})),detachPrimitive:vi.fn(),priceToCoordinate:vi.fn((price:number)=>price),coordinateToPrice:vi.fn((y:number)=>y),priceScale:vi.fn(()=>scale),getPane:vi.fn(()=>pane),moveToPane:vi.fn(),seriesOrder:vi.fn(()=>0),setSeriesOrder:vi.fn(),createPriceLine:vi.fn(()=>({applyOptions:vi.fn()})),removePriceLine:vi.fn()};
  }
  const time={getVisibleLogicalRange:vi.fn(()=>({from:0,to:5})),setVisibleLogicalRange:vi.fn(),setVisibleRange:vi.fn(),fitContent:vi.fn(),width:vi.fn(()=>800),logicalToCoordinate:vi.fn((index:number)=>index*10),coordinateToLogical:vi.fn((x:number)=>x/10),timeToCoordinate:vi.fn(()=>null),coordinateToTime:vi.fn(()=>null),timeToIndex:vi.fn(()=>1),scrollToPosition:vi.fn(),subscribeVisibleLogicalRangeChange:vi.fn(),unsubscribeVisibleLogicalRangeChange:vi.fn()};
  const chart={
    addSeries:vi.fn((type:string)=>{
      const result=makeSeries(type);
      series.push(result);return result;
    }),
    removeSeries:vi.fn(),applyOptions:vi.fn(),priceScale:vi.fn(()=>scale),timeScale:vi.fn(()=>time),paneSize:vi.fn(()=>({width:800,height:500})),
    panes:vi.fn(()=>[pane]),subscribeClick:vi.fn(),unsubscribeClick:vi.fn(),subscribeCrosshairMove:vi.fn(),unsubscribeCrosshairMove:vi.fn(),setCrosshairPosition:vi.fn(),clearCrosshairPosition:vi.fn(),takeScreenshot:vi.fn(),remove:vi.fn(),
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
  expect(native.createChart).toHaveBeenCalledWith(expect.any(HTMLElement),expect.objectContaining({autoSize:true,layout:expect.objectContaining({attributionLogo:false}),handleScroll:expect.objectContaining({mouseWheel:false,pressedMouseMove:true}),handleScale:expect.objectContaining({mouseWheel:false,pinch:true}),kineticScroll:{mouse:false,touch:true}}));
  expect(native.chart.addSeries).toHaveBeenCalledWith('Candlestick',expect.objectContaining({upColor:'#089981',downColor:'#ef5350',wickUpColor:'#089981',wickDownColor:'#ef5350',borderVisible:true,borderUpColor:'#089981',borderDownColor:'#ef5350'}));
  expect(CHART_PALETTE.volumeUp).toBe('rgba(8,153,129,0.5)');
  const volume=native.series.find(series=>series.type==='Histogram')!;
  // Simple Volume is the default: too little history for an average, so bars are grey noise, except the up-day highest volume ever (sky blue).
  expect(volume.setData).toHaveBeenCalledWith([
    {time:'2026-10-01',value:100,color:'#7c7c87'},
    {time:'2026-10-02'},
    {time:'2026-10-05',value:200,color:'#87ceeb'},
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
  expect(native.chart.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({handleScroll:expect.objectContaining({mouseWheel:false,pressedMouseMove:true}),handleScale:expect.objectContaining({mouseWheel:false,pinch:true})}));
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
it('keeps a small right-edge gap after presets and saved views that include the latest bar',()=>{
  const {engine}=setup();
  native.time.setVisibleLogicalRange.mockClear();
  engine.setRange(12);
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:0,to:8});
  native.time.setVisibleLogicalRange.mockClear();
  engine.setRange(null);
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:0,to:8});
  native.time.setVisibleLogicalRange.mockClear();
  engine.restoreView({from:'2026-10-01',to:'2026-10-05'});
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:0,to:8});
  native.time.setVisibleLogicalRange.mockClear();
  engine.restoreView({from:'2026-10-01',to:'2026-10-02'});
  expect(native.time.setVisibleLogicalRange).not.toHaveBeenCalled();
  expect(native.time.setVisibleRange).toHaveBeenLastCalledWith({from:'2026-10-01',to:'2026-10-02'});
  engine.destroy();
});
it('keeps a visible pixel gap even when All compresses a long history',()=>{
  const history=Array.from({length:1000},(_,index)=>({...candles[0],date:new Date(Date.UTC(2020,0,1+index)).toISOString().slice(0,10)}));
  const {engine}=setup(history);
  native.time.setVisibleLogicalRange.mockClear();
  engine.setRange(null);
  const range=native.time.setVisibleLogicalRange.mock.lastCall?.[0];
  expect(range.from).toBe(0);
  expect(range.to).toBeGreaterThan(history.length-1+6);
  native.time.getVisibleLogicalRange.mockReturnValueOnce({from:0,to:1000});
  engine.latest();
  expect(native.time.scrollToPosition).toHaveBeenLastCalledWith(40,true);
  engine.destroy();
});
it('applies study configs with one native series rebuild',()=>{
  const {engine}=setup();
  engine.setStudies({rsi:true});
  native.chart.removeSeries.mockClear();
  native.chart.addSeries.mockClear();
  const configs=defaultStudyConfigs();
  configs.rsi={...configs.rsi!,period:7};
  engine.setStudyConfigs(configs);
  expect(native.chart.removeSeries).not.toHaveBeenCalled();
  expect(native.chart.addSeries).not.toHaveBeenCalled();
  engine.setStudies({rsi:true});
  expect(native.chart.removeSeries).toHaveBeenCalledTimes(1);
  expect(native.chart.addSeries).toHaveBeenCalledTimes(1);
  expect(native.chart.addSeries).toHaveBeenCalledWith('Line',expect.objectContaining({title:'RSI 7'}),1);
  engine.destroy();
});
it('applies configured volume colors to both price and separate panes',()=>{
  const {engine}=setup(candles.map((bar,index)=>index===1?{...bar,volume:150}:bar));
  const volume=native.series.find(series=>series.type==='Histogram')!;
  const configs=defaultStudyConfigs();
  configs.volume={...configs.volume!,mode:'classic',upColor:'#123456',downColor:'#abcdef'};
  engine.setStudyConfigs(configs);
  expect(volume.setData).toHaveBeenLastCalledWith([
    {time:'2026-10-01',value:100,color:'#12345680'},
    {time:'2026-10-02',value:150,color:'#abcdef80'},
    {time:'2026-10-05',value:200,color:'#12345680'},
  ]);
  engine.setAppearance({horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal',volumePane:true});
  expect(volume.setData).toHaveBeenLastCalledWith(expect.arrayContaining([{time:'2026-10-01',value:100,color:'#12345680'}]));
  engine.destroy();
});
it('snaps synced daily dates to the preceding weekly or monthly bar without showing a future bar',()=>{
  const history=[
    {...candles[0],date:'2026-10-01'},
    {...candles[1],date:'2026-10-08'},
    {...candles[2],date:'2026-11-02'},
  ];
  const {engine,inspect}=setup(history);
  engine.syncCrosshair('2026-10-06');
  expect(native.chart.setCrosshairPosition).toHaveBeenLastCalledWith(history[0].close,'2026-10-01',expect.anything());
  expect(inspect).toHaveBeenLastCalledWith(history[0]);
  engine.syncCrosshair('2026-10-20');
  expect(native.chart.setCrosshairPosition).toHaveBeenLastCalledWith(history[1].close,'2026-10-08',expect.anything());
  engine.syncCrosshair('2026-09-30');
  expect(native.chart.clearCrosshairPosition).toHaveBeenCalledOnce();
  engine.destroy();
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
  expect(native.series[1].applyOptions).toHaveBeenCalledWith(expect.objectContaining({priceScaleId:'right',lastValueVisible:true,visible:true}));
  engine.setAppearance({horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal',events:true,volumePane:false,crosshairMode:'ohlc'});
  expect(native.series[1].applyOptions).toHaveBeenCalledWith(expect.objectContaining({priceScaleId:'volume',lastValueVisible:false,visible:true}));
  engine.setAppearance({horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal',events:true,volumePane:true,crosshairMode:'ohlc'});
  // Events are lettered badges in the bottom strip: E and N on 1 Oct; the 5 Oct split is after the cutoff.
  expect((engine as unknown as {eventStrip:{key:string;badges:{letter:string}[]}[]}).eventStrip).toEqual([{index:0,key:'events:2026-10-01',badges:[{letter:'E',color:'#f23645'},{letter:'N',color:'#2962ff'}]}]);
  engine.setAppearance({horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal',events:true,volumePane:true,eventStyles:{news:{visible:false}}});
  expect((engine as unknown as {eventStrip:{key:string;badges:{letter:string}[]}[]}).eventStrip[0].badges.map(badge=>badge.letter)).toEqual(['E']);
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
it('provides pane count and safe pane elements for DOM portaling',()=>{
  const {engine}=setup();
  expect(engine.getPanesCount()).toBe(1);
  expect(engine.getPaneElement(0)).toBeNull();
  expect(engine.getPaneElement(99)).toBeNull();

  const mockDiv = document.createElement('div');
  const mockTd = document.createElement('td');
  mockTd.appendChild(mockDiv);
  const mockTr = document.createElement('tr');
  mockTr.appendChild(mockTd);
  (native.pane as any).getHTMLElement = vi.fn(() => mockTr);
  expect(engine.getPaneElement(0)).toBe(mockDiv);
  delete (native.pane as any).getHTMLElement;
  engine.destroy();
});
it('applies precision, previous-close colouring, high/low lines and horizontal-only drag from chart settings',()=>{
  const {engine}=setup();
  const base={horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal' as const};
  const price=native.series[0];
  engine.setAppearance({...base,precision:'3'});
  expect(price.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({priceFormat:{type:'price',precision:3,minMove:.001}}));
  // Bar 2 closes below bar 1's close even though it is a "green" candle by open in neither case: direction comes from the previous close.
  engine.setAppearance({...base,colorByPreviousClose:true,upColor:'#00ff00',downColor:'#ff0000'});
  const data=price.setData.mock.lastCall![0];
  expect(data[1]).toMatchObject({color:'#ff0000',borderColor:'#ff0000',wickColor:'#ff0000'});
  expect(data[2]).toMatchObject({color:'#00ff00'});
  expect(data[0].color).toBeUndefined();
  engine.setAppearance({...base,highLowPriceLines:true});
  expect(price.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:14,title:'H'}));
  expect(price.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:9,title:'L'}));
  engine.setAppearance({...base,mousePan:'horizontal'});
  expect(native.chart.applyOptions).toHaveBeenCalledWith(expect.objectContaining({handleScale:expect.objectContaining({axisPressedMouseMove:{time:true,price:false}})}));
  expect(native.scale.applyOptions).toHaveBeenCalledWith({autoScale:true});
  engine.destroy();
});
it('colours Simple Volume bars as pocket pivots, above-average up/down, dry and noise',()=>{
  // 60 quiet bars alternating down/up, then a down day, a pocket pivot and an above-average down day.
  const bars:Candle[]=[];
  for(let index=0;index<60;index++) bars.push({date:new Date(Date.UTC(2026,0,1+index)).toISOString().slice(0,10),open:10,high:11,low:9,close:index%2?10.5:10,volume:100});
  bars.push({date:'2026-03-02',open:10,high:11,low:9,close:9.5,volume:120});
  bars.push({date:'2026-03-03',open:9.5,high:12,low:9.4,close:11.9,volume:500});
  bars.push({date:'2026-03-04',open:11.9,high:12,low:10,close:10.2,volume:400});
  bars.push({date:'2026-03-05',open:10.2,high:10.6,low:10,close:10.5,volume:10});
  const {engine}=setup(bars);
  const volume=native.series.find(series=>series.type==='Histogram')!;
  const data=volume.setData.mock.lastCall![0];
  expect(data.at(-4).color).toBe('#ff5252');
  expect(data.at(-3).color).toBe('#87ceeb');
  expect(data.at(-2).color).toBe('#ff5252');
  expect(data.at(-1).color).toBe('#ff9800');
  // With labels off, the 500 pocket pivot (also the highest volume ever) stays deep blue; with them on it's the sky-blue HVE.
  expect(native.markers.setMarkers).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({id:'vol:HVE',text:'HVE',color:'#87ceeb'})]));
  // Bull Snort: 500 >= 3x the ~108 average, close in the top 35% of the range, above the previous close.
  expect((engine as unknown as {simpleVolume:{snorts:number[]}}).simpleVolume.snorts).toContain(61);
  engine.destroy();
});
it('paints every highest-volume record sky blue, including down days',()=>{
  const bars:Candle[]=[{date:'2026-10-01',open:10,high:11,low:9,close:10,volume:100},{date:'2026-10-02',open:10,high:11,low:8,close:9,volume:900}];
  const {engine}=setup(bars);
  const volume=native.series.find(series=>series.type==='Histogram')!;
  expect(volume.setData.mock.lastCall![0][1].color).toBe('#87ceeb');
  engine.destroy();
});
it('replaces band guides cleanly and retains them across chart styles', () => {
  const {engine}=setup();
  const price=native.series[0];
  engine.setPriceBandGuides([105,95]);
  expect(price.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:105,title:'UC',color:'#2962ff'}));
  engine.setStyle('bars');
  expect(price.removePriceLine).toHaveBeenCalledTimes(2);
  const next=native.series.at(-1)!;
  expect(next.createPriceLine).toHaveBeenCalledTimes(2);
  engine.setPriceBandGuides([]);
  expect(next.removePriceLine).toHaveBeenCalledTimes(2);
  engine.destroy();
});
it('earnings indicator markers respect replay cutoffs and visibility', () => {
  const {engine}=setup();
  engine.setStudyConfigs({...defaultStudyConfigs(),fundamentals:{enabled:true}});
  engine.setEvents([{id:'past',date:'2026-10-01',kind:'earnings',title:'Quarterly results'}, {id:'future',date:'2026-10-05',kind:'earnings',title:'Future results'}],'2026-10-02');
  const events=()=>(engine as unknown as {eventStrip:{key:string;badges:{letter:string}[]}[]}).eventStrip.map(group=>group.key);
  expect(events()).toEqual(['events:2026-10-01']);
  engine.setStudyVisibility('fundamentals',false);
  expect(events()).toEqual([]);
  engine.destroy();
});
it('places the upcoming results label on the future session and brings it into view',()=>{
  const {engine}=setup();
  // Last bar is Mon 2026-10-05; Thu 2026-10-08 is three sessions later (logical 5).
  engine.setUpcomingEarnings({date:'2026-10-08',line:false});
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:0,to:13});
  native.time.setVisibleLogicalRange.mockClear();
  engine.setUpcomingEarnings({date:'2026-10-08',line:true});
  expect(native.time.setVisibleLogicalRange).not.toHaveBeenCalled();
  engine.setUpcomingEarnings(null);
  engine.destroy();
});
it('places past band changes on the bar containing the date, within the replay cutoff',()=>{
  const {engine}=setup();
  engine.setEvents([],'2026-10-05');
  engine.setBandChanges([{date:'2026-10-03',from:'5',to:'20'},{date:'2026-10-05',from:'20',to:'No Band'},{date:'2026-10-09',from:'20',to:'10'}]);
  // Saturday 3 Oct falls on Friday's bar (index 1); 9 Oct is after the cutoff.
  expect((engine as unknown as {bandChangeBars:()=>unknown}).bandChangeBars()).toEqual([{index:1,to:'20'},{index:2,to:'No Band'}]);
  engine.destroy();
});
it('zooms on the wheel with the right edge fixed and pans on a sideways swipe, like TradingView',()=>{
  const host=document.createElement('div');document.body.append(host);
  const engine=new ChartEngine(host,candles,vi.fn());
  native.time.getVisibleLogicalRange.mockReturnValue({from:0,to:5});
  native.time.setVisibleLogicalRange.mockClear();
  const wheel=(init:WheelEventInit)=>{const event=new WheelEvent('wheel',{cancelable:true,...init});host.dispatchEvent(event);return event;};
  // Scrolling down zooms out; the right edge (5) stays put.
  expect(wheel({deltaY:100}).defaultPrevented).toBe(true);
  const out=native.time.setVisibleLogicalRange.mock.lastCall![0];
  expect(out.to).toBe(5);expect(out.from).toBeLessThan(0);
  // A sideways swipe pans: 800px wide over 5 bars is 160px per bar.
  wheel({deltaX:160});
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:1,to:6});
  // Shift + wheel pans too.
  wheel({deltaY:-160,shiftKey:true});
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:-1,to:4});
  engine.setAppearance({horizontalGrid:false,verticalGrid:false,crosshair:true,volume:true,scaleMode:'normal',zoomEnabled:false});
  native.time.setVisibleLogicalRange.mockClear();
  expect(wheel({deltaY:100}).defaultPrevented).toBe(false);
  expect(native.time.setVisibleLogicalRange).not.toHaveBeenCalled();
  engine.destroy();
});

it('trims the volume-average series on replay rewind',()=>{
  const input=candles.map((bar,index)=>({...bar,volume:(index+1)*100}));
  const {engine}=setup(input);
  native.pane.paneIndex.mockReturnValue(1);
  const configs=defaultStudyConfigs(); configs.volume={...configs.volume!,maLength:2}; engine.setStudyConfigs(configs);
  engine.setAppearance({horizontalGrid:false,verticalGrid:false,crosshair:true,volume:true,volumePane:true,scaleMode:'normal'});
  const average=native.series.find(series=>series.type==='Line')!;
  expect(average.setData.mock.lastCall![0]).toHaveLength(3);
  expect(average.setData.mock.lastCall![0].at(-1)).toEqual({time:'2026-10-05',value:250});
  average.setData.mockClear(); average.pop.mockClear();
  engine.setCandles(input.slice(0,2));
  expect(average.setData).not.toHaveBeenCalled();
  expect(average.pop).toHaveBeenCalledWith(1);
  engine.destroy(); native.pane.paneIndex.mockReturnValue(0);
});
it('composes classic-volume opacity with transparent colors',()=>{
  const {engine}=setup(); const configs=defaultStudyConfigs();
  configs.volume={...configs.volume!,mode:'classic',upColor:'#12345680'};
  engine.setStudyConfigs(configs);
  const volume=native.series.find(series=>series.type==='Histogram')!;
  expect(volume.setData.mock.lastCall![0][0].color).toBe('#12345640');
  engine.destroy();
});

it('round-trips transparent EMA and drawing colors', () => {
  const {engine}=setup(); engine.setEmaLines([{...defaultEmaLines()[0],color:'#12345680'}]);
  expect(native.series.at(-1)!.applyOptions).toHaveBeenCalledWith(expect.objectContaining({color:'#12345680'}));
  const book=new DrawingBook(); book.add('horizontal',{time:Date.parse(candles[0].date),price:11});
  const id=book.getSnapshot().drawings[0].id; book.update(id,{color:'#12345680'});
  expect(book.getSnapshot().drawings[0].color).toBe('#12345680'); engine.destroy();
});

it('updates the volume average incrementally on replay append',()=>{
  const {engine}=setup(candles.slice(0,2)); native.pane.paneIndex.mockReturnValue(1);
  engine.setAppearance({horizontalGrid:false,verticalGrid:false,crosshair:true,volume:true,volumePane:true,scaleMode:'normal'});
  const average=native.series.find(series=>series.type==='Line')!; average.setData.mockClear();
  engine.setCandles(candles);
  expect(average.setData).not.toHaveBeenCalled(); expect(average.update).toHaveBeenCalledOnce();
  engine.destroy(); native.pane.paneIndex.mockReturnValue(0);
});
it('formats the crosshair date with the weekday, as TradingView does',async()=>{
  const {crosshairDate}=await import('../chart/ChartEngine');
  expect(crosshairDate('2024-08-09')).toBe("Fri 09 Aug '24");
});
it('pans 2 bars per arrow (10 with Ctrl), pans prices with Up/Down and announces the latest visible bar',()=>{
  const {engine}=setup();
  const announce=vi.fn();engine.announce=announce;
  native.time.getVisibleLogicalRange.mockReturnValue({from:0,to:5});
  const host=document.body.lastElementChild as HTMLElement;
  host.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:2,to:7});
  host.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',ctrlKey:true,bubbles:true,cancelable:true}));
  expect(native.time.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:-10,to:-5});
  host.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
  expect(native.scale.setVisibleRange).toHaveBeenLastCalledWith({from:110,to:210});
  expect(announce).toHaveBeenLastCalledWith(expect.stringContaining('close 13'));
  engine.destroy();
});
it('draws an opt-in previous-close line and keeps one per series',()=>{
  const {engine}=setup();
  const price=native.series[0];
  expect(price.createPriceLine).not.toHaveBeenCalled();
  engine.setAppearance({horizontalGrid:false,verticalGrid:false,crosshair:true,volume:true,scaleMode:'normal',prevCloseLine:true});
  expect(price.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:10,axisLabelVisible:true}));
  engine.setAppearance({horizontalGrid:false,verticalGrid:false,crosshair:true,volume:true,scaleMode:'normal',prevCloseLine:false});
  expect(price.removePriceLine).toHaveBeenCalled();
  engine.destroy();
});
it('copies, pastes and duplicates the selected drawing five bars later',()=>{
  const host=document.createElement('div');document.body.append(host);
  const book=new DrawingBook();
  const engine=new ChartEngine(host,candles,vi.fn(),book);
  book.addPoints('trendline',[{time:Date.parse('2026-10-01'),price:10},{time:Date.parse('2026-10-02'),price:11}]);
  const first=book.getSnapshot().drawings[0];
  host.dispatchEvent(new KeyboardEvent('keydown',{key:'d',metaKey:true,bubbles:true,cancelable:true}));
  host.dispatchEvent(new KeyboardEvent('keydown',{key:'c',metaKey:true,bubbles:true,cancelable:true}));
  host.dispatchEvent(new KeyboardEvent('keydown',{key:'v',metaKey:true,bubbles:true,cancelable:true}));
  const drawings=book.getSnapshot().drawings;
  expect(drawings).toHaveLength(3);
  expect(drawings[1].kind).toBe('trendline');
  expect(drawings[1].a.time).toBeGreaterThan(first.a.time);
  engine.destroy();
});
it('classifies corporate actions into TradingView event letters', async () => {
  const {eventBadgeKey}=await import('../chart/events');
  expect(['Stock split from Rs 10 to Rs 2','Bonus 1:1','Interim Dividend','Rights issue','AGM'].map(title=>eventBadgeKey({kind:'action',title})))
    .toEqual(['split','bonus','dividend','rights','action']);
  expect(eventBadgeKey({kind:'news',title:'x'})).toBe('news');
});

it('updates a late relative-strength benchmark without recreating native series',()=>{
  const {engine}=setup();
  engine.setStudyConfigs({...defaultStudyConfigs(),extras:{rs:{enabled:true,params:{maPeriod:0}}}});
  const firstStudy=native.series.length;
  engine.setStudies({});
  const rs=native.series[firstStudy];
  const count=native.chart.addSeries.mock.calls.length;
  const before=rs.setData.mock.calls.length;
  engine.setBenchmark(new Map(candles.map(bar=>[bar.date,100])));
  expect(rs.setData.mock.calls.length).toBeGreaterThan(before);
  expect(rs.setData.mock.lastCall?.[0].some((bar:{value?:number})=>Number.isFinite(bar.value))).toBe(true);
  expect(native.chart.addSeries).toHaveBeenCalledTimes(count);
  expect(native.chart.removeSeries).not.toHaveBeenCalled();
  engine.destroy();
});
