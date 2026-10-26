import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChartEngine, chartTime, crosshairDate } from '../chart/ChartEngine';
import { rebaseSeries } from '../chart/CompareEngine';
import { CompareChart, PriceChart } from '../charts';
import type { Candle } from '../chart/model';

const native = vi.hoisted(() => {
  const series: Array<ReturnType<typeof makeSeries>> = [];
  const scale = {applyOptions: vi.fn(), setAutoScale: vi.fn(), options: vi.fn(() => ({autoScale: true})), getVisibleRange: vi.fn(() => ({from: 100, to: 200})), setVisibleRange: vi.fn()};
  const pane = {paneIndex: vi.fn(() => 0), setStretchFactor: vi.fn()};
  const markers = {setMarkers: vi.fn(), detach: vi.fn()};
  function makeSeries(type: string) {
    return {type, setData: vi.fn(), update: vi.fn(), pop: vi.fn(), applyOptions: vi.fn(), attachPrimitive: vi.fn((primitive: {attached?: (input: unknown) => void}) => primitive.attached?.({requestUpdate: vi.fn()})), detachPrimitive: vi.fn(), priceToCoordinate: vi.fn((price: number) => price), coordinateToPrice: vi.fn((y: number) => y), priceScale: vi.fn(() => scale), getPane: vi.fn(() => pane), moveToPane: vi.fn(), seriesOrder: vi.fn(() => 0), setSeriesOrder: vi.fn(), createPriceLine: vi.fn(() => ({applyOptions: vi.fn()})), removePriceLine: vi.fn()};
  }
  const time = {getVisibleLogicalRange: vi.fn(() => ({from: 0, to: 5})), setVisibleLogicalRange: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(), width: vi.fn(() => 800), logicalToCoordinate: vi.fn((index: number) => index * 10), coordinateToLogical: vi.fn((x: number) => x / 10), timeToCoordinate: vi.fn(() => null), coordinateToTime: vi.fn(() => null), timeToIndex: vi.fn(() => 1), scrollToPosition: vi.fn(), subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn()};
  const chart = {
    addSeries: vi.fn((type: string) => { const result = makeSeries(type); series.push(result); return result; }),
    removeSeries: vi.fn(), applyOptions: vi.fn(), priceScale: vi.fn(() => scale), timeScale: vi.fn(() => time), paneSize: vi.fn(() => ({width: 800, height: 500})),
    panes: vi.fn(() => [pane]), subscribeClick: vi.fn(), unsubscribeClick: vi.fn(), subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), setCrosshairPosition: vi.fn(), clearCrosshairPosition: vi.fn(), takeScreenshot: vi.fn(), remove: vi.fn(),
  };
  return {chart, series, time, createSeriesMarkers: vi.fn(() => markers), createChart: vi.fn(() => chart)};
});
vi.mock('lightweight-charts', () => ({
  createChart: native.createChart, createSeriesMarkers: native.createSeriesMarkers, CandlestickSeries: 'Candlestick', BarSeries: 'Bar', LineSeries: 'Line', HistogramSeries: 'Histogram', AreaSeries: 'Area', BaselineSeries: 'Baseline',
  ColorType: {Solid: 'solid'}, CrosshairMode: {Normal: 0, Magnet: 1, MagnetOHLC: 3}, LineStyle: {Solid: 0, Dotted: 1, Dashed: 2}, PriceScaleMode: {Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3},
}));

const daily: Candle[] = [
  {date: '2026-10-01', open: 10, high: 12, low: 9, close: 11, volume: 100},
  {date: '2026-10-02', open: 11, high: 12, low: 9, close: 10, volume: 120},
];
const intraday: Candle[] = [
  {date: '2026-10-26T03:45:00Z', open: 10, high: 11, low: 9, close: 10.5, volume: 10},
  {date: '2026-10-26T03:50:00Z', open: 10.5, high: 12, low: 10, close: 11.5, volume: 12},
];

beforeEach(() => { vi.clearAllMocks(); native.series.length = 0; });
afterEach(() => { cleanup(); document.body.replaceChildren(); });

it('keeps trading days as business days and turns timestamps into UTC seconds', () => {
  expect(chartTime('2026-10-26')).toBe('2026-10-26');
  expect(chartTime('2026-10-26T03:45:00Z')).toBe(Date.parse('2026-10-26T03:45:00Z') / 1000);
  expect(crosshairDate('2026-10-26')).toBe("Mon 26 Oct '26");
  expect(crosshairDate('2026-10-26T03:45:00Z')).toMatch(/^\w{3} \d{2} \w{3} '26 \d{2}:\d{2}$/);
});

it('plots intraday bars at their timestamps and shows times on the axis', () => {
  const host = document.createElement('div'); document.body.append(host);
  const engine = new ChartEngine(host, intraday, () => {});
  const price = native.series[0];
  expect(price.setData.mock.lastCall?.[0][0].time).toBe(Date.parse('2026-10-26T03:45:00Z') / 1000);
  expect(native.chart.applyOptions).toHaveBeenCalledWith(expect.objectContaining({timeScale: expect.objectContaining({timeVisible: true})}));
  engine.setCandles(daily);
  expect(native.chart.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({timeScale: expect.objectContaining({timeVisible: false})}));
  engine.destroy();
});

it('rebases every series to 0% on the latest common start and skips empty ones', () => {
  const rebased = rebaseSeries([
    {id: 'a', label: 'Defence', points: [{date: '2026-10-01', value: 100}, {date: '2026-10-02', value: 110}, {date: '2026-10-05', value: 121}]},
    {id: 'b', label: 'PSU Banks', points: [{date: '2026-10-02', value: 50}, {date: '2026-10-05', value: 45}]},
    {id: 'c', label: 'Empty', points: []},
  ]);
  expect(rebased.map(entry => entry.id)).toEqual(['a', 'b']);
  expect(rebased[0].points).toEqual([{date: '2026-10-02', change: 0}, {date: '2026-10-05', change: expect.closeTo(10, 6)}]);
  expect(rebased[1].points).toEqual([{date: '2026-10-02', change: 0}, {date: '2026-10-05', change: expect.closeTo(-10, 6)}]);
  expect(rebased[0].color).not.toBe(rebased[1].color);
});

it('renders PriceChart in its own scoped, themed root and follows theme changes', () => {
  const {container, rerender, unmount} = render(<PriceChart candles={daily} theme="dark" tokens={{'--surface': 'hsl(var(--card))'}} movingAverages={[{period: 20}]} visibleBars={60} aria-label="TCS price"/>);
  const root = container.firstElementChild as HTMLElement;
  expect(root).toHaveClass('nexus-scanner-root');
  expect(root.dataset.theme).toBe('dark');
  expect(root.style.getPropertyValue('--surface')).toBe('hsl(var(--card))');
  expect(container.querySelector('[aria-label="TCS price"] .nexus-chart-canvas')).not.toBeNull();
  expect(native.createChart).toHaveBeenCalledTimes(1);
  expect(native.time.setVisibleLogicalRange).toHaveBeenCalled();
  const calls = native.chart.applyOptions.mock.calls.length;
  rerender(<PriceChart candles={daily} theme="light" movingAverages={[{period: 20}]} visibleBars={60} aria-label="TCS price"/>);
  expect(root.dataset.theme).toBe('light');
  expect(native.chart.applyOptions.mock.calls.length).toBeGreaterThan(calls);
  expect(native.createChart).toHaveBeenCalledTimes(1);
  unmount();
  expect(native.chart.remove).toHaveBeenCalled();
});

it('draws one line per CompareChart series and keeps a single zero line', () => {
  const series = [
    {id: 'a', label: 'Defence', points: [{date: '2026-10-01', value: 100}, {date: '2026-10-02', value: 104}]},
    {id: 'b', label: 'EMS', points: [{date: '2026-10-01', value: 20}, {date: '2026-10-02', value: 19}]},
  ];
  const {rerender} = render(<CompareChart series={series}/>);
  const lines = native.series.filter(entry => entry.type === 'Line');
  expect(lines).toHaveLength(2);
  expect(lines[0].setData).toHaveBeenCalledWith([{time: '2026-10-01', value: 0}, {time: '2026-10-02', value: expect.closeTo(4, 6)}]);
  expect(lines[0].createPriceLine).toHaveBeenCalledTimes(1);
  rerender(<CompareChart series={[series[0]]}/>);
  expect(lines[0].removePriceLine).toHaveBeenCalledTimes(1);
  expect(native.chart.removeSeries).toHaveBeenCalledWith(lines[1]);
});
