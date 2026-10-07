import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('maps detail freshness by matched provider ID and exposes only endpoint names', async () => {
  const revision = 'a'.repeat(64);
  const manifest = {revision, schemaVersion: 4, sessionDate: '2026-10-06', totalStocks: 4,
    datasetUrl: '/data/stocks.json', iposUrl: '/data/ipos.json'};
  const payload = {records: [
    {symbol: 'TEST', provider: {id: 'matched'}},
    {symbol: 'MISSING', provider: {id: 'not_fetched'}},
    {symbol: 'INVALID', provider: {id: 'invalid'}},
    {symbol: 'NO_PROVIDER'},
  ], provider_data: {details: {
    matched: {fetched_at: '2026-10-04T06:00:00Z', errors: ['gmp_history: request diagnostic', 'gmp_history: another failure', 'unsafe request diagnostic']},
    invalid: {fetched_at: 'not-a-date', errors: []},
  }}};
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, json: async () => payload}));
  const { realAdapter } = await import('../api/realAdapter');
  const rows = await realAdapter.getIpos();
  expect(rows[0].ipoDetailStatus).toEqual({lastSuccessAt: '2026-10-04T06:00:00Z', failedEndpoints: ['gmp_history', 'unknown']});
  expect(rows[1].ipoDetailStatus).toEqual({lastSuccessAt: null, failedEndpoints: []});
  expect(rows[2].ipoDetailStatus?.lastSuccessAt).toBeNull();
  expect(rows[3].ipoDetailStatus).toBeUndefined();
});
