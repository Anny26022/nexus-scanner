import { afterEach, expect, it, vi } from 'vitest';
const revision='a'.repeat(64);
const manifest={revision,schemaVersion:6,sessionDate:'2026-10-22',totalStocks:1,datasetUrl:'/data/stocks.json',iposUrl:'/data/ipos.json',chartRevision:'b'.repeat(64),chartUrlTemplate:'https://charts.example/{symbol}.json.gz',financialHistoryUrl:'/data/financial-history.json.gz',earningsCalendarUrl:'/data/earnings-calendar.json.gz'};
const response=(data:unknown)=>({ok:true,headers:new Headers({'Content-Encoding':'gzip'}),arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(data)).buffer});
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('loads and shares the immutable statement asset across chart symbols',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>manifest}).mockResolvedValue(response({TEST:{observed_on:'2026-10-11'},OTHER:{observed_on:'2026-10-12'}}));
  vi.stubGlobal('fetch',fetch);
  const {realAdapter}=await import('../api/realAdapter');
  expect(await realAdapter.getFinancialHistory('TEST',revision)).toMatchObject({observed_on:'2026-10-11'});
  expect(await realAdapter.getFinancialHistory('OTHER',revision)).toMatchObject({observed_on:'2026-10-12'});
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('does not substitute latest financials when a historical release is missing',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>manifest}).mockResolvedValue({ok:false,status:404});
  vi.stubGlobal('fetch',fetch);
  const {realAdapter}=await import('../api/realAdapter');
  await expect(realAdapter.getFinancialHistory('TEST','c'.repeat(64))).rejects.toThrow('not published');
  expect(fetch.mock.calls.some(([url])=>url===manifest.financialHistoryUrl)).toBe(false);
});
it('retains the schedule observation date and only returns the requested symbol',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>manifest}).mockResolvedValue(response({fetched_at:'2026-10-22T12:00:00Z',events:[{symbol:'TEST',scheduled_date:'2026-10-25'},{symbol:'OTHER',scheduled_date:'2026-10-24'}]})));
  const {realAdapter}=await import('../api/realAdapter');
  expect(await realAdapter.getEarningsSchedule('TEST',revision)).toEqual({observedOn:'2026-10-22',events:[{symbol:'TEST',scheduled_date:'2026-10-25'}]});
});
