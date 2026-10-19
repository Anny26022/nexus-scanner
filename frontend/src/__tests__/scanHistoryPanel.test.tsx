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
