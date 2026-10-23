import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { startWorker, runTask } = vi.hoisted(() => ({startWorker:vi.fn(), runTask:vi.fn().mockResolvedValue({type:'warm'})}));
vi.mock('../api/snapshotClient', () => ({startSnapshotWorker:startWorker, runSnapshotTask:runTask}));
const manifest = {schemaVersion:4, revision:'a'.repeat(64), sessionDate:'2026-10-13', totalStocks:1,
  datasetUrl:'/data/stocks.json', datasetPackedGzipUrl:'/data/stocks.packed.json.gz', iposUrl:'/data/ipos.json'};
beforeEach(() => {
  vi.stubEnv('VITE_USE_MOCK', 'false');
  localStorage.clear();
  startWorker.mockClear(); runTask.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear(); });

it('starts the worker before the manifest resolves and shares the pending manifest with the UI', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('DecompressionStream', class {});
  await import('../startup');
  expect(startWorker).toHaveBeenCalledOnce();
  expect(runTask).not.toHaveBeenCalled();
  const {realAdapter} = await import('../api/realAdapter');
  const revision = realAdapter.getCurrentRevision();
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve(new Response(JSON.stringify(manifest)));
  await expect(revision).resolves.toMatchObject({immutableRevision:manifest.revision});
  expect(runTask).toHaveBeenCalledWith({type:'warm', source:{revision:manifest.revision,
    sessionDate:manifest.sessionDate, url:manifest.datasetPackedGzipUrl}});
});

it('reuses a completed startup read once, but subsequent revision checks fetch fresh data', async () => {
  const next = {...manifest, revision:'b'.repeat(64), sessionDate:'2026-10-14'};
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
    .mockResolvedValueOnce(new Response(JSON.stringify(next)));
  vi.stubGlobal('fetch', fetch);
  await import('../startup');
  await vi.waitFor(() => expect(runTask).toHaveBeenCalledOnce());
  const {realAdapter} = await import('../api/realAdapter');
  await expect(realAdapter.getCurrentRevision()).resolves.toMatchObject({immutableRevision:manifest.revision});
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(realAdapter.getCurrentRevision()).resolves.toMatchObject({immutableRevision:next.revision});
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([, options]) => options.cache === 'no-store')).toBe(true);
});

it.each(['offline', 'invalid'])('preserves query errors and retry after %s startup failure', async failure => {
  const fetch = vi.fn();
  if (failure === 'offline') fetch.mockRejectedValueOnce(new Error('offline'));
  else fetch.mockResolvedValueOnce(new Response(JSON.stringify({...manifest, revision:'bad'})));
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(manifest)));
  vi.stubGlobal('fetch', fetch);
  await import('../startup');
  const {realAdapter} = await import('../api/realAdapter');
  await expect(realAdapter.getCurrentRevision()).rejects.toThrow(failure === 'offline' ? 'offline' : 'Invalid scanner dataset manifest');
  expect(runTask).not.toHaveBeenCalled();
  await expect(realAdapter.getCurrentRevision()).resolves.toMatchObject({immutableRevision:manifest.revision});
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['ipo','charts','market'])('does not download stock data or start a worker for a saved %s tab', async tab => {
  localStorage.setItem('nexus-scanner.ui.active-tab.v1', JSON.stringify(tab));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(manifest))));
  await import('../startup');
  const {realAdapter} = await import('../api/realAdapter');
  await realAdapter.getCurrentRevision();
  expect(startWorker).not.toHaveBeenCalled();
  expect(runTask).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});

it('does not preload real data in mock mode', async () => {
  vi.stubEnv('VITE_USE_MOCK', 'true');
  vi.stubGlobal('fetch', vi.fn());
  await import('../startup');
  expect(fetch).not.toHaveBeenCalled();
  expect(startWorker).not.toHaveBeenCalled();
  expect(runTask).not.toHaveBeenCalled();
});

it('warms only the ETF snapshot when reopening a saved ETF universe', async () => {
  localStorage.setItem('nexus-scanner.screener.universe.v1', JSON.stringify('etf'));
  const release = {...manifest, etfDatasetUrl:'/data/etfs.json.gz'};
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(release))));
  await import('../startup');
  await vi.waitFor(() => expect(runTask).toHaveBeenCalledOnce());
  expect(runTask).toHaveBeenCalledWith({type:'warm', source:{revision:manifest.revision,
    sessionDate:manifest.sessionDate, url:release.etfDatasetUrl}});
});
