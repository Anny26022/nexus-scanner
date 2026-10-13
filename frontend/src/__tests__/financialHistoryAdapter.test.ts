import {afterEach, expect, it, vi} from 'vitest';

const revision = 'a'.repeat(64), chartRevision = 'b'.repeat(64), digest = 'c'.repeat(64);
const manifest = {revision, chartRevision, schemaVersion: 7, sessionDate: '2026-10-09',
  totalStocks: 1, datasetUrl: '/data/stocks.json', iposUrl: '/data/ipos.json',
  financialHistoryUrl: '/data/financial-history.json.gz', dataIndexUrl: 'https://data.example.com/index.json',
  objectUrlTemplate: 'https://data.example.com/objects/{hash}.json.gz'};
const history = {source: 'ScanX', report_type: 'CONSOLIDATED', amount_unit: 'INR_CRORE',
  metric_units: {eps: 'INR_PER_SHARE'}, quarterly: [{period_end: '2026-06-30', sales: 132.9}],
  standalone: {report_type: 'STANDALONE', quarterly: [{period_end: '2026-06-30', sales: 90}]}};
const payload = {schemaVersion: 1, symbol: 'TEST', history, resultFilings: []};
const index = {revision: chartRevision, asOfDate: manifest.sessionDate,
  financialLookup: {TEST: {history: digest, observedOn: '2026-10-11'}}};
const json = (value: unknown) => ({ok: true, json: async () => value});
const compressed = (value: unknown) => ({ok: true,
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(value)).buffer,
  headers: new Headers({'Content-Encoding': 'gzip'})});
afterEach(() => {vi.unstubAllGlobals(); vi.resetModules();});

it('loads only the selected company and shares cached immutable reads', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(manifest)).mockResolvedValueOnce(json(index))
    .mockResolvedValueOnce(compressed(payload));
  vi.stubGlobal('fetch', fetch);
  const {refreshManifest} = await import('../api/realAdapter');
  await refreshManifest();
  const {screenerApi} = await import('../api/screenerApi');
  const [first, second] = await Promise.all([screenerApi.getFinancialHistory('TEST'), screenerApi.getFinancialHistory('TEST')]);
  expect(first).toEqual(second);
  expect(first.history.observed_on).toBe('2026-10-11');
  expect(first.history.standalone?.observed_on).toBe('2026-10-11');
  expect(first.history.quarterly[0].sales).toBe(132.9);
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/data/current.json', manifest.dataIndexUrl,
    'https://data.example.com/objects/' + digest + '.json.gz']);
});

it('reads older releases through the existing aggregate history URL', async () => {
  const older = 'd'.repeat(64);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(manifest))
    .mockResolvedValueOnce(json({...manifest, revision: older, schemaVersion: 4, dataIndexUrl: undefined}))
    .mockResolvedValueOnce(compressed({TEST: {...history, observed_on: '2026-10-10'}})));
  const {realAdapter} = await import('../api/realAdapter');
  expect((await realAdapter.getFinancialHistory('TEST', older)).history.observed_on).toBe('2026-10-10');
});

it('rejects a mismatched company payload', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(manifest)).mockResolvedValueOnce(json(index))
    .mockResolvedValueOnce(compressed({...payload, symbol: 'OTHER'})));
  const {realAdapter} = await import('../api/realAdapter');
  await expect(realAdapter.getFinancialHistory('TEST')).rejects.toThrow('Financial history symbol/schema mismatch');
});

it('allows a failed object request to be retried', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(manifest)).mockResolvedValueOnce(json(index))
    .mockResolvedValueOnce({ok: false, status: 503}).mockResolvedValueOnce(compressed(payload));
  vi.stubGlobal('fetch', fetch);
  const {realAdapter} = await import('../api/realAdapter');
  await expect(realAdapter.getFinancialHistory('TEST')).rejects.toThrow('Financial history data unavailable');
  await expect(realAdapter.getFinancialHistory('TEST')).resolves.toMatchObject({symbol: 'TEST'});
});
