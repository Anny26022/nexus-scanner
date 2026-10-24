import { describe, expect, it } from 'vitest';
import { bounds, fitSelection, heading, quadrantOf, rotation } from '../utils/rrg';
import { decode, displayLabel, itemsFor, rangeLength, type RotationIndex } from '../api/rotation';

const index = {
  schemaVersion: 1, asOfDate: '2026-10-23', scale: 10_000,
  frames: {D: Array.from({length: 100}, (_, i) => `d${i}`), W: Array.from({length: 40}, (_, i) => `w${i}`), M: ['m']},
  benchmarks: {N50: {name: 'Nifty 50', series: {D: null, W: null, M: null}}, N500: {name: 'Nifty 500', series: {D: null, W: null, M: null}}},
  universes: {N50: 'Nifty 50'},
  stocks: [{s: 'A', n: 'Alpha', u: ['N50', 'N500'], h: 'core'}, {s: 'B', n: 'Beta', u: [], h: 'rest'}, {s: 'C', n: 'Gamma', u: ['N500'], h: 'core'}],
  groups: [{id: 'sector:Banks', l: 'sector', n: 'Banks', m: ['A', 'B']}],
  shards: {core: 'x', rest: 'y', groups: 'z'},
} as RotationIndex;

describe('rotation maths', () => {
  it('fits the selected outlier path and restarts warm-up after missing coverage', () => {
    expect(fitSelection({x: 2, y: 1}, [NaN, 160, 101], [NaN, 80, 101], 0, 2)).toEqual({x: 69, y: 23});
    const price = Array.from({length: 90}, () => 100);
    price[45] = NaN;
    const {ratio, momentum} = rotation(price, Array.from({length: 90}, () => 100));
    expect(Number.isNaN(ratio[46])).toBe(true);
    expect(Number.isNaN(momentum[70])).toBe(true);
    expect(momentum[89]).toBe(100);
  });
  it('rotates from leading into weakening once outperformance fades', () => {
    const benchmark = Array.from({length: 120}, () => 100);
    // Flat, a steady climb against the benchmark, then flat again at the higher level.
    const price = Array.from({length: 120}, (_, i) => i < 40 ? 100 : i < 70 ? 100 + (i - 40) * 2 : 160);
    const {ratio, momentum} = rotation(price, benchmark);
    expect(Number.isNaN(ratio[10])).toBe(true);
    expect(ratio[60]).toBeGreaterThan(100);
    expect(momentum[60]).toBeGreaterThan(100);
    const weakening = Array.from({length: 40}, (_, k) => 70 + k).find(i => ratio[i] > 100 && momentum[i] < 100);
    expect(weakening).toBeDefined();
  });

  it('places points in quadrants and measures heading', () => {
    expect(quadrantOf({x: 100, y: 100})).toBe('leading');
    expect(quadrantOf({x: 101, y: 99})).toBe('weakening');
    expect(quadrantOf({x: 99, y: 99})).toBe('lagging');
    expect(quadrantOf({x: 99, y: 101})).toBe('improving');
    expect(heading({x: 100, y: 100}, {x: 100, y: 101})?.angle).toBe(90);
    expect(heading(undefined, {x: 1, y: 1})).toBeNull();
  });

  it('scales each axis to its own spread and ignores a lone outlier', () => {
    const points = [...Array.from({length: 99}, (_, i) => ({x: 100 + (i % 3), y: 99.5})), {x: 160, y: 100}];
    const half = bounds(points);
    expect(half.x).toBeLessThan(5);
    expect(half.y).toBeLessThan(half.x);
  });
});

describe('rotation history', () => {
  it('preserves missing composite periods through decoding', () => {
    const values = decode([0, 46052, null, 953], 3, 10_000);
    expect(values[0]).toBeCloseTo(100, 1);
    expect(Number.isNaN(values[1])).toBe(true);
    expect(values[2]).toBeCloseTo(110, 1);
  });
  it('decodes delta-coded logs with an offset', () => {
    const values = decode([1, 46052, 0, 953], 4, 10_000);
    expect(Number.isNaN(values[0])).toBe(true);
    expect(values[1]).toBeCloseTo(100, 1);
    expect(values[3]).toBeCloseTo(110, 1);
  });

  it('selects stocks by index, watchlist and group membership', () => {
    expect(itemsFor(index, {kind: 'stocks', code: 'N50'}, new Set()).map(item => item.id)).toEqual(['A']);
    expect(itemsFor(index, {kind: 'stocks', code: 'WATCH'}, new Set(['B'])).map(item => item.id)).toEqual(['B']);
    expect(itemsFor(index, {kind: 'level', level: 'sector'}, new Set())[0]).toMatchObject({label: 'Banks', detail: '2 stocks', shard: 'groups'});
    expect(itemsFor(index, {kind: 'members', group: 'sector:Banks'}, new Set()).map(item => item.id)).toEqual(['A', 'B']);
  });

  it('clamps replay ranges to the history after warm-up', () => {
    expect(rangeLength(index, 'D', '1M')).toBe(21);
    expect(rangeLength(index, 'W', '5Y')).toBe(40 - 36);
  });
});

describe('rotation views', () => {
  it('measures travel against each axis spread and applies liquidity filters', async () => {
    const {travel} = await import('../api/rotation');
    const {passes, NO_FILTERS} = await import('../components/rotation/RotationFilters');
    const track = {item: {id: 'A', label: 'A', detail: '', kind: 'stock' as const, shard: 'core' as const},
      ratio: Float64Array.from([NaN, 100, 101, 102]), momentum: Float64Array.from([NaN, 100, 100, 101])};
    expect(travel(track, 3, 5, {x: 2, y: 1})).toBeCloseTo(Math.hypot(1, 1));
    expect(travel(track, 1, 5, {x: 2, y: 1})).toBe(0);
    const stock = {cap: 500, turnover: 2, band: '20'};
    expect(passes(NO_FILTERS, stock)).toBe(true);
    expect(passes({...NO_FILTERS, minCap: 1000}, stock)).toBe(false);
    expect(passes({...NO_FILTERS, minTurnover: 1, bands: ['20']}, stock)).toBe(true);
    expect(passes({...NO_FILTERS, bands: ['5']}, stock)).toBe(false);
  });

  it('carries liquidity fields onto stock items', () => {
    const withFields = {...index, stocks: [{s: 'A', n: 'Alpha', u: ['N50'], h: 'core' as const, c: 1200, t: 8, b: '20'}]};
    expect(itemsFor(withFields, {kind: 'stocks', code: 'N50'}, new Set())[0]).toMatchObject({cap: 1200, turnover: 8, band: '20'});
  });
});

it('softens shouting labels but keeps acronyms', () => {
  expect(displayLabel('FMCG CLUSTERS')).toBe('FMCG Clusters');
  expect(displayLabel('BANKING & FINANCIAL SERVICES')).toBe('Banking & Financial Services');
  expect(displayLabel('Lifestyle & Retail')).toBe('Lifestyle & Retail');
  expect(displayLabel('DATA CENTER ECOSYSTEM')).toBe('Data Center Ecosystem');
  expect(displayLabel('IT PSU')).toBe('IT PSU');
});
