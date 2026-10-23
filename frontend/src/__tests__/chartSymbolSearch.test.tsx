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

it('lists the watchlist when the box is empty', () => {
  localStorage.setItem('nexus.chart.watchlist.v2', JSON.stringify(['###Ideas', 'TCS', 'RELIANCE']));
  renderSearch();
  expect(screen.getByRole('group', {name: 'Watchlist'})).toHaveTextContent('TCS');
  expect(screen.getByRole('group', {name: 'Watchlist'})).not.toHaveTextContent('RELIANCE');
});
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
  fireEvent.click(screen.getByRole('button', {name: 'Search symbol · RELIANCE'}));
  return {onSelect, input: screen.getByRole('combobox', {name: 'Chart symbol'})};
}

it('opens a palette that suggests matches by ticker or company and picks one with the keyboard', async () => {
  const {onSelect, input} = renderSearch();
  expect(screen.getByRole('dialog', {name: 'Symbol search'})).toBeInTheDocument();
  fireEvent.change(input, {target: {value: 'tata'}});
  expect(await screen.findByRole('option', {name: /TATAPOWER/})).toBeInTheDocument();
  expect(screen.getByRole('option', {name: /TCS Tata Consultancy/})).toBeInTheDocument();
  fireEvent.keyDown(input, {key: 'ArrowDown'});
  fireEvent.submit(input.closest('form')!);
  expect(onSelect).toHaveBeenCalledWith('TATASTEEL');
  expect(screen.queryByRole('dialog', {name: 'Symbol search'})).not.toBeInTheDocument();
});

it('remembers chosen symbols as recents and rejects invalid input', async () => {
  const {onSelect, input} = renderSearch();
  fireEvent.change(input, {target: {value: 'infy'}});
  fireEvent.submit(input.closest('form')!);
  expect(onSelect).toHaveBeenLastCalledWith('INFY');
  expect(JSON.parse(localStorage.getItem('nexus.chart.recent-symbols.v1')!)).toEqual(['INFY']);
  cleanup();

  const second = renderSearch();
  expect(await screen.findByRole('group', {name: 'Recent'})).toHaveTextContent('INFY');
  fireEvent.change(second.input, {target: {value: 'bad symbol!'}});
  fireEvent.submit(second.input.closest('form')!);
  expect(second.onSelect).not.toHaveBeenCalled();
  expect(screen.getByText(/Enter a scanner symbol/)).toBeInTheDocument();
});
