import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rankSymbols } from '../hooks/useSymbolDirectory';
import { ChartSymbolSearch } from '../components/ChartSymbolSearch';

vi.mock('../api/screenerApi', () => ({screenerApi: {getExportRows: vi.fn(async () => [
  {symbol: 'TATAPOWER', name: 'Tata Power'}, {symbol: 'TATASTEEL', name: 'Tata Steel'},
  {symbol: 'TCS', name: 'Tata Consultancy Services'}, {symbol: 'RELIANCE', name: 'Reliance Industries'},
])}}));

const directory = [
  {symbol: 'TATAPOWER', name: 'Tata Power'}, {symbol: 'TCS', name: 'Tata Consultancy Services'},
  {symbol: 'TATA', name: 'Tata Investments'}, {symbol: 'INFY', name: 'Infosys'},
];

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('ranks an exact ticker first, then prefixes, substrings and company names', () => {
  expect(rankSymbols(directory, 'tata').map(entry => entry.symbol)).toEqual(['TATA', 'TATAPOWER', 'TCS']);
  expect(rankSymbols(directory, 'fos').map(entry => entry.symbol)).toEqual(['INFY']);
  expect(rankSymbols(directory, '  ')).toEqual([]);
});

function renderSearch(onSelect = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient()}>
    <ChartSymbolSearch symbol="RELIANCE" datasetRevision={'a'.repeat(64)} sessionDate="2026-10-22" onSelect={onSelect} onError={vi.fn()} />
  </QueryClientProvider>);
  return {onSelect, input: screen.getByRole('combobox', {name: 'Chart symbol'})};
}

it('suggests matches by ticker or company and picks one with the keyboard', async () => {
  const {onSelect, input} = renderSearch();
  fireEvent.focus(input);
  fireEvent.change(input, {target: {value: 'tata'}});
  expect(await screen.findByRole('option', {name: /TATAPOWER/})).toBeInTheDocument();
  expect(screen.getByRole('option', {name: /TCS Tata Consultancy/})).toBeInTheDocument();
  fireEvent.keyDown(input, {key: 'ArrowDown'});
  fireEvent.submit(input.closest('form')!);
  expect(onSelect).toHaveBeenCalledWith('TATASTEEL');
});

it('remembers chosen symbols as recents and rejects invalid input', () => {
  const {onSelect, input} = renderSearch();
  fireEvent.change(input, {target: {value: 'infy'}});
  fireEvent.submit(input.closest('form')!);
  expect(onSelect).toHaveBeenLastCalledWith('INFY');
  expect(JSON.parse(localStorage.getItem('nexus.chart.recent-symbols.v1')!)).toEqual(['INFY']);
  cleanup();

  const second = renderSearch();
  fireEvent.focus(second.input);
  expect(screen.getByRole('listbox', {name: 'Recent symbols'})).toBeInTheDocument();
  fireEvent.change(second.input, {target: {value: 'bad symbol!'}});
  fireEvent.submit(second.input.closest('form')!);
  expect(second.onSelect).not.toHaveBeenCalled();
});
