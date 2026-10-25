import { describe, expect, it } from 'vitest';
import { breakdown, groupsOf, participation, pulseRow, stageCounts, stageOf, themeFlows, type PulseSource } from '../utils/marketPulse';
import type { ThemeClassification } from '../utils/copyResults';

const stock = (symbol: string, sector: string, extra: Partial<PulseSource> & {m?: Record<string, number | null>} = {}): PulseSource => ({
  symbol, name: symbol, sector, industry: `${sector} industry`, close: 110, changePct: 1,
  metrics: {sma10: 100, sma20: 100, sma50: 105, sma150: 100, sma200: 120, return5: 2, return21: 4, return63: 8, return252: 12, NEW_HIGH: 0, NEW_LOW: 0, ...extra.m},
  ...extra,
});

const taxonomy = {schemaVersion: 1, version: 'v', asOfDate: '2026-10-23', records: {
  A: {theme: 'Pharma', subIndustry: null, block: null, macro: null, memberships: {'Weight loss': 'curated'}},
  B: {theme: 'Pharma', subIndustry: null, block: null, macro: null},
  C: {theme: 'Pharma', subIndustry: null, block: null, macro: null},
}} as unknown as ThemeClassification;

describe('market pulse', () => {
  it('stages price against the 150-day average and the 50-day side of it', () => {
    expect(stageOf(110, 105, 100)).toBe(2);
    expect(stageOf(110, 95, 100)).toBe(1);
    expect(stageOf(90, 105, 100)).toBe(3);
    expect(stageOf(90, 95, 100)).toBe(4);
    expect(stageOf(90, null, 100)).toBeNull();
  });

  it('reads highs, lows, returns and moving-average sides from snapshot metrics', () => {
    const row = pulseRow(stock('A', 'Health', {m: {NEW_HIGH: 1}}));
    expect(row).toMatchObject({newHigh: true, newLow: false, stage: 2, returns: {d1: 1, w1: 2, m1: 4, m3: 8, y1: 12}});
    expect(row.above).toEqual({10: true, 20: true, 50: true, 200: false});
    expect(participation([row, pulseRow(stock('B', 'Health', {close: 90}))])[10]).toBe(0.5);
    expect(stageCounts([row])).toEqual({1: 0, 2: 1, 3: 0, 4: 0});
  });

  it('breaks matches down by group, largest first, with shares of all matches', () => {
    const rows = [stock('A', 'Health'), stock('B', 'Health'), stock('C', 'Metals')].map(pulseRow);
    expect(breakdown(rows, 'sector').map(group => [group.name, group.count, group.share, group.children]))
      .toEqual([['Health', 2, 2 / 3, 1], ['Metals', 1, 1 / 3, 1]]);
  });

  it('places a stock in its primary and curated themes, and ranks themes by median move', () => {
    expect(groupsOf(pulseRow(stock('A', 'Health')), 'theme', taxonomy)).toEqual(['Pharma', 'Weight loss']);
    expect(groupsOf(pulseRow(stock('Z', 'Health')), 'theme', taxonomy)).toEqual(['Unclassified']);
    const rows = [stock('A', 'Health', {changePct: 3}), stock('B', 'Health', {changePct: -1}), stock('C', 'Health', {changePct: 1})].map(pulseRow);
    expect(groupsOf(rows[0], 'theme', taxonomy)).toContain('Pharma');
  });

  it('ranks money pockets by value-weighted move and drops repeats of a pocket already listed', () => {
    const traded = (symbol: string, sector: string, move: number, value: number) => ({...stock(symbol, sector, {changePct: move}), rupeeVolumeCrore: value});
    const rows = [traded('A', 'Gold', 30, 100), traded('B', 'Gold', 20, 60), traded('C', 'Gold', -2, 10), traded('D', 'Gold', 1, 10),
      traded('E', 'Steel', -5, 40), traded('F', 'Steel', -4, 40), traded('G', 'Steel', 1, 40), traded('H', 'Steel', 0, 40)].map(pulseRow);
    const pockets = themeFlows(rows, 'd1');
    expect(pockets.map(pocket => [pocket.name, pocket.level])).toEqual([['Gold industry', 'industry'], ['Steel industry', 'industry']]);
    expect(pockets[0].flow).toBeCloseTo((30 * 100 + 20 * 60 - 2 * 10 + 10) / 180);
    expect(pockets[0].leaders[0]).toEqual({symbol: 'A', move: 30});
    expect(themeFlows(rows, 'd1', undefined, -1)[0].name).toBe('Steel industry');
  });
});
