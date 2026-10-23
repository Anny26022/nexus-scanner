import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChartsTab from '../components/ChartsTab';
import { screenerApi } from '../api/screenerApi';
import { ChartEngine } from '../chart/ChartEngine';

vi.mock('../api/screenerApi', () => ({screenerApi:{getChart:vi.fn(),getFinancialHistory:vi.fn(async()=>null),getEarningsSchedule:vi.fn(async()=>null),getPriceBandHistory:vi.fn(async()=>null),getBenchmark:vi.fn(async()=>undefined),runScreen:vi.fn(async()=>({rows:[{symbol:'RELIANCE',marketCapCrore:5,freeFloatPct:50,circuitLimit:'5'}],immutableRevision:'a'.repeat(64)}))}}));
vi.mock('../chart/ChartEngine', () => ({ChartEngine:vi.fn(class {
  timeScale={subscribeVisibleTimeRangeChange:vi.fn(),unsubscribeVisibleTimeRangeChange:vi.fn()};
  chart={timeScale:()=>this.timeScale,subscribeCrosshairMove:vi.fn(),unsubscribeCrosshairMove:vi.fn()};
  savedView=vi.fn(()=>undefined);paneWeights=vi.fn(()=>[1]);restoreView=vi.fn();restorePaneWeights=vi.fn();
  zoom=vi.fn(); reset=vi.fn(); resetPriceScale=vi.fn(); setEmaLines=vi.fn(); setStyle=vi.fn(); setAppearance=vi.fn(); setRange=vi.fn(); setCandles=vi.fn(); setReplayPicker=vi.fn(); setStudies=vi.fn(); setBenchmark=vi.fn(); setComparison=vi.fn(); setEvents=vi.fn(); latest=vi.fn(); goToDate=vi.fn(()=>true); destroy=vi.fn();
  setOnPanesChange=vi.fn(); getPaneOffsets=vi.fn(()=>[]); getStudyPaneIndex=vi.fn(()=>1); movePane=vi.fn(); maximizePane=vi.fn(); setStudyVisibility=vi.fn();
  setStudyConfigs=vi.fn(); setPriceBandGuides=vi.fn();setUpcomingEarnings=vi.fn();setBandChanges=vi.fn();
})}));
const candles = [
  {date:'2026-10-01',open:10,high:12,low:9,close:11,volume:100},
  {date:'2026-10-02',open:11,high:14,low:10,close:13,volume:200},
];
function setup() {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  return render(<QueryClientProvider client={client}><ChartsTab datasetRevision={'a'.repeat(64)} sessionDate="2026-10-02"/></QueryClientProvider>);
}
function chooseGrid(count:1|2) {
  fireEvent.click(screen.getByLabelText('Chart grid'));
  fireEvent.click(screen.getByRole('button',{name:count===1?'1 chart · Single chart':'2 charts · Side by side'}));
}
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
const loadSymbol=(scope:{getByRole:typeof screen.getByRole},value:string)=>{
  fireEvent.click(scope.getByRole('button',{name:/^Search symbol/}));
  const input=screen.getByRole('combobox',{name:'Chart symbol'});
  fireEvent.change(input,{target:{value}});
  fireEvent.submit(input.closest('form')!);
};
it('selects one year for a fresh chart without overriding saved ranges', async () => {
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(screen.getByRole('button',{name:'1y'})).toHaveAttribute('aria-pressed','true');
  expect(vi.mocked(ChartEngine).mock.results[0].value.setRange).toHaveBeenCalledWith(12);
});
it('preserves a saved All range', async () => {
  localStorage.setItem('nexus.chart.scene.0.v1',JSON.stringify({range:null}));
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(screen.getByRole('button',{name:'All'})).toHaveAttribute('aria-pressed','true');
  expect(vi.mocked(ChartEngine).mock.results[0].value.setRange).toHaveBeenCalledWith(null);
});
it('uses the selected duration instead of a stale viewport when the symbol changes', async () => {
  localStorage.setItem('nexus.chart.scene.0.v1',JSON.stringify({range:12,view:{from:'2026-09-01',to:'2026-10-02'}}));
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol=>({schemaVersion:2,symbol,asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]}));
  setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(screen.getByRole('button',{name:'1y'})).toHaveAttribute('aria-pressed','true');
  expect(vi.mocked(ChartEngine).mock.results[0].value.setRange).toHaveBeenCalledWith(12);
  expect(vi.mocked(ChartEngine).mock.results[0].value.restoreView).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button',{name:'6mo'}));
  loadSymbol(screen,'TCS');
  await screen.findByLabelText('TCS candlestick and volume chart');
  const next=vi.mocked(ChartEngine).mock.results.at(-1)!.value;
  expect(screen.getByRole('button',{name:'6mo'})).toHaveAttribute('aria-pressed','true');
  expect(next.setRange).toHaveBeenCalledWith(6);
  expect(next.restoreView).not.toHaveBeenCalled();
});
it('carries a manually adjusted date window to the next symbol', async () => {
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol=>({schemaVersion:2,symbol,asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]}));
  setup();
  const canvas=await screen.findByLabelText('RELIANCE candlestick and volume chart');
  const first=vi.mocked(ChartEngine).mock.results.at(-1)!.value;
  first.savedView.mockReturnValue({from:'2025-12-01',to:'2026-10-02'});
  fireEvent.wheel(canvas);
  expect(vi.mocked(ChartEngine).mock.results.at(-1)!.value).toBe(first);
  first.timeScale.subscribeVisibleTimeRangeChange.mock.calls[1][0]();
  expect(first.savedView).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button',{name:'1y'})).toHaveAttribute('aria-pressed','false');
  loadSymbol(screen,'TCS');
  await screen.findByLabelText('TCS candlestick and volume chart');
  expect(JSON.parse(localStorage.getItem('nexus.chart.scene.0.v1')!)).toMatchObject({view:{from:'2025-12-01',to:'2026-10-02'}});
  const next=vi.mocked(ChartEngine).mock.results.at(-1)!.value;
  expect(next.setRange).not.toHaveBeenCalled();
  expect(next.restoreView).toHaveBeenCalledWith({from:'2025-12-01',to:'2026-10-02'});
});
it('preserves a saved custom date view without selecting one year', async () => {
  const view={from:'2026-10-01',to:'2026-10-02'};
  localStorage.setItem('nexus.chart.scene.0.v1',JSON.stringify({view}));
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(screen.getByRole('button',{name:'1y'})).toHaveAttribute('aria-pressed','false');
  const engine=vi.mocked(ChartEngine).mock.results[0].value;
  expect(engine.setRange).not.toHaveBeenCalled();
  expect(engine.restoreView).toHaveBeenCalledWith(view);
});
it('mounts layout previews only while the grid picker is open', () => {
  setup();
  expect(document.querySelectorAll('.chart-layout-preview')).toHaveLength(0);
  fireEvent.click(screen.getByLabelText('Chart grid'));
  expect(document.querySelectorAll('.chart-layout-preview').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByLabelText('Chart grid'));
  expect(document.querySelectorAll('.chart-layout-preview')).toHaveLength(0);
});
it('loads release-pinned history, aggregates intervals and disposes replaced engines', async () => {
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  const ui = setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  expect(screenerApi.getChart).toHaveBeenCalledWith('RELIANCE','a'.repeat(64),'2026-10-02');
  const first = vi.mocked(ChartEngine).mock.results[0].value;
  fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
  expect(first.zoom).toHaveBeenCalledWith(.8);
  fireEvent.click(screen.getByLabelText('Indicators'));
  fireEvent.click(screen.getByTitle('Customize Exponential Moving Average'));
  fireEvent.click(screen.getByRole('tab', { name: 'Style' }));
  fireEvent.click(screen.getByLabelText('EMA 50'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(first.setEmaLines.mock.lastCall[0][2]).toMatchObject({period:50,enabled:true,color:'#22d3ee'});
  fireEvent.click(screen.getByRole('button',{name:'Auto'}));
  expect(first.resetPriceScale).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'Maximize chart'}));
  expect(screen.getByRole('dialog',{name:'Nexus charts'})).toHaveClass('chart-workspace-expanded');
  expect(document.querySelector('.chart-desk-body')).toHaveClass('chart-desk-body-expanded');
  expect(document.querySelector('.chart-desk-body-expanded .chart-watchlist-dock')).toBeInTheDocument();
  expect(first.destroy).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button',{name:'Restore chart'}),{key:'Escape'});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.querySelector('.chart-desk-body')).not.toHaveClass('chart-desk-body-expanded');
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
  loadSymbol(screen,'BAD SYMBOL');
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
  fireEvent.click(screen.getByRole('tab',{name:'Status line'}));
  expect(screen.getByLabelText('Volume in separate pane')).toBeChecked();
  fireEvent.click(screen.getByLabelText('Volume in separate pane'));
  fireEvent.click(screen.getByRole('tab',{name:'Canvas'}));
  fireEvent.change(screen.getByLabelText('Crosshair snapping'),{target:{value:'ohlc'}});
  expect(engine.setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({volumePane:false,crosshairMode:'ohlc'}));
  fireEvent.click(screen.getByRole('tab',{name:'Symbol'}));
  fireEvent.change(screen.getByLabelText('Compare symbol'),{target:{value:'TCS'}});
  fireEvent.click(screen.getByRole('button',{name:'Add'}));
  await waitFor(()=>expect(engine.setComparison).toHaveBeenLastCalledWith('TCS',candles,false));
  expect(screenerApi.getChart).toHaveBeenCalledWith('TCS','a'.repeat(64),'2026-10-02');
  fireEvent.click(screen.getByLabelText('Comparison in synced pane'));
  await waitFor(()=>expect(engine.setComparison).toHaveBeenLastCalledWith('TCS',candles,true));
  fireEvent.click(screen.getByRole('tab',{name:'Navigation'}));
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
  fireEvent.click(screen.getByRole('tab',{name:'Status line'}));
  expect(screen.getByLabelText('Volume in separate pane')).not.toBeChecked();
});
it.each(['Cancel', 'Escape', 'Close', 'Backdrop'] as const)(
  'rolls back live chart-settings previews on %s dismissal',
  async dismissal => {
    vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
    setup();
    await screen.findByLabelText('RELIANCE candlestick and volume chart');
    const engine=vi.mocked(ChartEngine).mock.results[0].value;
    fireEvent.click(screen.getByRole('button',{name:'Chart settings'}));
    const dialog=screen.getByRole('dialog',{name:'Chart settings'});
    fireEvent.click(within(dialog).getByRole('tab',{name:'Status line'}));
    fireEvent.click(within(dialog).getByLabelText('Volume in separate pane'));
    expect(engine.setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({volumePane:false}));

    if(dismissal==='Cancel') fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));
    else if(dismissal==='Escape') fireEvent.keyDown(dialog,{key:'Escape'});
    else if(dismissal==='Close') fireEvent.click(within(dialog).getByRole('button',{name:'Close chart settings'}));
    else fireEvent.pointerDown(document.querySelector('.chart-modal-backdrop')!);

    expect(screen.queryByRole('dialog',{name:'Chart settings'})).not.toBeInTheDocument();
    expect(engine.setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({volumePane:true}));
    expect(JSON.parse(localStorage.getItem('nexus.chart.scene.0.v1') ?? '{}').appearance.volumePane).toBe(true);
  },
);
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
},30000);
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
  loadSymbol(first,'INFY');
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

it('persists fullscreen state across remounts and keeps layout grid option accessible in fullscreen', async () => {
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol => ({
    schemaVersion: 2,
    symbol,
    asOfDate: '2026-10-02',
    historyStartDate: '2026-10-01',
    candles,
    volumeEvents: {},
    corporateActions: [],
    earnings: [],
    marketNews: [],
  }));
  let ui = setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');

  // Verify grid picker is visible in normal mode
  expect(screen.getByLabelText('Chart grid')).toBeInTheDocument();
  expect(screen.getAllByLabelText('Chart grid')).toHaveLength(1);

  // Maximize chart (enter fullscreen)
  fireEvent.click(screen.getByRole('button', { name: 'Maximize chart' }));
  expect(screen.getByRole('dialog', { name: 'Nexus charts' })).toHaveClass('chart-workspace-expanded');

  // Grid picker must remain accessible in fullscreen topbar, with exactly one in DOM
  expect(screen.getByLabelText('Chart grid')).toBeInTheDocument();
  expect(screen.getAllByLabelText('Chart grid')).toHaveLength(1);
  expect(localStorage.getItem('nexus.chart.chart-fullscreen.v1')).toBe('"0"');

  // Simulate page refresh by unmounting and remounting
  ui.unmount();
  ui = setup();

  // Must remain in fullscreen on page refresh
  expect(await screen.findByRole('dialog', { name: 'Nexus charts' })).toHaveClass('chart-workspace-expanded');
  expect(screen.getByLabelText('Chart grid')).toBeInTheDocument();
  expect(screen.getAllByLabelText('Chart grid')).toHaveLength(1);

  // Exiting fullscreen updates persistence
  fireEvent.click(screen.getByRole('button', { name: 'Restore chart' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Chart grid')).toBeInTheDocument();
  expect(localStorage.getItem('nexus.chart.chart-fullscreen.v1')).toBe('null');
  ui.unmount();
});

it('writes fullscreen state once per toggle under Strict Mode', async () => {
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<StrictMode><QueryClientProvider client={client}><ChartsTab datasetRevision={'a'.repeat(64)} sessionDate="2026-10-02"/></QueryClientProvider></StrictMode>);
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  writes.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Maximize chart' }));
  expect(writes.mock.calls.filter(([key]) => key === 'nexus.chart.chart-fullscreen.v1')).toHaveLength(1);
  writes.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Restore chart' }));
  expect(writes.mock.calls.filter(([key]) => key === 'nexus.chart.chart-fullscreen.v1')).toHaveLength(1);
});

it('configures crosshair transparency and inverted scale in chart settings', async () => {
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol => ({
    schemaVersion: 2,
    symbol,
    asOfDate: '2026-10-02',
    historyStartDate: '2026-10-01',
    candles,
    volumeEvents: {},
    corporateActions: [],
    earnings: [],
    marketNews: [],
  }));
  const ui = setup();
  await screen.findByLabelText('RELIANCE candlestick and volume chart');
  const engine = vi.mocked(ChartEngine).mock.results[0].value;

  fireEvent.click(screen.getByRole('button', { name: 'Chart settings' }));
  const dialog = screen.getByRole('dialog', { name: 'Chart settings' });
  expect(dialog).toBeInTheDocument();

  // Test Transparency slider in Crosshair section
  fireEvent.click(screen.getByRole('tab', { name: 'Canvas' }));
  const transparencySlider = screen.getByLabelText('Transparency');
  expect(transparencySlider).toBeInTheDocument();
  expect(transparencySlider).toHaveValue('0');
  expect(screen.getByText('0%')).toBeInTheDocument();

  fireEvent.change(transparencySlider, { target: { value: '45' } });
  expect(screen.getByText('45%')).toBeInTheDocument();
  expect(engine.setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ crosshairTransparency: 45 }));

  // Test Invert scale toggle
  fireEvent.click(screen.getByRole('tab', { name: 'Scales and lines' }));
  const invertToggle = screen.getByLabelText('Invert scale');
  expect(invertToggle).not.toBeChecked();
  fireEvent.click(invertToggle);
  expect(invertToggle).toBeChecked();
  expect(engine.setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ invertScale: true }));

  // Test Vertical grid toggle
  fireEvent.click(screen.getByRole('tab', { name: 'Canvas' }));
  const vertToggle = screen.getByLabelText('Vertical grid lines');
  // Grid lines start off, like a clean TradingView chart.
  expect(vertToggle).not.toBeChecked();
  fireEvent.click(vertToggle);
  expect(vertToggle).toBeChecked();
  expect(engine.setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ verticalGrid: true }));

  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(screen.queryByRole('dialog', { name: 'Chart settings' })).not.toBeInTheDocument();
  ui.unmount();
});

it('hides circuit guides with the fundamentals indicator',async()=>{
  localStorage.setItem('nexus.chart.scene.0.v1',JSON.stringify({studyConfigs:{fundamentals:{enabled:true,table:false}}}));
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup(); await screen.findByLabelText('RELIANCE candlestick and volume chart');
  const engine=vi.mocked(ChartEngine).mock.results.at(-1)!.value;
  await waitFor(()=>expect(engine.setPriceBandGuides).toHaveBeenCalledWith([13*1.05,13*.95]));
  const row=screen.getByText('Price Band & Results').closest<HTMLElement>('.chart-indicator-row')!;
  engine.setPriceBandGuides.mockClear();
  fireEvent.click(within(row).getByTitle('Hide'));
  expect(engine.setStudyVisibility).toHaveBeenCalledWith('fundamentals',false);
  expect(engine.setPriceBandGuides).toHaveBeenCalledWith([]);
});
it('applies late metadata without recreating the chart',async()=>{
  let resolveMetrics!: (data:any)=>void;
  vi.mocked(screenerApi.runScreen).mockImplementationOnce(()=>new Promise(resolve=>{resolveMetrics=resolve;}));
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup();await screen.findByLabelText('RELIANCE candlestick and volume chart');
  const first=vi.mocked(ChartEngine).mock.results.at(-1)!.value;
  const count=vi.mocked(ChartEngine).mock.calls.length;
  await act(async()=>resolveMetrics({rows:[{symbol:'RELIANCE',marketCapCrore:5,circuitLimit:'5'}],immutableRevision:'a'.repeat(64)}));
  await waitFor(()=>expect(ChartEngine).toHaveBeenCalledTimes(count));
  expect(first.destroy).not.toHaveBeenCalled();
});

it('moves the fundamentals card without rebuilding studies',async()=>{
  localStorage.setItem('nexus.chart.scene.0.v1',JSON.stringify({studyConfigs:{fundamentals:{enabled:true}}}));
  vi.mocked(screenerApi.getChart).mockResolvedValue({schemaVersion:2,symbol:'RELIANCE',asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]});
  setup(); await screen.findByLabelText('RELIANCE candlestick and volume chart');
  // No results are published here, so the badge is the overlay to move.
  const panel=await screen.findByRole('group',{name:'RELIANCE price band'});
  const engine=vi.mocked(ChartEngine).mock.results.at(-1)!.value; engine.setStudies.mockClear();
  fireEvent.keyDown(panel,{key:'ArrowRight'});
  expect(engine.setStudies).not.toHaveBeenCalled();
});

it('replenishes the next chart when stepping through the watchlist with chart shortcuts', async () => {
  localStorage.setItem('nexus.chart.watchlist.v2', JSON.stringify(['RELIANCE', 'TCS', 'INFY', 'SBIN']));
  vi.mocked(screenerApi.getChart).mockImplementation(async symbol => ({schemaVersion:2,symbol,asOfDate:'2026-10-02',historyStartDate:'2026-10-01',candles,volumeEvents:{},corporateActions:[],earnings:[],marketNews:[]}));
  setup();
  fireEvent.keyDown(await screen.findByLabelText('RELIANCE candlestick and volume chart'), {key:'.'});
  await screen.findByLabelText('TCS candlestick and volume chart');
  await waitFor(() => expect(screenerApi.getChart).toHaveBeenCalledWith('INFY', 'a'.repeat(64), '2026-10-02'));
  expect(screenerApi.getChart).not.toHaveBeenCalledWith('SBIN', 'a'.repeat(64), '2026-10-02');
});
