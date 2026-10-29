import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScanHistoryPanel } from '../components/ScanHistoryPanel';
import { computeScanHistorySummary, executeScanHistory, loadSessionSymbols } from '../api/scanHistoryEngine';

vi.mock('../api/scanHistoryEngine', async original => ({
  ...await original<typeof import('../api/scanHistoryEngine')>(),
  executeScanHistory: vi.fn(() => new Promise(() => {})),
  loadSessionSymbols: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const props = {
  expressionTree: { type: 'group' as const, operator: 'all' as const, children: [] },
  universe: 'mainboard' as const,
  availableSessions: [{ date: '2024-07-01', revision: 'a'.repeat(64) }],
  currentSessionDate: '2024-07-01',
  onSelectSession: vi.fn(),
  onClose: vi.fn(),
};

it('aborts a running scan when the dialog closes', () => {
  const onClose = vi.fn();
  render(<ScanHistoryPanel {...props} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: /start frequency scan/i }));
  const signal = vi.mocked(executeScanHistory).mock.calls[0][4]?.signal;
  expect(signal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close scan history' }));
  expect(signal?.aborted).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
});

it('aborts a running scan if the panel unmounts', () => {
  const view = render(<ScanHistoryPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /start frequency scan/i }));
  const signal = vi.mocked(executeScanHistory).mock.calls[0][4]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it('limits the symbol list while keeping search across all matches', async () => {
  const point = { date: '2024-07-01', count: 120, status: 'success' as const };
  vi.mocked(executeScanHistory).mockResolvedValueOnce({ points: [point], summary: computeScanHistorySummary([point], 1) });
  vi.mocked(loadSessionSymbols).mockResolvedValueOnce(Array.from({ length: 120 }, (_, index) => `SYM${String(index).padStart(3, '0')}`));
  render(<ScanHistoryPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /start frequency scan/i }));
  await screen.findByText('SYM000');
  expect(screen.queryByText('SYM119')).not.toBeInTheDocument();
  expect(screen.getByText('Showing 80 of 120 symbols')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter symbols' }), { target: { value: 'SYM119' } });
  expect(screen.getByText('SYM119')).toBeInTheDocument();
});

it('charts the sessions, steps through them with the arrow keys and shows sectors on demand', async () => {
  const points = [
    { date: '2024-07-01', count: 10, status: 'success' as const, sectorCounts: { Banks: 6, IT: 4 } },
    { date: '2024-07-02', count: 14, status: 'success' as const, sectorCounts: { Banks: 9, IT: 5 } },
  ];
  vi.mocked(executeScanHistory).mockResolvedValueOnce({ points, summary: computeScanHistorySummary(points, 2) });
  vi.mocked(loadSessionSymbols).mockResolvedValue(['AAA']);
  render(<ScanHistoryPanel {...props} availableSessions={[{ date: '2024-07-01', revision: 'a'.repeat(64) }, { date: '2024-07-02', revision: 'b'.repeat(64) }]} currentSessionDate="2024-07-02" />);
  fireEvent.click(screen.getByRole('button', { name: /start frequency scan/i }));
  const chart = await screen.findByRole('slider', { name: 'Matches by session' });
  expect(chart).toHaveAttribute('aria-valuetext', '2 Jul 2024: 14 matches');
  expect(screen.getByText('+4 vs previous session', { exact: false })).toBeInTheDocument();
  fireEvent.keyDown(chart, { key: 'ArrowLeft' });
  expect(chart).toHaveAttribute('aria-valuetext', '1 Jul 2024: 10 matches');
  fireEvent.click(screen.getByRole('button', { name: 'Sectors · 2' }));
  expect(screen.getByText('Banks')).toBeInTheDocument();
});
