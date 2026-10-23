import { afterEach, expect, it, vi } from 'vitest';
import { aggregate } from '../chart/model';
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
  else {
    await expect(realAdapter.getChart('TEST')).resolves.toEqual({schemaVersion:2, ...metadata, candles, asOfDate:'2026-10-01'});
    const historical = await realAdapter.getChart('TEST', revision, '2025-12-31');
    expect(historical.candles).toEqual(candles.slice(0, 1));
    expect(historical.asOfDate).toBe('2025-12-31');
    expect((await realAdapter.getChart('TEST')).candles).toEqual(candles); // Shared objects stay intact.
  }
});

it('fetches listed candle chunks alongside the chart record', async () => {
  const hash = (letter: string) => letter.repeat(64);
  const candles = ['2025-12-31', '2026-10-01'].map(date => ({date, open:10, high:12, low:9, close:11, volume:100}));
  const metadata = {symbol:'TEST', historyStartDate:'2025-12-31', volumeEvents:{}, corporateActions:[], earnings:[], marketNews:[]};
  const object = (letter: string) => `https://charts.example.com/${hash(letter)}.json.gz`;
  const values: Record<string, unknown> = {
    '/data/current.json': {...manifest, schemaVersion:7, dataIndexUrl:'/index.json', objectUrlTemplate:'https://charts.example.com/{hash}.json.gz'},
    '/index.json': {revision:hash('b'), asOfDate:'2026-10-01', chartObjects:{TEST:hash('c')}, chartChunks:{TEST:[hash('d'), hash('e')]}},
    [object('c')]: {schemaVersion:3, ...metadata, candleChunks:[hash('d'), hash('e')]},
    [object('d')]: {schemaVersion:1, symbol:'TEST', candles:[candles[0]]},
    [object('e')]: {schemaVersion:1, symbol:'TEST', candles:[candles[1]]},
  };
  // Hold the record back: the chunks must already be requested while it is pending.
  let releaseRecord!: () => void;
  const recordGate = new Promise<void>(resolve => { releaseRecord = resolve; });
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requested.push(url);
    if (url === object('c')) await recordGate;
    return {ok:true, json:async()=>values[url], arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(values[url])).buffer,
      headers:new Headers({'Content-Encoding':'gzip'})};
  }));
  const {realAdapter} = await import('../api/realAdapter');
  const chart = realAdapter.getChart('TEST');
  await vi.waitFor(() => expect(requested).toEqual(expect.arrayContaining([object('c'), object('d'), object('e')])));
  releaseRecord();
  await expect(chart).resolves.toEqual({schemaVersion:2, ...metadata, candles, asOfDate:'2026-10-01'});
  expect(requested.filter(url => url === object('d'))).toHaveLength(1);
});

it('caps fallback charts before aggregation and excludes future events', async () => {
  const candles = ['2026-09-28', '2026-09-29', '2026-09-30'].map((date, i) =>
    ({date, open:10, high:i === 2 ? 999 : 12, low:9, close:i === 2 ? 900 : 11, volume:100}));
  const chart = {schemaVersion:2, symbol:'TEST', asOfDate:'2026-10-01', historyStartDate:candles[0].date,
    candles, volumeEvents:{highestEver:{date:'2026-09-30', volume:100}},
    corporateActions:[{ex_date:'2026-09-29'}, {ex_date:'2026-09-30'}],
    earnings:[{filing_date:'2026-09-29'}, {filing_date:'2026-09-30'}],
    marketNews:[{date:'2026-09-29'}, {date:'2026-09-30'}],
    regulatoryAnnouncements:[{date:'2026-09-30'}]};
  const fetcher = vi.fn(async (url:string) => url === '/data/current.json'
    ? {ok:true, json:async()=>manifest}
    : url.endsWith('/release.json') ? {ok:false, status:404}
    : {ok:true, arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(chart)).buffer,
      headers:new Headers({'Content-Encoding':'gzip'})});
  vi.stubGlobal('fetch', fetcher);
  const {screenerApi} = await import('../api/screenerApi');
  const clipped = await screenerApi.getChart('TEST', 'f'.repeat(64), '2026-09-29');
  expect(clipped.candles).toEqual(candles.slice(0, 2));
  for (const interval of ['W', 'M'] as const)
    expect(aggregate(clipped.candles, interval)).toEqual([{...candles[0], volume:200}]);
  expect(clipped).toMatchObject({asOfDate:'2026-09-29', volumeEvents:{}, corporateActions:[{ex_date:'2026-09-29'}],
    earnings:[{filing_date:'2026-09-29'}], marketNews:[{date:'2026-09-29'}], regulatoryAnnouncements:[]});
  expect((await screenerApi.getChart('TEST')).candles).toEqual(candles);
  await expect(screenerApi.getChart('TEST', revision, '2026-02-30')).rejects.toThrow('Invalid chart session date');
});

it.each(['valid', 'wrong revision', 'wrong date', 'duplicate symbols'])(
  'reads only the lightweight chart directory and validates it: %s', async mode => {
    const rows = [{symbol:'LOW',close:10,marketCapCrore:1}, {symbol:'HIGH',close:20,marketCapCrore:2}];
    const payload = {revision: mode === 'wrong revision' ? 'c'.repeat(64) : revision,
      asOfDate:mode === 'wrong date' ? '2026-09-30' : manifest.sessionDate,
      stocks:mode === 'duplicate symbols' ? [rows[0],rows[0]] : rows};
    const fetcher = vi.fn(async (url: string) => url === '/data/current.json'
      ? new Response(JSON.stringify({...manifest,totalStocks:2,chartDirectoryUrl:'/directory.json.gz'}))
      : new Response(JSON.stringify(payload), {headers:{'Content-Encoding':'gzip'}}));
    vi.stubGlobal('fetch',fetcher);
    const {realAdapter} = await import('../api/realAdapter');
    if (mode === 'valid') {
      const result = await Promise.all([realAdapter.getChartRows(revision),realAdapter.getChartRows(revision)]);
      expect(result[0].map(row=>row.symbol)).toEqual(['HIGH','LOW']);
      expect(fetcher.mock.calls.filter(([url])=>url === '/directory.json.gz')).toHaveLength(1);
    } else await expect(realAdapter.getChartRows(revision)).rejects.toThrow('Invalid chart directory');
    expect(fetcher.mock.calls.every(([url])=>['/data/current.json','/directory.json.gz'].includes(url))).toBe(true);
  });

it.each([false,true])('keeps full snapshot fallback for older releases or historical dates: %s',async historical => {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...manifest,
    ...(historical ? {chartDirectoryUrl:'/directory.json.gz'} : {})}))));
  const {realAdapter} = await import('../api/realAdapter');
  const screen = vi.spyOn(realAdapter,'runScreen').mockResolvedValue({rows:[],immutableRevision:revision} as never);
  await realAdapter.getChartRows(revision,historical ? '2026-09-30' : manifest.sessionDate);
  expect(screen).toHaveBeenCalledWith(expect.objectContaining({datasetRevision:revision,
    asOfDate:historical ? '2026-09-30' : manifest.sessionDate}),true);
});
