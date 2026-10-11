import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('accepts browser-decoded gzip catalogues without decompressing them twice', async () => {
  const manifest = {revision: 'c'.repeat(64), schemaVersion: 4, sessionDate: '2026-10-09', totalStocks: 1,
    datasetUrl: '/stocks.json', iposUrl: '/ipos.json.gz'};
  const payload = {records: [{symbol: 'AVTNPL', name: 'Avt Natural Products', close: 94.78}]};
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, arrayBuffer: async () => bytes.buffer, headers: new Headers({'Content-Encoding': 'gzip'})}));
  const {realAdapter} = await import('../api/realAdapter');
  expect((await realAdapter.getIpoCatalogue()).records[0]).toMatchObject({symbol: 'AVTNPL', currentPrice: 94.78});
});

it('still accepts raw gzip catalogues', async () => {
  const manifest = {revision: 'd'.repeat(64), schemaVersion: 4, sessionDate: '2026-10-09', totalStocks: 0,
    datasetUrl: '/stocks.json', iposUrl: '/ipos.json.gz'};
  const bytes = Uint8Array.from(gzipSync(JSON.stringify({records: []})));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, arrayBuffer: async () => bytes.buffer, headers: new Headers()}));
  const {realAdapter} = await import('../api/realAdapter');
  expect((await realAdapter.getIpoCatalogue()).records).toEqual([]);
});

it('rejects uncompressed JSON without gzip encoding at a gzip URL', async () => {
  const manifest = {revision: 'e'.repeat(64), schemaVersion: 4, sessionDate: '2026-10-09', totalStocks: 0,
    datasetUrl: '/stocks.json', iposUrl: '/ipos.json.gz'};
  const bytes = new TextEncoder().encode('{"records":[]}');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, arrayBuffer: async () => bytes.buffer, headers: new Headers()}));
  const {realAdapter} = await import('../api/realAdapter');
  await expect(realAdapter.getIpoCatalogue()).rejects.toThrow('IPO catalogue unavailable');
});

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

it.each([
  [{refresh_complete: true, feeds: {open: {}}, available: true}, 'complete'],
  [{refresh_complete: false, feeds: {open: {}}, available: true}, 'partial'],
  [{refresh_complete: false, feeds: {}, analytics: {gmp: {}}, available: true}, 'partial'],
  [{refresh_complete: false, feeds: {}, available: true}, 'retained'],
  [{refresh_complete: false, feeds: {}, available: false}, 'unavailable'],
  [{feeds: {}, available: true}, 'unknown'],
] as const)('reports provider refresh state without treating attempts as successes', async (provider, state) => {
  const revision = 'b'.repeat(64);
  const manifest = {revision, schemaVersion: 4, sessionDate: '2026-10-06', totalStocks: 0,
    datasetUrl: '/data/stocks.json', iposUrl: '/data/ipos.json'};
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, json: async () => ({records: [], provider_data: {...provider, fetched_at: '2026-10-06T17:00:00Z'}})}));
  const { realAdapter } = await import('../api/realAdapter');
  expect((await realAdapter.getIpoCatalogue()).providerStatus).toEqual({checkedAt: '2026-10-06T17:00:00Z', state});
});
