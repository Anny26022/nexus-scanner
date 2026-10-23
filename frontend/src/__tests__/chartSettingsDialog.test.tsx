import { expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChartSettingsDialog } from '../components/ChartSettingsDialog';
import type { ChartAppearance, ChartStyle } from '../chart/ChartEngine';

afterEach(cleanup);
const appearance: ChartAppearance = { horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' };
const open = (chartStyle: ChartStyle, onApply = vi.fn()) => {
  render(<ChartSettingsDialog appearance={appearance} chartStyle={chartStyle} symbol="TCS" comparison={null} firstDate="2026-01-01" lastDate="2026-10-02"
    onClose={vi.fn()} onApply={onApply} onGoToDate={() => true} onEvents={vi.fn()} />);
  return onApply;
};

it.each(['candles', 'hollowCandles', 'volumeCandles'] as const)('offers candle colours for %s', style => {
  const onApply = open(style);
  expect(screen.getByLabelText('Chart type')).toHaveValue(style);
  fireEvent.input(screen.getByLabelText('Candle up body color'), { target: { value: '#123456' } });
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ upColor: '#123456' }), style, null);
});

it('offers line colour and width for line styles, and resets colours', () => {
  const onApply = open('line');
  fireEvent.input(screen.getByLabelText('Line color'), { target: { value: '#ff0000' } });
  fireEvent.change(screen.getByLabelText('Line width'), { target: { value: '3' } });
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ lineColor: '#ff0000', lineWidth: 3 }), 'line', null);
  fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  expect(onApply.mock.lastCall![0]).not.toHaveProperty('lineColor');
  expect(onApply.mock.lastCall![0]).toMatchObject({ volume: true, scaleMode: 'normal' });
});

it('shows one tab at a time', () => {
  open('candles');
  expect(screen.queryByLabelText('Invert scale')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Scales and lines' }));
  expect(screen.getByRole('tab', { name: 'Scales and lines' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('Invert scale')).toBeInTheDocument();
});
