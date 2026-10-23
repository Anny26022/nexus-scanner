import { expect, it } from 'vitest';
import { positionSizing, positionSizingConfig } from '../chart/positionSizing';

const daily = [
  {date: '2026-10-21', open: 100, high: 104, low: 96, close: 100, volume: 1},
  {date: '2026-10-22', open: 101, high: 106, low: 98, close: 102, volume: 1},
  {date: '2026-10-23', open: 102, high: 103, low: 95, close: 97, volume: 1},
];

it('matches the TradingView script for a long', () => {
  // ₹10 lakh at 0.5% risks ₹5,000.
  const sizing = positionSizing(daily, '2026-10-22', positionSizingConfig({enabled: true}))!;
  expect(sizing.long).toBe(true);
  expect(sizing.riskAmount).toBe(5000);
  const [dl, pdl, sl1, sl2] = sizing.rows;
  expect(dl).toMatchObject({name: 'DL', stopPrice: 98, qty: 1250}); // 5000 / (102 - 98)
  expect(dl.stopPercent).toBeCloseTo(3.92, 2);
  expect(dl.allocationPercent).toBeCloseTo(12.75, 2); // 1250 × 102 / 10,00,000
  expect(pdl).toMatchObject({name: 'PDL', stopPrice: 96, qty: 833}); // floor(5000 / 6)
  expect(sl1).toMatchObject({name: 'SL 1', stopPercent: 2, qty: 2450}); // floor(5000 / 2.04)
  expect(sl1.stopPrice).toBeCloseTo(99.96, 2);
  expect(sl2).toMatchObject({name: 'SL 2', stopPercent: 5, qty: 980});
  expect(sizing.rows).toHaveLength(4); // SL 3 and SL 4 are off by default
});

it('uses highs for shorts and picks the side from the day change in Both', () => {
  const short = positionSizing(daily, '2026-10-23', positionSizingConfig({side: 'short'}))!;
  expect(short.rows.slice(0, 2).map(row => [row.name, row.stopPrice, row.qty])).toEqual([['DH', 103, 833], ['PDH', 106, 555]]);
  expect(short.rows[2].stopPrice).toBeCloseTo(98.94, 2);
  expect(positionSizing(daily, '2026-10-23', positionSizingConfig({side: 'both'}))!.long).toBe(false); // -4.9% day
  expect(positionSizing(daily, '2026-10-22', positionSizingConfig({side: 'both'}))!.long).toBe(true);
});

it('floors a zero stop distance at one tick and needs a previous bar', () => {
  const flat = [daily[0], {...daily[1], low: 102}];
  expect(positionSizing(flat, '2026-10-22', positionSizingConfig())!.rows[0].qty).toBe(100000); // 5000 / 0.05
  expect(positionSizing(daily, '2026-10-21', positionSizingConfig())).toBeNull();
});

it('clamps settings to the script ranges', () => {
  const config = positionSizingConfig({riskPercent: 9, stops: [{enabled: true, percent: 40, color: ''}], lineLength: 0, position: 'nowhere' as never});
  expect(config.riskPercent).toBe(2);
  expect(config.stops[0]).toEqual({enabled: true, percent: 10, color: '#f2df6c'});
  expect(config.lineLength).toBe(1);
  expect(config.position).toBe('bottom-left');
});
