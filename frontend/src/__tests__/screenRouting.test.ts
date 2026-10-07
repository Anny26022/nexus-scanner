import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScreenerRunRequest } from '../types/screener';
const snapshotTask=vi.hoisted(()=>vi.fn());
vi.mock('../api/snapshotClient',()=>({runSnapshotTask:snapshotTask}));
const revision='a'.repeat(64),session='2026-10-01';
const manifest={revision,schemaVersion:7,sessionDate:session,totalStocks:1,
  datasetUrl:'/data/stocks.json',iposUrl:'/data/ipos.json',
  packs:Object.fromEntries(['core','technical','fundamentals'].map(name=>[name,{
    schemaVersion:7,encoding:'gzip',url:`/data/${name}.json.gz`,bytes:100,sha256:'b'.repeat(64),
  }]))};
const request:ScreenerRunRequest={datasetRevision:revision,asOfDate:session,universe:'mainboard',page:1,pageSize:10,
  expressionTree:{type:'group',operator:'all',children:[]}};
beforeEach(()=>snapshotTask.mockReset());
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('runs scalar text through the browser without posting to the API',async()=>{
  const result={immutableRevision:revision,rows:[],matchCount:0};
  snapshotTask.mockResolvedValue({type:'screen',result,revision,sessionDate:session});
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(manifest)));vi.stubGlobal('fetch',fetcher);
  const {realAdapter}=await import('../api/realAdapter');
  expect(await realAdapter.runScreen({...request,textQuery:'Market Cap > 2000 AND Close Price > 50 DMA'})).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(snapshotTask.mock.calls[0][0].request).toMatchObject({textQuery:undefined,expressionTree:{type:'group',operator:'all'}});
});
it('sends the complete mixed expression remotely without a partial local scan',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response(JSON.stringify({immutableRevision:revision,rows:[]})));
  vi.stubGlobal('fetch',fetcher);
  const {realAdapter}=await import('../api/realAdapter');
  const textQuery='Market Cap > 2000 OR RSI(14) > 50';
  await realAdapter.runScreen({...request,textQuery});
  expect(snapshotTask).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[1][0]).toBe('/api/screens/run');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({textQuery,datasetRevision:revision,asOfDate:session});
});
it('rejects incomplete text without executing a reduced query',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const {realAdapter}=await import('../api/realAdapter');
  await expect(realAdapter.runScreen({...request,textQuery:'Market Cap > 2000 AND magic stocks'})).rejects.toThrow('Unsupported query clause');
  expect(fetcher).not.toHaveBeenCalled();expect(snapshotTask).not.toHaveBeenCalled();
});

it('keeps announcement selection when routing scalar text to the browser', async () => {
  const result = { immutableRevision: revision, rows: [], matchCount: 0 };
  snapshotTask.mockResolvedValue({ type: 'screen', result, revision, sessionDate: session });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(manifest))));
  const { realAdapter } = await import('../api/realAdapter');
  vi.spyOn(realAdapter, 'getAnnouncementIndex').mockResolvedValue({
    referenceSession: session,
    publishedAt: '2026-10-02T06:00:00Z',
    sinceLastClose: '2026-10-01T10:00:00Z',
    records: [
      { id: 'order', symbol: 'AAA', publishedAt: '2026-10-02T04:00:00Z', headline: 'Order', topics: ['order_win'], status: 'approved', detailPage: '' },
      { id: 'other', symbol: 'BBB', publishedAt: '2026-10-02T04:00:00Z', headline: 'Other', topics: ['results'], status: 'approved', detailPage: '' },
    ],
  });
  await realAdapter.runScreen({
    ...request,
    textQuery: 'Market Cap > 2000',
    announcementFilter: { topics: ['order_win'], window: 'since_close' },
  });
  expect(snapshotTask.mock.calls[0][0].request).toMatchObject({
    datasetRevision: revision,
    announcementSymbols: ['AAA'],
    textQuery: undefined,
  });
});
