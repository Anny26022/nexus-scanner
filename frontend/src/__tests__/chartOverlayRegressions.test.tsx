import { afterEach, expect, it, vi } from 'vitest';
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
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
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
  const panel=await screen.findByRole('region',{name:'RELIANCE results'});
  const engine=vi.mocked(ChartEngine).mock.results.at(-1)!.value; engine.setStudies.mockClear();
  fireEvent.keyDown(panel,{key:'ArrowRight'});
  expect(engine.setStudies).not.toHaveBeenCalled();
});
