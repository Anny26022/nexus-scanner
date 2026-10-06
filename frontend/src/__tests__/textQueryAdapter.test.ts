import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../api/snapshotClient', () => ({runSnapshotTask:vi.fn()}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('preserves the requested historical session when its source lacks a manifest date', async () => {
  const revision = 'b'.repeat(64);
  const fetch = vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({
    schemaVersion:4, revision:'a'.repeat(64),sessionDate:'2026-10-01',totalStocks:1,
    datasetUrl:'/data/stocks.json',iposUrl:'/data/ipos.json',
  })}).mockResolvedValueOnce({ok:true,json:async()=>({immutableRevision:revision,rows:[]})});
  vi.stubGlobal('fetch',fetch);
  const {realAdapter} = await import('../api/realAdapter');
  await realAdapter.runScreen({datasetRevision:revision,asOfDate:'2026-09-30',textQuery:'Close Price > 100'} as any);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({asOfDate:'2026-09-30',datasetRevision:revision});
});
