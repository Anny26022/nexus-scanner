import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const adapter = () => ({
    getCatalog: vi.fn(async () => []), explainScreen: vi.fn(async () => ({})),
    runScreen: vi.fn(async () => ({})), getIpos: vi.fn(async () => [{symbol: 'TEST'}]),
    getIpoCatalogue: vi.fn(async () => ({records: [], details: {}})),
    compareSymbols: vi.fn(async () => ({})), getCurrentRevision: vi.fn(async () => ({revision: 'test'})),
    getChart: vi.fn(async () => ({symbol: 'TEST'})),
    getAnnouncementIndex: vi.fn(async () => ({})), getAnnouncementTopics: vi.fn(async () => []),
    getAnnouncements: vi.fn(async () => ({})), getAnnouncementHistory: vi.fn(async () => ({})),
    getAnnouncementDetail: vi.fn(async () => ({})),
  });
  return {real: adapter(), mock: adapter(), mockLoads: 0, failMockRead: false};
});
vi.mock('../api/realAdapter', () => ({realAdapter: fixtures.real}));
vi.mock('../api/mockAdapter', () => {
  fixtures.mockLoads++;
  return {get mockAdapter() {
    if (fixtures.failMockRead) {fixtures.failMockRead = false; throw new Error('Transient mock load failure');}
    return fixtures.mock;
  }};
});

beforeEach(() => {vi.resetModules(); vi.clearAllMocks(); fixtures.mockLoads = 0; fixtures.failMockRead = false;});
afterEach(() => vi.unstubAllEnvs());

it('never loads mocks in real mode and preserves the real catalogue metadata', async () => {
  vi.stubEnv('VITE_USE_MOCK', 'false');
  const {screenerApi} = await import('../api/screenerApi');
  await screenerApi.getCatalog();
  expect(await screenerApi.getIpoCatalogue()).toEqual({records: [], details: {}});
  await screenerApi.getChart('TEST', 'revision');
  expect(fixtures.real.getChart).toHaveBeenCalledWith('TEST', 'revision');
  expect(fixtures.mockLoads).toBe(0);
});

it('loads mocks once on demand while keeping announcements real and restrictions intact', async () => {
  vi.stubEnv('VITE_USE_MOCK', 'true');
  const {screenerApi} = await import('../api/screenerApi');
  expect(fixtures.mockLoads).toBe(0);
  await screenerApi.getAnnouncementIndex();
  expect(fixtures.real.getAnnouncementIndex).toHaveBeenCalledOnce();
  expect(fixtures.mockLoads).toBe(0);
  await expect(screenerApi.getChart('TEST')).rejects.toThrow('Charts are unavailable in mock mode');
  await expect(screenerApi.runScreen({announcementFilter: {}} as never)).rejects.toThrow('Announcement filters are unavailable in mock mode');
  expect(fixtures.mockLoads).toBe(0);
  await Promise.all([screenerApi.getCatalog(), screenerApi.getCurrentRevision()]);
  expect(fixtures.mockLoads).toBe(1);
  expect(await screenerApi.getIpoCatalogue()).toEqual({records: [{symbol: 'TEST'}]});
  expect(fixtures.mock.getCatalog).toHaveBeenCalledOnce();
  expect(fixtures.mock.getCurrentRevision).toHaveBeenCalledOnce();
  expect(fixtures.real.getCatalog).not.toHaveBeenCalled();
});

it('shares a rejected adapter-load promise and allows the next call to retry', async () => {
  vi.stubEnv('VITE_USE_MOCK', 'true');
  fixtures.failMockRead = true;
  const {screenerApi} = await import('../api/screenerApi');
  const failed = await Promise.allSettled([screenerApi.getCatalog(), screenerApi.getCurrentRevision()]);
  expect(failed.every(result => result.status === 'rejected')).toBe(true);
  expect(fixtures.mock.getCatalog).not.toHaveBeenCalled();
  await expect(screenerApi.getCatalog()).resolves.toEqual([]);
  expect(fixtures.mock.getCatalog).toHaveBeenCalledOnce();
});
