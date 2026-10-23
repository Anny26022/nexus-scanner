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
  fireEvent.click(screen.getByRole('button', { name: 'Candle up body color' }));
  fireEvent.click(screen.getByRole('option', { name: '#2962ff' }));
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ upColor: '#2962ff' }), style, null);
});

it('offers line colour and width for line styles, and resets colours', () => {
  const onApply = open('line');
  fireEvent.click(screen.getByRole('button', { name: 'Line color' }));
  fireEvent.click(screen.getByRole('option', { name: '#f23645' }));
  fireEvent.change(screen.getByLabelText('Line color opacity percent'), { target: { value: '50' } });
  fireEvent.change(screen.getByLabelText('Line width'), { target: { value: '3' } });
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ lineColor: '#f2364580', lineWidth: 3 }), 'line', null);
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

it('keeps volume bars and the status-line volume value as separate options', () => {
  const onApply = open('candles');
  fireEvent.click(screen.getByRole('tab', { name: 'Status line' }));
  fireEvent.click(screen.getByLabelText('Volume value'));
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ statusVolume: false, volume: true }), 'candles', null);
  fireEvent.click(screen.getByLabelText('Volume bars'));
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ volume: false }), 'candles', null);
});

it('splits and joins colours with opacity', async () => {
  const { splitColor, joinColor } = await import('../components/ColorPalette');
  expect(splitColor('#2962ff80')).toEqual({ base: '#2962ff', opacity: 50 });
  expect(splitColor('bad')).toEqual({ base: '#000000', opacity: 100 });
  expect(joinColor('#2962ff', 100)).toBe('#2962ff');
  expect(joinColor('#2962ff', 0)).toBe('#2962ff00');
});
