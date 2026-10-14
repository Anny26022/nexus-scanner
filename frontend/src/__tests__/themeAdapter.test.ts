import {it,expect,vi,afterEach} from 'vitest';
const revision='a'.repeat(64),version='b'.repeat(64);
const manifest={schemaVersion:5,revision,sessionDate:'2026-10-09',totalStocks:1,
  datasetUrl:'/stocks.json',iposUrl:'/ipos.json',themeClassificationUrl:'/themes.json.gz',themeClassificationVersion:version};
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('loads and shares the same release taxonomy once',async()=>{
  const fetch=vi.fn(async(url:string)=>url==='/data/current.json' ? new Response(JSON.stringify(manifest)) :
    new Response(JSON.stringify({schemaVersion:1,version,asOfDate:manifest.sessionDate,records:{}}),{headers:{'Content-Encoding':'gzip'}}));
  vi.stubGlobal('fetch',fetch);
  const {realAdapter}=await import('../api/realAdapter');
  const [first,second]=await Promise.all([realAdapter.getThemeClassification(revision),realAdapter.getThemeClassification(revision)]);
  expect(first).toBe(second);
  expect(fetch.mock.calls.filter(([url])=>url===manifest.themeClassificationUrl)).toHaveLength(1);
});
it('rejects a taxonomy with a different version',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url==='/data/current.json' ? new Response(JSON.stringify(manifest)) :
    new Response(JSON.stringify({schemaVersion:1,version:'c'.repeat(64),asOfDate:manifest.sessionDate,records:{}}),{headers:{'Content-Encoding':'gzip'}})));
  const {realAdapter}=await import('../api/realAdapter');
  await expect(realAdapter.getThemeClassification(revision)).rejects.toThrow('release mismatch');
});
