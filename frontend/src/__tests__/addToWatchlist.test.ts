import { beforeEach, expect, it } from 'vitest';
import { WATCHLIST_KEY, addSymbolsToWatchlist, loadGrid, openSymbolInCharts, readChartStorage, writeChartStorage } from '../chart/storage';

beforeEach(() => localStorage.clear());

it('appends only new, valid symbols under one section heading', () => {
  writeChartStorage(WATCHLIST_KEY, ['###Swing', 'TCS', 'INFY']);
  expect(addSymbolsToWatchlist(['infy', 'RELIANCE', 'RELIANCE', 'bad symbol!', 'HDFCBANK'], 'Screener · 22 Oct 2026'))
    .toEqual({added: 2, total: 4});
  expect(readChartStorage(WATCHLIST_KEY)).toEqual(['###Swing', 'TCS', 'INFY', '###Screener · 22 Oct 2026', 'RELIANCE', 'HDFCBANK']);

  expect(addSymbolsToWatchlist(['SBIN'], 'Screener · 22 Oct 2026')).toEqual({added: 1, total: 5});
  expect((readChartStorage(WATCHLIST_KEY) as string[]).filter(item => item === '###Screener · 22 Oct 2026')).toHaveLength(1);
});

it('reports when everything is already in the watchlist without writing a heading', () => {
  writeChartStorage(WATCHLIST_KEY, ['TCS']);
  expect(addSymbolsToWatchlist(['TCS'], 'Screener')).toEqual({added: 0, total: 1});
  expect(readChartStorage(WATCHLIST_KEY)).toEqual(['TCS']);
});

it('opens a symbol in the first chart tile and rejects invalid symbols', () => {
  expect(openSymbolInCharts('TATAMOTORS')).toBe(true);
  expect(loadGrid().tiles[0].symbol).toBe('TATAMOTORS');
  expect(openSymbolInCharts('<script>')).toBe(false);
  expect(loadGrid().tiles[0].symbol).toBe('TATAMOTORS');
});
