import { describe, it, expect } from 'vitest';
import {
  getScanHistoryCacheKey,
  computeScanHistorySummary,
  checkScanCompatibility,
  type ScanHistoryPoint,
} from '../api/scanHistoryEngine';
import type { ExpressionNode } from '../types/screener';

describe('scanHistoryEngine', () => {
  it('generates distinct cache keys for different revisions and custom symbols', () => {
    const tree: ExpressionNode = {
      type: 'condition',
      condition: { instanceId: '1', conditionId: 'mom_rvol', parameters: { minRvol: 2 } },
    };

    const key1 = getScanHistoryCacheKey('2022-12-30', 'revA', 'mainboard', tree);
    const key2 = getScanHistoryCacheKey('2022-12-30', 'revB', 'mainboard', tree);
    const key3 = getScanHistoryCacheKey('2022-12-30', 'revA', 'custom', tree, ['TCS', 'INFY']);
    const key4 = getScanHistoryCacheKey('2022-12-30', 'revA', 'custom', tree, ['INFY', 'TCS']);

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    // Custom symbols should normalize order so identical sets match
    expect(key3).toBe(key4);
  });

  it('detects incompatible conditions for historical scanning', () => {
    const fnoBanTree: ExpressionNode = {
      type: 'condition',
      condition: { instanceId: '1', conditionId: 'FNO_BAN', parameters: {} },
    };
    const tvTree: ExpressionNode = {
      type: 'condition',
      condition: { instanceId: '2', conditionId: 'TRADINGVIEW_OSCILLATOR', parameters: { metric: 'RSI' } },
    };
    const validTree: ExpressionNode = {
      type: 'condition',
      condition: { instanceId: '3', conditionId: 'trend_price_vs_ma', parameters: { maPeriod: 50 } },
    };

    expect(checkScanCompatibility(fnoBanTree).compatible).toBe(false);
    expect(checkScanCompatibility(fnoBanTree).reason).toContain('F&O Ban');
    expect(checkScanCompatibility(tvTree).compatible).toBe(false);
    expect(checkScanCompatibility(validTree).compatible).toBe(true);
  });

  it('computes summary statistics excluding failed and error sessions from hit averages', () => {
    const points: ScanHistoryPoint[] = [
      { date: '2022-12-28', count: 10, symbols: ['A', 'B'], status: 'success' },
      { date: '2022-12-29', count: 20, symbols: ['A', 'B', 'C'], status: 'success' },
      { date: '2022-12-30', count: 0, symbols: [], status: 'success' },
      { date: '2022-12-31', count: 0, symbols: [], status: 'error', error: 'HTTP 500' },
    ];

    const summary = computeScanHistorySummary(points, 4);

    expect(summary.totalSessions).toBe(4);
    expect(summary.evaluatedSessions).toBe(3);
    expect(summary.failedSessions).toBe(1);
    // Average should be (10 + 20 + 0) / 3 = 10.0, NOT / 4 = 7.5
    expect(summary.averageMatches).toBe(10);
    expect(summary.peakCount).toBe(20);
    expect(summary.peakDate).toBe('2022-12-29');
    expect(summary.lowestCount).toBe(0);
    expect(summary.lowestDate).toBe('2022-12-30');
    // Non-zero success sessions: 2 out of 3 = 67%
    expect(summary.frequencyPct).toBe(67);
  });
});
