import { afterEach, expect, it, vi } from 'vitest';
import { SCANNER_IDENTITY } from '../engine/compatibility';
const revision = 'a'.repeat(64);
const manifest = { revision, schemaVersion:6, sessionDate:'2026-10-01', totalStocks:1,
  datasetUrl:'/data/stocks.json', iposUrl:'/data/ipos.json', chartRevision:'b'.repeat(64),
  chartUrlTemplate:'https://charts.example.com/{symbol}.json.gz' };
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it.each([{datasetUrl:''}, {iposUrl:''}, {sessionDate:'2026-02-30'}, {chartUrlTemplate:'https://charts.example.com/'}, {totalStocks:-1}])('rejects malformed manifest %j', async bad => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({...manifest,...bad})}));
  const { refreshManifest } = await import('../api/realAdapter');
  await expect(refreshManifest()).rejects.toThrow('Invalid scanner dataset manifest');
});
it('exposes charts through screenerApi and accepts browser decoded gzip',async()=>{
  const chart = {symbol:'TEST',asOfDate:'2026-10-01',candles:[]};
  const bytes=new TextEncoder().encode(JSON.stringify(chart));
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>manifest})
    .mockResolvedValueOnce({ok:true,arrayBuffer:async()=>bytes.buffer,headers:new Headers({'Content-Encoding':'gzip'})}));
  const { screenerApi }=await import('../api/screenerApi');
  await expect(screenerApi.getChart('TEST')).resolves.toEqual(chart);
});
it('reports corrupt chart data consistently',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>manifest})
    .mockResolvedValueOnce({ok:true,arrayBuffer:async()=>new TextEncoder().encode('<html>error</html>').buffer,headers:new Headers()}));
  const { realAdapter }=await import('../api/realAdapter');
  await expect(realAdapter.getChart('TEST')).rejects.toThrow('Chart data unavailable');
});
it('rejects incompatible schema-7 releases before using their packs',async()=>{
  const descriptor={url:'/data/core.json.gz',bytes:1,sha256:'a'.repeat(64),schemaVersion:7,encoding:'gzip'};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({...manifest,schemaVersion:7,
    engineVersion:'old',conditionContractHash:'b'.repeat(64),
    packs:{core:descriptor,technical:descriptor,fundamentals:descriptor}})}));
  const { refreshManifest }=await import('../api/realAdapter');
  await expect(refreshManifest()).rejects.toThrow('incompatible');
});
it('rejects incompatible historical schema-7 releases before loading stocks',async()=>{
  const descriptor={url:'/data/core.json.gz',bytes:1,sha256:'a'.repeat(64),schemaVersion:7,encoding:'gzip'};
  const current={...manifest,schemaVersion:7,...SCANNER_IDENTITY,packs:{core:descriptor,technical:descriptor,fundamentals:descriptor}};
  const historical={...current,revision:'c'.repeat(64),engineVersion:'old'};
  const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>current})
    .mockResolvedValueOnce({ok:true,json:async()=>historical});
  vi.stubGlobal('fetch',fetcher);
  const { realAdapter }=await import('../api/realAdapter');
  await expect(realAdapter.runScreen({asOfDate:'2026-10-01',datasetRevision:historical.revision,universe:'mainboard',page:1,pageSize:50,
    expressionTree:{type:'group',operator:'all',children:[]}})).rejects.toThrow('incompatible');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
