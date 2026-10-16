import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChartsTab from '../components/ChartsTab';
import { screenerApi } from '../api/screenerApi';
import { ChartEngine } from '../chart/ChartEngine';

vi.mock('../api/screenerApi', () => ({screenerApi:{getChart:vi.fn(),runScreen:vi.fn(async()=>({rows:[{symbol:'RELIANCE',marketCapCrore:5,freeFloatPct:50,circuitLimit:'5'}],immutableRevision:'a'.repeat(64)}))}}));
vi.mock('../chart/ChartEngine', () => ({ChartEngine:vi.fn(class {
  chart={timeScale:()=>({subscribeVisibleTimeRangeChange:vi.fn(),unsubscribeVisibleTimeRangeChange:vi.fn()}),subscribeCrosshairMove:vi.fn(),unsubscribeCrosshairMove:vi.fn()};
  savedView=vi.fn(()=>undefined);paneWeights=vi.fn(()=>[1]);restoreView=vi.fn();restorePaneWeights=vi.fn();
  zoom=vi.fn(); reset=vi.fn(); resetPriceScale=vi.fn(); setEmaLines=vi.fn(); setStyle=vi.fn(); setAppearance=vi.fn(); setRange=vi.fn(); setCandles=vi.fn(); setReplayPicker=vi.fn(); setStudies=vi.fn(); setComparison=vi.fn(); setEvents=vi.fn(); latest=vi.fn(); goToDate=vi.fn(()=>true); destroy=vi.fn();
})}));
const candles = [
  {date:'2026-10-01',open:10,high:12,low:9,close:11,volume:100},
  {date:'2026-10-02',open:11,high:14,low:10,close:13,volume:200},
];
function setup() {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  return render(<QueryClientProvider client={client}><ChartsTab datasetRevision={'a'.repeat(64)}/></QueryClientProvider>);
}
function chooseGrid(count:1|2) {
  fireEvent.click(screen.getByLabelText('Chart grid'));
  fireEvent.click(screen.getByRole('button',{name:count===1?'1 chart · Single chart':'2 charts · Side by side'}));
}
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
it('loads release-pinned history, aggregates intervals and disposes replaced engines', async () => {
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  const ui = setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(screenerApi.getChart).toHaveBeenCalledWith('RELIANCE','a'.repeat(64));
  const first = vi.mocked(ChartEngine).mock.results[0].value;
  fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
  expect(first.zoom).toHaveBeenCalledWith(.8);
  fireEvent.click(screen.getByLabelText('Indicators'));
  fireEvent.click(screen.getByLabelText('Enable EMA 3'));
  fireEvent.click(screen.getByRole('button',{name:'Apply'}));
  expect(first.setEmaLines.mock.lastCall[0][2]).toMatchObject({period:50,enabled:true,color:'#22d3ee'});
  fireEvent.click(screen.getByRole('button',{name:'Auto'}));
  expect(first.resetPriceScale).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'Maximize chart'}));
  expect(screen.getByRole('dialog',{name:'Nexus charts'})).toHaveClass('chart-workspace-expanded');
  expect(first.destroy).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button',{name:'Restore chart'}),{key:'Escape'});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText('RELIANCE candlestick and volume chart'),{key:'Enter',altKey:true});
  fireEvent.click(screen.getByRole('button',{name:'Restore chart'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Weekly candles'}));
  await waitFor(() => expect(ChartEngine).toHaveBeenCalledTimes(2));
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(vi.mocked(ChartEngine).mock.calls[1][1]).toEqual([{...candles[0],high:14,close:13,volume:300}]);
  const second = vi.mocked(ChartEngine).mock.results[1].value;
  ui.unmount();
  expect(second.destroy).toHaveBeenCalledOnce();
});
it('shows a retryable data error without invented candles', async () => {
  vi.mocked(screenerApi.getChart).mockRejectedValue(new Error('Chart data unavailable'));
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Chart data unavailable');
  expect(ChartEngine).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await waitFor(() => expect(screenerApi.getChart).toHaveBeenCalledTimes(2));
});
it('reveals only a closed-bar prefix during replay, steps without rebuilding the engine and restores normal history',async()=>{
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup(); await screen.findByLabelText('RELIANCE candlestick and volume chart');
  await screen.findByText('MCap');
  const originalBook=vi.mocked(ChartEngine).mock.calls[0][3];
  fireEvent.click(screen.getByRole('button',{name:'Replay'}));
  expect(screen.queryByText('MCap')).not.toBeInTheDocument();
  const originalEngine=vi.mocked(ChartEngine).mock.results[0].value;
  expect(screen.getByLabelText('Replay position')).toHaveTextContent('Click a bar to start');
  expect(ChartEngine).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button',{name:'Play replay'})).toBeDisabled();
  act(()=>originalEngine.setReplayPicker.mock.lastCall[0](0));
  expect(vi.mocked(ChartEngine).mock.lastCall?.[1]).toEqual(candles.slice(0,1));
  expect(vi.mocked(ChartEngine).mock.lastCall?.[3]).not.toBe(originalBook);
  expect(screen.getByLabelText('Replay position')).toHaveTextContent('2026-10-01');
  const replayEngine=vi.mocked(ChartEngine).mock.results.at(-1)!.value;
  const creations=vi.mocked(ChartEngine).mock.calls.length;
  fireEvent.click(screen.getByRole('button',{name:'Next replay bar'}));
  expect(replayEngine.setCandles).toHaveBeenLastCalledWith(candles);
  expect(ChartEngine).toHaveBeenCalledTimes(creations);
  expect(screen.getByRole('button',{name:'Play replay'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Exit replay'}));
  expect(screen.getByText('MCap')).toBeInTheDocument();
  expect(vi.mocked(ChartEngine).mock.lastCall?.[1]).toEqual(candles);
  expect(vi.mocked(ChartEngine).mock.lastCall?.[3]).toBe(originalBook);
});
it('handles empty history and rejects invalid symbol input before requesting it', async () => {
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:null,candles:[],volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup();
  await screen.findByText('No published candles for RELIANCE.');
  fireEvent.change(screen.getByLabelText('Chart symbol'),{target:{value:'BAD SYMBOL'}});
  fireEvent.click(screen.getByRole('button',{name:'Load'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a scanner symbol');
  expect(screenerApi.getChart).toHaveBeenCalledTimes(1);
});
it('connects native panes, styles, settings, date navigation and release-pinned comparisons without rebuilding the chart',async()=>{
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol=>({schemaVersion:2,symbol,asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]}));
  setup();await screen.findByLabelText('RELIANCE candlestick and volume chart');
  const engine=vi.mocked(ChartEngine).mock.results[0].value;
  expect(engine.setAppearance).toHaveBeenCalledWith(expect.objectContaining({volumePane:true}));
  fireEvent.change(screen.getByLabelText('Chart style'),{target:{value:'baseline'}});
  expect(engine.setStyle).toHaveBeenLastCalledWith('baseline');
  fireEvent.click(screen.getByRole('button',{name:'Indicators'}));
  fireEvent.click(screen.getByLabelText('RSI 14'));fireEvent.click(screen.getByLabelText('MACD 12/26/9'));
  expect(engine.setStudies).toHaveBeenLastCalledWith(expect.objectContaining({rsi:true,macd:true}));
  fireEvent.click(screen.getByRole('button',{name:'Close indicators'}));
  fireEvent.click(screen.getByRole('button',{name:'Chart settings'}));
  expect(screen.getByRole('dialog',{name:'Chart settings'}).parentElement?.parentElement).toBe(document.body);
  expect(screen.queryByRole('link',{name:'Charts by TradingView'})).not.toBeInTheDocument();
  expect(within(screen.getByRole('dialog',{name:'Chart settings'})).queryByRole('link',{name:'TradingView, Inc.'})).not.toBeInTheDocument();
  expect(screen.getByLabelText('Volume in separate pane')).toBeChecked();
  fireEvent.click(screen.getByLabelText('Volume in separate pane'));
  fireEvent.change(screen.getByLabelText('Crosshair snapping'),{target:{value:'ohlc'}});
  expect(engine.setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({volumePane:false,crosshairMode:'ohlc'}));
  fireEvent.change(screen.getByLabelText('Compare symbol'),{target:{value:'TCS'}});
  fireEvent.click(screen.getByRole('button',{name:'Add'}));
  await waitFor(()=>expect(engine.setComparison).toHaveBeenLastCalledWith('TCS',candles,false));
  expect(screenerApi.getChart).toHaveBeenCalledWith('TCS','a'.repeat(64));
  fireEvent.click(screen.getByLabelText('Comparison in synced pane'));
  await waitFor(()=>expect(engine.setComparison).toHaveBeenLastCalledWith('TCS',candles,true));
  fireEvent.change(screen.getByLabelText('Go to date'),{target:{value:'2026-10-01'}});
  fireEvent.click(screen.getByRole('button',{name:'Go'}));
  expect(engine.goToDate).toHaveBeenCalledWith('2026-10-01');
  fireEvent.click(screen.getByRole('button',{name:'Latest'}));expect(engine.latest).toHaveBeenCalledOnce();
  expect(ChartEngine).toHaveBeenCalledTimes(1);
});
it('keeps an explicitly saved volume overlay preference',async()=>{
  localStorage.setItem('nexus.chart.scene.0.v1',JSON.stringify({appearance:{horizontalGrid:true,verticalGrid:true,crosshair:true,volume:true,scaleMode:'normal',volumePane:false}}));
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup();await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(vi.mocked(ChartEngine).mock.results[0].value.setAppearance).toHaveBeenCalledWith(expect.objectContaining({volumePane:false}));
  fireEvent.click(screen.getByRole('button',{name:'Chart settings'}));
  expect(screen.getByLabelText('Volume in separate pane')).not.toBeChecked();
});
it('mounts only selected chart tiles and disposes hidden engines when shrinking a sixteen-chart grid',async()=>{
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol=>({schemaVersion:2,symbol,asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]}));
  setup();await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(screenerApi.getChart).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText('Chart grid'));fireEvent.click(screen.getByRole('button',{name:'16 charts · Sixteen grid'}));
  await screen.findByLabelText('WIPRO candlestick and volume chart');
  expect(ChartEngine).toHaveBeenCalledTimes(16);expect(screenerApi.getChart).toHaveBeenCalledTimes(16);
  const engines=vi.mocked(ChartEngine).mock.results.map(result=>result.value);
  chooseGrid(1);
  expect(screen.getAllByLabelText(/candlestick and volume chart$/)).toHaveLength(1);
  expect(engines[0].destroy).not.toHaveBeenCalled();for(const engine of engines.slice(1)) expect(engine.destroy).toHaveBeenCalledOnce();
},15000);
it('links subsequent symbol and interval changes independently',async()=>{
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol=>({schemaVersion:2,symbol,asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]}));
  setup();await screen.findByLabelText('RELIANCE candlestick and volume chart');chooseGrid(2);
  await screen.findByLabelText('TCS candlestick and volume chart');
  fireEvent.click(screen.getByLabelText('Chart grid'));fireEvent.click(screen.getByRole('switch',{name:'Sync interval'}));
  fireEvent.click(within(screen.getByRole('region',{name:'Chart 1 · RELIANCE'})).getByRole('button',{name:'Weekly candles'}));
  expect(screen.getByRole('region',{name:'Chart 1 · RELIANCE'})).toHaveTextContent('1W');
  expect(screen.getByRole('region',{name:'Chart 2 · TCS'})).toHaveTextContent('1W');
  fireEvent.click(screen.getByRole('switch',{name:'Sync interval'}));fireEvent.click(screen.getByRole('switch',{name:'Sync symbol'}));
  const first=within(screen.getByRole('region',{name:'Chart 1 · RELIANCE'}));
  fireEvent.change(first.getByLabelText('Chart symbol'),{target:{value:'INFY'}});fireEvent.click(first.getByRole('button',{name:'Load'}));
  await screen.findByRole('region',{name:'Chart 2 · INFY'});
  fireEvent.click(within(screen.getByRole('region',{name:'Chart 1 · INFY'})).getByRole('button',{name:'Monthly candles'}));
  expect(screen.getByRole('region',{name:'Chart 1 · INFY'})).toHaveTextContent('1M');
  expect(screen.getByRole('region',{name:'Chart 2 · INFY'})).toHaveTextContent('1W');
});
it('keeps tiles independent, saves named layouts and restores all chart settings after remount',async()=>{
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol=>({schemaVersion:2,symbol,asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]}));
  let ui=setup();await screen.findByLabelText('RELIANCE candlestick and volume chart');
  chooseGrid(2);
  await screen.findByLabelText('TCS candlestick and volume chart');
  const tcs=within(screen.getByRole('region',{name:'Chart 2 · TCS'}));
  fireEvent.change(tcs.getByLabelText('Chart style'),{target:{value:'line'}});
  fireEvent.click(tcs.getByRole('button',{name:'Weekly candles'}));
  expect(screen.getByLabelText('RELIANCE candlestick and volume chart')).toBeInTheDocument();
  await screen.findByLabelText('TCS line and volume chart');
  fireEvent.click(screen.getByRole('button',{name:'Layouts'}));
  fireEvent.change(screen.getByLabelText('Layout name'),{target:{value:'Research'}});fireEvent.click(screen.getByRole('button',{name:'Save current'}));
  fireEvent.click(screen.getByRole('button',{name:'Close saved layouts'}));
  chooseGrid(1);
  fireEvent.click(screen.getByRole('button',{name:'Layouts'}));fireEvent.click(screen.getByRole('button',{name:'Load layout Research'}));
  await screen.findByLabelText('TCS line and volume chart');
  ui.unmount();ui=setup();
  await screen.findByLabelText('TCS line and volume chart');expect(screen.getByLabelText('Chart grid')).toHaveTextContent('2H');
  expect(screen.getByRole('region',{name:'Chart 2 · TCS'})).toHaveTextContent('1W');
  ui.unmount();
});
