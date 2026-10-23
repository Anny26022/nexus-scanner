import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChartEngine } from '../chart/ChartEngine';
import { defaultEmaLines, type Candle } from '../chart/model';
import { DrawingBook } from '../chart/drawings';
import { defaultStudyConfigs } from '../chart/studyConfigs';

const native=vi.hoisted(()=>{
  const series:Array<ReturnType<typeof makeSeries>>=[];
  const scale={applyOptions:vi.fn(),setAutoScale:vi.fn()};
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
