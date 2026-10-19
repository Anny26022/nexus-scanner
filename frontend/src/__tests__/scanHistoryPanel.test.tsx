import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScanHistoryPanel } from '../components/ScanHistoryPanel';
import { executeScanHistory } from '../api/scanHistoryEngine';

vi.mock('../api/scanHistoryEngine', async original => ({
  ...await original<typeof import('../api/scanHistoryEngine')>(),
  executeScanHistory: vi.fn(() => new Promise(() => {})),
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
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  const signal = vi.mocked(executeScanHistory).mock.calls[0][4]?.signal;
  expect(signal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close scan history' }));
  expect(signal?.aborted).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
});

it('aborts a running scan if the panel unmounts', () => {
  const view = render(<ScanHistoryPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /start scan/i }));
  const signal = vi.mocked(executeScanHistory).mock.calls[0][4]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
