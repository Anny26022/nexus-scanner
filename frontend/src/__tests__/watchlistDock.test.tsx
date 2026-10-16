import { expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatchlistDock, extractSymbolsFromInput, extractWatchlistItemsFromInput } from '../components/WatchlistDock';
import { screenerApi } from '../api/screenerApi';
import { readChartStorage, writeChartStorage } from '../chart/storage';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

it('extractSymbolsFromInput parses various scanner outputs, table pastes, prefixes, and formats', () => {
  // 1. Screener "Copy Results -> Symbols" format
  expect(extractSymbolsFromInput('NSE:DIXON, NSE:SUZLON, NSE:TRENT')).toEqual(['DIXON', 'SUZLON', 'TRENT']);

  // 2. Screener "Copy Results -> Sector / Industry / Theme" format
  expect(
    extractSymbolsFromInput('###Capital Goods(2),NSE:BEL,NSE:HAL,###Financial Services(1),NSE:HDFCBANK')
  ).toEqual(['BEL', 'HAL', 'HDFCBANK']);

  // 3. Tab-separated rows copied from screener table
  expect(
    extractSymbolsFromInput('DIXON\tDixon Technologies\t14,500.50\nSUZLON\tSuzlon Energy\t75.20')
  ).toEqual(['DIXON', 'SUZLON']);

  // 4. Single symbol with whitespace
  expect(extractSymbolsFromInput('  tcs  ')).toEqual(['TCS']);

  // 5. Symbols with BSE/NSE prefixes and suffixes
  expect(extractSymbolsFromInput('BSE:RELIANCE, INFY.NS, TCS.BO, M&M, BAJAJ-AUTO')).toEqual([
    'RELIANCE',
    'INFY',
    'TCS',
    'M&M',
    'BAJAJ-AUTO',
  ]);

  // 6. JSON array format
  expect(extractSymbolsFromInput('["DIXON", "SUZLON", "TRENT"]')).toEqual(['DIXON', 'SUZLON', 'TRENT']);
});

it('keeps pasted headings and symbols in their original order', () => {
  expect(extractWatchlistItemsFromInput('###Capital Goods(2),NSE:BEL,NSE:HAL,###Banks(1),NSE:HDFCBANK'))
    .toEqual(['###Capital Goods', 'BEL', 'HAL', '###Banks', 'HDFCBANK']);
  expect(extractWatchlistItemsFromInput('###Diamond, Gems & Jewellery\nNSE:XYZ'))
    .toEqual(['###Diamond, Gems & Jewellery', 'XYZ']);
  expect(extractWatchlistItemsFromInput('###Capital Goods(2),BEL,HAL'))
    .toEqual(['###Capital Goods', 'BEL', 'HAL']);
});

it('defaults to an empty watchlist without any hardcoded symbols', () => {
  render(
    <WatchlistDock
      onSelectSymbol={vi.fn()}
    />,
    { wrapper: createWrapper() }
  );

  expect(screen.getByText('Your watchlist is empty')).toBeInTheDocument();
  expect(screen.getByText(/Click/)).toBeInTheDocument();
});

it('renders symbols list, filters symbols, and handles symbol selection', async () => {
  writeChartStorage('watchlist.v2', ['DIXON', 'RELIANCE']);
  const onSelectSymbol = vi.fn();
  const onClose = vi.fn();

  vi.spyOn(screenerApi, 'getExportRows').mockResolvedValue([
      {
        symbol: 'DIXON',
        name: 'Dixon Technologies',
        listingDate: '2017-09-18',
        sector: 'Consumer Durables',
        industry: 'Consumer Electronics',
        series: 'EQ',
        close: 14500.5,
        changePct: 2.85,
        open: 14200,
        high: 14600,
        low: 14150,
      } as any,
      {
        symbol: 'RELIANCE',
        name: 'Reliance Industries',
        listingDate: '1995-11-29',
        sector: 'Energy',
        industry: 'Oil & Gas',
        series: 'EQ',
        close: 2950.0,
        changePct: -1.2,
        open: 2980,
        high: 3000,
        low: 2940,
      } as any,
  ] as any);

  render(
    <WatchlistDock
      datasetRevision="rev123"
      activeSymbol="RELIANCE"
      onSelectSymbol={onSelectSymbol}
      onClose={onClose}
    />,
    { wrapper: createWrapper() }
  );

  // Panel title and layout
  expect(screen.getByRole('complementary', { name: 'Watchlist panel' })).toBeInTheDocument();
  expect(screen.getByText('DIXON')).toBeInTheDocument();
  expect(screen.getByText('RELIANCE')).toBeInTheDocument();

  // Wait for quotes to load
  await waitFor(() => {
    expect(screen.getByText('14,500.50')).toBeInTheDocument();
    expect(screen.getByText('+2.85%')).toBeInTheDocument();
  });

  // Active symbol indicator
  const relianceRow = screen.getByText('RELIANCE').closest('.watchlist-row')!;
  expect(relianceRow).toHaveClass('is-selected');

  // Clicking a symbol row invokes onSelectSymbol
  const dixonRow = screen.getByText('DIXON').closest('.watchlist-row')!;
  fireEvent.click(dixonRow);
  expect(onSelectSymbol).toHaveBeenCalledWith('DIXON');

  // Search filter
  const searchInput = screen.getByLabelText('Filter symbols');
  fireEvent.change(searchInput, { target: { value: 'dixon' } });
  expect(screen.getByText('DIXON')).toBeInTheDocument();
  expect(screen.queryByText('RELIANCE')).not.toBeInTheDocument();

  // Clear search
  fireEvent.change(searchInput, { target: { value: '' } });
  expect(screen.getByText('RELIANCE')).toBeInTheDocument();

  // Optional Close button works when passed
  fireEvent.click(screen.getByTitle('Close watchlist'));
  expect(onClose).toHaveBeenCalled();
});

it('shows prices beyond page 1 without rendering the entire watchlist', async () => {
  const symbols = Array.from({ length: 250 }, (_, index) => `TEST${index}`);
  writeChartStorage('watchlist.v2', symbols);
  const getRows = vi.spyOn(screenerApi, 'getExportRows').mockResolvedValue(symbols.map((symbol, index) => ({
    symbol, name: symbol, close: index + 100, changePct: 1.25,
  })) as any);
  const view = render(<WatchlistDock datasetRevision="rev123" onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });

  await waitFor(() => expect(getRows).toHaveBeenCalledWith(expect.objectContaining({
    universe: 'custom', customSymbols: symbols, pageSize: 100,
  })));
  expect(view.container.querySelectorAll('.watchlist-row').length).toBeLessThan(50);
  const list = screen.getByRole('table', { name: 'Watchlist stocks' });
  fireEvent.scroll(list, { target: { scrollTop: 249 * 40 } });
  expect(screen.getByText('TEST249')).toBeInTheDocument();
  expect(screen.queryByText('TEST0')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Filter symbols'), { target: { value: 'TEST249' } });
  await waitFor(() => expect(screen.getByText('349.00')).toBeInTheDocument());
  expect(screen.getByText('+1.25%')).toBeInTheDocument();
});

it('keeps the viewport at the top while changing sort direction, even when the active symbol moves to the end', async () => {
  const symbols = Array.from({ length: 80 }, (_, index) => `TEST${String(index).padStart(2, '0')}`);
  writeChartStorage('watchlist.v2', symbols);
  vi.spyOn(screenerApi, 'getExportRows').mockResolvedValue(symbols.map((symbol, index) => ({
    symbol, close: 100 + index, changePct: index,
  })) as any);
  render(<WatchlistDock datasetRevision="rev123" activeSymbol="TEST79" onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });
  await waitFor(() => expect(screen.getByText('+0.00%')).toBeInTheDocument());
  const list = screen.getByRole('table', { name: 'Watchlist stocks' });
  Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
  fireEvent.click(screen.getByRole('button', { name: /CHG %/ }));
  expect(list.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: /CHG %/ }));
  expect(list.scrollTop).toBe(0);
  expect(screen.getByText('TEST00')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /CHG %/ }));
  expect(list.scrollTop).toBe(0);
});

it('still scrolls to a symbol selected outside the watchlist', () => {
  const symbols = Array.from({ length: 80 }, (_, index) => `TEST${String(index).padStart(2, '0')}`);
  writeChartStorage('watchlist.v2', symbols);
  const onSelectSymbol = vi.fn();
  const view = render(<WatchlistDock activeSymbol="TEST00" onSelectSymbol={onSelectSymbol} />, { wrapper: createWrapper() });
  const list = screen.getByRole('table', { name: 'Watchlist stocks' });
  Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
  view.rerender(<WatchlistDock activeSymbol="TEST79" onSelectSymbol={onSelectSymbol} />);
  expect(list.scrollTop).toBeGreaterThan(0);
  expect(screen.getByText('TEST79')).toBeInTheDocument();
});

it('keeps unavailable prices and changes below valid values in both sort directions', async () => {
  writeChartStorage('watchlist.v2', ['MISSING', 'LOW', 'HIGH']);
  vi.spyOn(screenerApi, 'getExportRows').mockResolvedValue([
    { symbol: 'LOW', close: 10, changePct: -2 },
    { symbol: 'HIGH', close: 20, changePct: 3 },
  ] as any);
  render(<WatchlistDock datasetRevision="rev123" onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });
  await waitFor(() => expect(screen.getByText('+3.00%')).toBeInTheDocument());
  const order = () => Array.from(document.querySelectorAll('.watchlist-row .watchlist-symbol-name'), node => node.textContent);
  fireEvent.click(screen.getByRole('button', { name: /CHG %/ }));
  expect(order()).toEqual(['HIGH', 'LOW', 'MISSING']);
  fireEvent.click(screen.getByRole('button', { name: /CHG %/ }));
  expect(order()).toEqual(['LOW', 'HIGH', 'MISSING']);
  fireEvent.click(screen.getByRole('button', { name: /LAST/ }));
  expect(order()).toEqual(['HIGH', 'LOW', 'MISSING']);
});

it('distinguishes symbols missing from the snapshot from a loading quote', async () => {
  writeChartStorage('watchlist.v2', ['MISSING']);
  vi.spyOn(screenerApi, 'getExportRows').mockResolvedValue([]);
  render(<WatchlistDock datasetRevision="rev123" onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });
  await waitFor(() => expect(screen.getByText('No data')).toBeInTheDocument());
  expect(screen.getByText('1 symbol not in this snapshot')).toBeInTheDocument();
});

it('shows a retry action when snapshot prices fail to load', async () => {
  writeChartStorage('watchlist.v2', ['BEL']);
  const getRows = vi.spyOn(screenerApi, 'getExportRows').mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([{ symbol: 'BEL', close: 382.35, changePct: 0.62 }] as any);
  render(<WatchlistDock datasetRevision="rev123" onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });
  await waitFor(() => expect(screen.getByText('Prices could not load.')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByText('382.35')).toBeInTheDocument());
  expect(getRows).toHaveBeenCalledTimes(2);
});

it('supports static dock without close button, pasting scanner outputs, and removing symbols', () => {
  render(
    <WatchlistDock
      datasetRevision="rev123"
      onSelectSymbol={vi.fn()}
    />,
    { wrapper: createWrapper() }
  );

  // When static without onClose, no close button is rendered
  expect(screen.queryByTitle('Close watchlist')).not.toBeInTheDocument();

  // Open add symbol form
  fireEvent.click(screen.getByTitle('Add symbol to watchlist'));
  const textarea = screen.getByPlaceholderText(/Add ticker or paste scanner output/i);

  // Paste scanner output with ###Sector format
  fireEvent.change(textarea, {
    target: { value: '###Capital Goods(2),NSE:BEL,NSE:HAL' },
  });
  fireEvent.submit(textarea.closest('form')!);

  // BEL and HAL are added to the list
  expect(screen.getByText('Capital Goods')).toBeInTheDocument();
  expect(screen.getByText('BEL')).toBeInTheDocument();
  expect(screen.getByText('HAL')).toBeInTheDocument();
  expect(readChartStorage('watchlist.v2')).toEqual(['###Capital Goods', 'BEL', 'HAL']);

  // Remove symbol
  const removeBtn = screen.getByTitle('Remove BEL');
  fireEvent.click(removeBtn);
  expect(screen.queryByText('BEL')).not.toBeInTheDocument();
});

it('sorts within pasted sections and excludes headings from quote requests', async () => {
  writeChartStorage('watchlist.v2', ['###Capital Goods', 'BEL', 'HAL', '###Banks', 'HDFCBANK']);
  const getRows = vi.spyOn(screenerApi, 'getExportRows').mockResolvedValue([
    { symbol: 'BEL', close: 100, changePct: 1 },
    { symbol: 'HAL', close: 200, changePct: 2 },
    { symbol: 'HDFCBANK', close: 300, changePct: 3 },
  ] as any);
  render(<WatchlistDock datasetRevision="rev123" onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });

  await waitFor(() => expect(getRows).toHaveBeenCalledWith(expect.objectContaining({
    customSymbols: ['BEL', 'HAL', 'HDFCBANK'],
  })));
  expect(screen.getByText('Capital Goods')).toBeInTheDocument();
  expect(screen.getByText('Banks')).toBeInTheDocument();
  const order = () => Array.from(document.querySelectorAll('.watchlist-section-title, .watchlist-row .watchlist-symbol-name'), node => node.textContent);
  expect(order()).toEqual(['Capital Goods', 'BEL', 'HAL', 'Banks', 'HDFCBANK']);
  fireEvent.click(screen.getByRole('button', { name: /CHG %/ }));
  expect(order()).toEqual(['Capital Goods', 'HAL', 'BEL', 'Banks', 'HDFCBANK']);
});

it('allows a heading-only paste and clears it without a legacy storage key', () => {
  render(<WatchlistDock onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });
  fireEvent.click(screen.getByTitle('Add symbol to watchlist'));
  const textarea = screen.getByPlaceholderText(/Add ticker or paste scanner output/i);
  fireEvent.change(textarea, { target: { value: '###Ideas' } });
  fireEvent.submit(textarea.closest('form')!);
  expect(screen.getByText('Ideas')).toBeInTheDocument();
  expect(readChartStorage('watchlist.v2')).toEqual(['###Ideas']);
  fireEvent.click(screen.getByRole('button', { name: /Clear entire list/i }));
  expect(screen.getByText('Your watchlist is empty')).toBeInTheDocument();
  expect(readChartStorage('watchlist.v2')).toEqual([]);
});

it('navigates symbols via keyboard arrow keys and updates the active symbol', () => {
  writeChartStorage('watchlist.v2', ['DIXON', 'RELIANCE', 'TCS']);
  const onSelectSymbol = vi.fn();
  render(
    <WatchlistDock
      datasetRevision="rev123"
      activeSymbol="DIXON"
      onSelectSymbol={onSelectSymbol}
    />,
    { wrapper: createWrapper() }
  );

  const container = screen.getByRole('table', { name: 'Watchlist stocks' });

  // Pressing ArrowDown moves to next symbol (RELIANCE) and triggers onSelectSymbol
  fireEvent.keyDown(container, { key: 'ArrowDown' });
  expect(onSelectSymbol).toHaveBeenCalledWith('RELIANCE');

  // Pressing ArrowUp moves to previous symbol (DIXON) and triggers onSelectSymbol
  fireEvent.keyDown(container, { key: 'ArrowUp' });
  expect(onSelectSymbol).toHaveBeenCalledWith('DIXON');

  // Pressing End moves to last symbol (TCS)
  fireEvent.keyDown(container, { key: 'End' });
  expect(onSelectSymbol).toHaveBeenCalledWith('TCS');

  // Pressing Home moves to first symbol (DIXON)
  fireEvent.keyDown(container, { key: 'Home' });
  expect(onSelectSymbol).toHaveBeenCalledWith('DIXON');

  // Pressing ArrowDown on a row element also navigates and updates
  const dixonRow = screen.getByText('DIXON').closest('.watchlist-row')!;
  fireEvent.keyDown(dixonRow, { key: 'ArrowDown' });
  expect(onSelectSymbol).toHaveBeenCalledWith('RELIANCE');
});

it('does not hijack typing or caret navigation in watchlist inputs', () => {
  writeChartStorage('watchlist.v2', ['DIXON', 'RELIANCE']);
  const onSelectSymbol = vi.fn();
  render(<WatchlistDock activeSymbol="DIXON" onSelectSymbol={onSelectSymbol} />, { wrapper: createWrapper() });

  const search = screen.getByLabelText('Filter symbols');
  expect(fireEvent.keyDown(search, { key: 'j' })).toBe(true);
  expect(fireEvent.keyDown(search, { key: 'k' })).toBe(true);
  expect(fireEvent.keyDown(search, { key: 'Home' })).toBe(true);
  expect(onSelectSymbol).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTitle('Add symbol to watchlist'));
  const textarea = screen.getByPlaceholderText(/Add ticker or paste scanner output/i);
  expect(fireEvent.keyDown(textarea, { key: 'j' })).toBe(true);
  expect(fireEvent.keyDown(textarea, { key: 'ArrowDown' })).toBe(true);
  expect(onSelectSymbol).not.toHaveBeenCalled();

  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(onSelectSymbol).toHaveBeenCalledExactlyOnceWith('DIXON');
});

it('exposes a mobile watchlist drawer toggle', () => {
  render(<WatchlistDock onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });
  const dock = screen.getByRole('complementary', { name: 'Watchlist panel' });
  const open = screen.getByRole('button', { name: 'Open watchlist panel' });
  expect(open).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(open);
  expect(dock).toHaveClass('is-mobile-open');
  const close = screen.getByRole('button', { name: 'Close watchlist panel' });
  expect(close).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(close);
  expect(dock).not.toHaveClass('is-mobile-open');
});

it('opens dropdown menu beside watchlist and clears entire list', () => {
  writeChartStorage('watchlist.v2', ['DIXON', 'RELIANCE', 'TCS']);
  render(<WatchlistDock onSelectSymbol={vi.fn()} />, { wrapper: createWrapper() });

  expect(screen.getByText('DIXON')).toBeInTheDocument();
  expect(screen.getByText('RELIANCE')).toBeInTheDocument();

  // 1. Click dropdown trigger beside Watchlist
  const menuTrigger = screen.getByTitle('Watchlist options');
  fireEvent.click(menuTrigger);

  // 2. Click "Clear entire list" in dropdown
  const clearBtn = screen.getByRole('button', { name: /Clear entire list/i });
  fireEvent.click(clearBtn);

  // 3. Watchlist is now empty
  expect(screen.getByText('Your watchlist is empty')).toBeInTheDocument();
  expect(screen.queryByText('DIXON')).not.toBeInTheDocument();
});
