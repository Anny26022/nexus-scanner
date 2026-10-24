import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('maps IPO identity, listing age, and the anchor unlock schedule from live catalogue keys', async () => {
  const manifest = {revision: '9'.repeat(64), schemaVersion: 4, sessionDate: '2026-10-09', totalStocks: 2,
    datasetUrl: '/stocks.json', iposUrl: '/ipos.json'};
  const payload = {records: [{symbol: 'TEST', isin: 'INE123', security_id: 1234,
    listing_age_calendar_days: 14, anchor_lock_in_end: null, next_anchor_lock_in_date: '2026-12-25',
    anchor_lock_in_calendar: [{listing_date: '2026-09-25', unlock_date: '2026-12-25', tranche: '30'}],
  }, {symbol: 'MISSING'}]};
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, json: async () => payload}));
  const {realAdapter} = await import('../api/realAdapter');
  const [row, missing] = (await realAdapter.getIpoCatalogue()).records;
  expect(row).toMatchObject({isin: 'INE123', securityId: 1234, listingAgeCalendarDays: 14,
    anchorLockInEnd: null, nextAnchorLockInDate: '2026-12-25',
    anchorLockInCalendar: [{listingDate: '2026-09-25', unlockDate: '2026-12-25', tranche: 30}],
  });
  expect(missing.anchorLockInCalendar).toBeNull();
  expect(missing.listingAgeCalendarDays).toBeNull();
});

it('keeps the issue registrar and converts profile financial strings to finite amounts', async () => {
  const manifest = {revision: 'f'.repeat(64), schemaVersion: 4, sessionDate: '2026-10-09', totalStocks: 1,
    datasetUrl: '/stocks.json', iposUrl: '/ipos.json'};
  const payload = {records: [{symbol: 'TEST', provider: {id: 'test'}, profile: {details: {financials: [
    {pl: {total_revenue: '50.25', total_profit: '4.5'}},
    {pl: {total_revenue: 'not available', total_profit: ''}},
  ]}}}], provider_data: {details: {test: {data: {issue: {ipo: {registrar: 'Issue Registrar'}}}}}}};
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, json: async () => payload}));
  const {realAdapter} = await import('../api/realAdapter');
  const [row] = (await realAdapter.getIpoCatalogue()).records;
  expect(row.ipoResearch?.issueDetail?.registrar).toBe('Issue Registrar');
  expect(row.ipoResearch?.profile?.financials).toMatchObject([
    {revenue: 50.25, profit: 4.5}, {revenue: null, profit: null},
  ]);
});

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
    {symbol: 'TEST', issue_price: 302, offer_structure: {issue_size_crore: 365.76}, provider: {id: 'matched', listing_price: 298.95}, profile: {listed: {ipo_start_date: '2026-09-25'}, details: {floor_price: 300, ceiling_price: 305, trading_lot: 10, drhp_doc: 'https://example.com/rhp.pdf', financials: [{date: '2026', unit: 'crores', pl: {total_revenue: 50, total_profit: 4}}]}}, enrichment_conflicts: [{field: 'issue_price', provider: 302, profile: 305}]},
    {symbol: 'MISSING', provider: {id: 'not_fetched'}},
    {symbol: 'INVALID', provider: {id: 'invalid'}},
    {symbol: 'NO_PROVIDER'},
  ], provider_data: {details: {
    matched: {fetched_at: '2026-10-04T06:00:00Z', errors: ['gmp_history: request diagnostic', 'gmp_history: another failure', 'unsafe request diagnostic'], data: {
      issue: {ipo: {price_band_low: 290, price_band_high: 302, lot_size: 50, about: 'Example IPO details', quality_grade: 'B+'}},
      gmp_history: [{ts: '2026-10-03T12:00:00Z', gmp: 4, gmp_pct: 1.3}],
      documents: {documents: [{label: 'Offer document', kind: 'RHP', url: 'https://example.com/rhp.pdf'}]},
    }},
    invalid: {fetched_at: 'not-a-date', errors: []},
  }}};
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ok: true, json: async () => manifest})
    .mockResolvedValueOnce({ok: true, json: async () => payload}));
  const { realAdapter } = await import('../api/realAdapter');
  const rows = await realAdapter.getIpos();
  expect(rows[0].ipoDetailStatus).toEqual({lastSuccessAt: '2026-10-04T06:00:00Z', failedEndpoints: ['gmp_history', 'unknown']});
  expect(rows[0].ipoResearch).toMatchObject({
    issuePrice: 302,
    offer: {issueSizeCrore: 365.76},
    provider: {listingPrice: 298.95},
    issueDetail: {endpoints: ['issue', 'gmp_history', 'documents'], issue: {priceBandLow: 290, priceBandHigh: 302, qualityGrade: 'B+'}, gmpHistory: [{gmp: 4}], documents: [{url: 'https://example.com/rhp.pdf'}]},
    profile: {offer: {floorPrice: 300, ceilingPrice: 305, lotSize: 10}, drhpUrl: 'https://example.com/rhp.pdf', financials: [{revenue: 50, profit: 4}]},
    conflicts: [{field: 'issue_price', provider: 302, secondary: 305}],
  });
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
