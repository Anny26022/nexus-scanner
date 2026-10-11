import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../api/mockAdapter';
import { ScreenerRunRequest } from '../types/screener';

describe('MockScreenerAdapter API Engine', () => {
  it('keeps condition coverage unchanged when symbol search narrows results', async () => {
    const request: ScreenerRunRequest = {expressionTree:{type:'group', operator:'all', children:[]},
      universe:'mainboard', asOfDate:'2026-09-28', page:1, pageSize:5};
    const original = await mockAdapter.runScreen(request);
    const searched = await mockAdapter.runScreen({...request, symbolSearch:'no-such-symbol'});
    expect(searched.matchCount).toBe(0);
    expect(searched.perConditionCoverage).toEqual(original.perConditionCoverage);
  });
  it('should fetch condition catalog', async () => {
    const catalog = await mockAdapter.getCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.some((c) => c.id === 'mom_rvol')).toBe(true);
  });

  it('should filter equities based on expression tree and pagination', async () => {
    const req: ScreenerRunRequest = {
      expressionTree: {
        type: 'group',
        operator: 'all',
        children: [
          {
            type: 'condition',
            condition: {
              instanceId: '1',
              conditionId: 'mom_rvol',
              parameters: { minRvol: 2.0, maxRvol: 10.0 },
            },
          },
        ],
      },
      universe: 'mainboard',
      asOfDate: '2026-09-28',
      page: 1,
      pageSize: 5,
    };

    const res = await mockAdapter.runScreen(req);
    expect(res.rows.length).toBeLessThanOrEqual(5);
    expect(res.resolvedSession.date).toBe('2026-09-28');
    expect(res.resolvedSession.isHistorical).toBe(false);
    expect(res.immutableRevision).toContain('rev_20260928');
  });

  it('should flag historical session and return diagnostics', async () => {
    const req: ScreenerRunRequest = {
      expressionTree: {
        type: 'group',
        operator: 'all',
        children: [],
      },
      universe: 'mainboard',
      asOfDate: '2024-05-10',
      page: 1,
      pageSize: 10,
    };

    const res = await mockAdapter.runScreen(req);
    expect(res.resolvedSession.isHistorical).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.unavailableDiagnostics.length).toBeGreaterThan(0);
  });

  it('should validate and normalize custom symbol comparison', async () => {
    const res = await mockAdapter.compareSymbols({
      symbols: ['reliance', 'tcs', 'INVALID_TICKER_999'],
    });

    expect(res.validSymbols.length).toBe(2);
    expect(res.validSymbols[0].symbol).toBe('RELIANCE');
    expect(res.invalidSymbols).toContain('INVALID_TICKER_999');
  });
});
