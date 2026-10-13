import { afterEach, expect, it, vi } from 'vitest';
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

it.each<{schemaVersion:number; invalid?:string}>([
  {schemaVersion:2}, {schemaVersion:3}, ...['symbol', 'future', 'missing', 'duplicate'].map(invalid => ({schemaVersion:3, invalid}))
])('reads or rejects object chart $schemaVersion ($invalid)', async ({schemaVersion, invalid}) => {
  const hash = (letter: string) => letter.repeat(64);
  const candles = ['2025-12-31', '2026-10-01'].map(date => ({date, open:10, high:12, low:9, close:11, volume:100}));
  const metadata = {symbol:'TEST', historyStartDate:'2025-12-31', volumeEvents:{}, corporateActions:[], earnings:[], marketNews:[]};
  const values: Record<string, unknown> = {
    '/data/current.json': {...manifest, schemaVersion:7, dataIndexUrl:'/index.json', objectUrlTemplate:'https://charts.example.com/{hash}.json.gz'},
    '/index.json': {revision:hash('b'), asOfDate:'2026-10-01', chartObjects:{TEST:hash('c')}},
    [`https://charts.example.com/${hash('c')}.json.gz`]: {schemaVersion, ...metadata,
      ...(schemaVersion === 2 ? {candles} : {candleChunks:[hash('d'), hash('e')]})},
    ...Object.fromEntries(['d','e'].map((letter, i) => [`https://charts.example.com/${hash(letter)}.json.gz`,
      {schemaVersion:1, symbol:'TEST', candles:[candles[i]]}]))
  };
  if (invalid === 'symbol') values[`https://charts.example.com/${hash('d')}.json.gz`] = {schemaVersion:1, symbol:'OTHER', candles:[candles[0]]};
  if (invalid === 'future') candles[1].date = '2027-01-01';
  if (invalid === 'missing') delete values[`https://charts.example.com/${hash('d')}.json.gz`];
  if (invalid === 'duplicate') candles[1].date = candles[0].date;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ok:true, json:async()=>values[url],
    arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(values[url])).buffer, headers:new Headers({'Content-Encoding':'gzip'})})));
  const {realAdapter} = await import('../api/realAdapter');
  if (invalid) await expect(realAdapter.getChart('TEST')).rejects.toThrow(invalid === 'symbol' ? 'Chart chunk symbol/schema mismatch' : undefined);
  else await expect(realAdapter.getChart('TEST')).resolves.toEqual({schemaVersion:2, ...metadata, candles, asOfDate:'2026-10-01'});
});
