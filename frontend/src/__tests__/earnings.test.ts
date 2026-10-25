import {describe, expect, it} from 'vitest';
import {groupRecords, repairText, seasonRecords, summarize, upcomingByDate, UNCLASSIFIED, type EarningsRecord} from '../api/earnings';

const rec = (symbol: string, extra: Partial<EarningsRecord> = {}): EarningsRecord =>
  ({symbol, filing_day: '2026-10-20', period_end: '2026-09-30', isUpcoming: false, ...extra});

describe('earnings', () => {
  it('repairs mojibake and leaves clean text alone', () => {
    const garbled = String.fromCharCode(...new TextEncoder().encode('₹ growth'));
    expect(repairText(garbled)).toBe('₹ growth');
    expect(repairText('Plain')).toBe('Plain');
    expect(repairText(null)).toBeNull();
  });

  it('keeps the newest filing per company for a period', () => {
    const rows = seasonRecords([[rec('A'), rec('A', {filing_day: '2026-10-22', eps: 2})], [rec('B', {period_end: '2026-06-30'})]], '2026-09-30');
    expect(rows).toHaveLength(1);
    expect(rows[0].eps).toBe(2);
  });

  it('summarizes medians and verdicts', () => {
    const summary = summarize([rec('A', {pat_yoy: 10, verdict: 'BEAT'}), rec('B', {pat_yoy: 30, verdict: 'MISS'}), rec('C', {pat_yoy: 20})]);
    expect(summary.medianPatYoy).toBe(20);
    expect(summary.reported).toBe(3);
  });

  it('groups by Nexus classification, never the feed label, and puts Unclassified last', () => {
    const groups = groupRecords([rec('A', {sector: 'Feed Sector'}), rec('B', {sector: 'Feed Sector'}), rec('C')], 'sector',
      symbol => symbol === 'B' ? undefined : {sector: 'Banks'});
    expect(groups.map(group => [group.label, group.records.length])).toEqual([['Banks', 2], [UNCLASSIFIED, 1]]);
  });

  it('groups by theme-file levels', () => {
    const groups = groupRecords([rec('A'), rec('B'), rec('C')], 'macro', symbol => ({macro: symbol === 'C' ? null : 'Energy'}));
    expect(groups.map(group => [group.label, group.records.length])).toEqual([['Energy', 2], [UNCLASSIFIED, 1]]);
  });

  it('groups by curated narrative without a classification', () => {
    const groups = groupRecords([rec('ANANTRAJ'), rec('ZZZZ')], 'narrative', () => undefined);
    expect(groups.map(group => group.label)).toContain('India Data-Centre Buildout');
    expect(groups.at(-1)!.label).toBe(UNCLASSIFIED);
  });

  it('groups upcoming filings by date from today, largest first', () => {
    const days = upcomingByDate([rec('A', {filing_day: '2026-10-01'}), rec('B', {filing_day: '2026-10-25', market_cap: 1}),
      rec('C', {filing_day: '2026-10-25', market_cap: 9})], '2026-10-24');
    expect(days).toHaveLength(1);
    expect(days[0][1].map(row => row.symbol)).toEqual(['C', 'B']);
  });
});
