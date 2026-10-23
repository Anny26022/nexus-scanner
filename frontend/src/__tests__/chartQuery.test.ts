import { expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import { prefetchCharts } from '../chart/chartQuery';

vi.mock('../api/screenerApi', () => ({screenerApi: {getChart: vi.fn()}}));

it('waits for the selected chart, warms only one neighbour and wraps in either direction', async () => {
  const client = new QueryClient();
  const snapshot = {schemaVersion: 2 as const, symbol: 'C', asOfDate: '2026-10-23', historyStartDate: '2026-10-23', candles: [], volumeEvents: {}, corporateActions: [], earnings: [], marketNews: []};
  let finish!: (value: typeof snapshot) => void;
  vi.mocked(screenerApi.getChart).mockResolvedValue(snapshot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  prefetchCharts(client, ['A', 'B', 'C'], 'C', 'revision', '2026-10-23');
  expect(screenerApi.getChart).toHaveBeenCalledTimes(1);
  expect(screenerApi.getChart).toHaveBeenLastCalledWith('C', 'revision', '2026-10-23');
  finish(snapshot);
  await vi.waitFor(() => expect(screenerApi.getChart).toHaveBeenCalledTimes(2));
  expect(screenerApi.getChart).toHaveBeenLastCalledWith('A', 'revision', '2026-10-23');
  vi.mocked(screenerApi.getChart).mockClear();
  prefetchCharts(client, ['A', 'B', 'C'], 'C', 'revision', '2026-10-23', -1);
  await vi.waitFor(() => expect(screenerApi.getChart).toHaveBeenCalledWith('B', 'revision', '2026-10-23'));
  client.clear();
});
