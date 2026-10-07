import { afterEach, expect, it, vi } from 'vitest';
import { filterAnnouncements, type Announcement } from '../api/announcements';
const hash = (value: string) => value.repeat(64);
const revision = hash('a');
const manifest = {revision, schemaVersion: 7, chartRevision: hash('b'), sessionDate: '2026-10-06', totalStocks: 1,
  datasetUrl: '/stocks.json', iposUrl: '/ipos.json', dataIndexUrl: '/index.json', objectUrlTemplate: 'https://cdn.example.com/objects/{hash}.json.gz'};
const row: Announcement = {id: 'filing-1', publishedAt: '2026-10-07T04:30:00Z', headline: 'Order win', topics: ['order_win'], status: 'approved', detailPage: hash('f')};
const catalog = {referenceSession: '2026-10-06', publishedAt: '2026-10-07T06:30:00Z', taxonomy: hash('1'), index: hash('2'),
  symbols: {TEST: {recent: hash('e'), years: {'2026': [{summary: hash('3'), details: hash('f'), count: 1}]}}}};
function response(data: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return {ok: true, json: async () => data, arrayBuffer: async () => bytes.buffer, headers: new Headers({'Content-Encoding': 'gzip'})};
}
function fixture() {
  const values: Record<string, unknown> = {'/data/current.json': manifest, '/index.json': {revision: hash('b'), asOfDate: '2026-10-06', chartObjects: {TEST: hash('c')}, announcements: hash('d')},
    [`https://cdn.example.com/objects/${hash('c')}.json.gz`]: {schemaVersion: 2, symbol: 'TEST', candles: [], corporateActions: [], earnings: [], marketNews: []},
    [`https://cdn.example.com/objects/${hash('d')}.json.gz`]: catalog,
    [`https://cdn.example.com/objects/${hash('e')}.json.gz`]: {symbol: 'TEST', records: [row]},
    [`https://cdn.example.com/objects/${hash('f')}.json.gz`]: {symbol: 'TEST', records: {[row.id]: {news_body: 'Evidence', classification: {topics: ['order_win']}}}},
    [`https://cdn.example.com/objects/${hash('1')}.json.gz`]: {topics: [{id: 'order_win', group: 'business', label: 'Order win'}]},
    [`https://cdn.example.com/objects/${hash('2')}.json.gz`]: {referenceSession: '2026-10-06', publishedAt: catalog.publishedAt, sinceLastClose: '2026-10-06T15:30:00+05:30', records: [{symbol: 'TEST', ...row}]},
    [`https://cdn.example.com/objects/${hash('3')}.json.gz`]: {symbol: 'TEST', records: [row]}};
  const fetcher = vi.fn(async (url: string) => {
    if (!(url in values)) throw new Error('Unexpected request: ' + url);
    return response(values[url]);
  });
  vi.stubGlobal('fetch', fetcher);
  return {fetcher, values};
}
afterEach(() => {vi.unstubAllGlobals(); vi.resetModules();});
it('opens only chart data and reuses the parsed object across release changes', async () => {
  const {fetcher, values} = fixture();
  const {realAdapter, refreshManifest} = await import('../api/realAdapter');
  const chart = await realAdapter.getChart('TEST');
  expect(chart.asOfDate).toBe('2026-10-06');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(chart.regulatoryAnnouncements).toBeUndefined();
  values['/data/current.json'] = {...manifest, revision: hash('4')};
  await refreshManifest();
  await realAdapter.getChart('TEST');
  expect(fetcher.mock.calls.filter(([url]) => url.includes(hash('c')))).toHaveLength(1);
});
it('loads summaries first and fetches evidence only when a filing is opened', async () => {
  const {fetcher} = fixture();
  const {realAdapter} = await import('../api/realAdapter');
  const recent = await realAdapter.getAnnouncements('TEST');
  expect(recent.records).toEqual([row]);
  expect(fetcher.mock.calls.some(([url]) => url.includes(hash('f')))).toBe(false);
  const [a, b] = await Promise.all([realAdapter.getAnnouncementDetail('TEST', row), realAdapter.getAnnouncementDetail('TEST', row)]);
  expect(a).toEqual(b);
  expect(a.news_body).toBe('Evidence');
  expect(fetcher.mock.calls.filter(([url]) => url.includes(hash('f')))).toHaveLength(1);
  await expect(realAdapter.getAnnouncementDetail('TEST', {...row, detailPage: hash('0')})).rejects.toThrow('not part of this release');
});
it('retries failed object reads and validates chart symbols', async () => {
  const {fetcher, values} = fixture();
  const target = `https://cdn.example.com/objects/${hash('c')}.json.gz`;
  let failed = false;
  fetcher.mockImplementation(async url => {
    if (url === target && !failed) {failed = true; throw new Error('offline');}
    return response(values[url]);
  });
  const {realAdapter} = await import('../api/realAdapter');
  await expect(realAdapter.getChart('TEST')).rejects.toThrow('Chart data unavailable');
  await expect(realAdapter.getChart('TEST')).resolves.toMatchObject({symbol: 'TEST'});
  await expect(realAdapter.getAnnouncements('../TEST')).rejects.toThrow('Invalid symbol');
});
it('applies IST last-close and snapshot-relative time windows without including future filings', () => {
  const index = {referenceSession: '2026-10-06', publishedAt: catalog.publishedAt,
    sinceLastClose: '2026-10-06T15:30:00+05:30', records: [row,
      {...row, id: 'before', publishedAt: '2026-10-06T09:00:00Z'},
      {...row, id: 'future', publishedAt: '2026-10-08T00:00:00Z'}]};
  expect(filterAnnouncements(index, {topics: ['order_win'], window: 'since_close'}).map(row => row.id)).toEqual(['filing-1']);
  expect(filterAnnouncements(index, {topics: ['dividend'], window: '7d'})).toEqual([]);
  expect(filterAnnouncements(index, {topics: [], window: '24h'})).toHaveLength(2);
});
it('reads paginated history and taxonomy without downloading evidence', async () => {
  const {fetcher} = fixture();
  const {realAdapter} = await import('../api/realAdapter');
  expect(await realAdapter.getAnnouncementHistory('TEST', 2026)).toEqual({records: [row], pages: 1});
  expect((await realAdapter.getAnnouncementTopics())[0].label).toBe('Order win');
  expect(fetcher.mock.calls.some(([url]) => url.includes(hash('f')))).toBe(false);
  await expect(realAdapter.getAnnouncementHistory('TEST', 2026, 1)).rejects.toThrow('page unavailable');
});
