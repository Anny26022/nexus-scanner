import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IndicatorSettingsModal } from '../components/IndicatorSettingsModal';
import { defaultStudyConfigs } from '../chart/studyConfigs';
import { defaultEmaLines } from '../chart/model';

it('renders inputs and style tabs and applies customized RSI settings', () => {
  const onApplyConfigs = vi.fn();
  const onApplyEmaLines = vi.fn();
  const onApplyAppearance = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorSettingsModal
      indicatorId="rsi"
      configs={defaultStudyConfigs()}
      emaLines={defaultEmaLines()}
      appearance={{ horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' }}
      onApplyConfigs={onApplyConfigs}
      onApplyEmaLines={onApplyEmaLines}
      onApplyAppearance={onApplyAppearance}
      onClose={onClose}
    />
  );

  expect(screen.getByRole('dialog', { name: 'RSI Settings' })).toBeInTheDocument();
  const periodInput = screen.getByLabelText('Length (Period)');
  expect(periodInput).toHaveValue(14);

  fireEvent.change(periodInput, { target: { value: '21' } });
  expect(periodInput).toHaveValue(21);

  // Switch to Style tab
  fireEvent.click(screen.getByRole('tab', { name: 'Style' }));
  const obInput = screen.getByLabelText('Overbought Level');
  expect(obInput).toHaveValue(70);
  fireEvent.change(obInput, { target: { value: '80' } });

  // Apply
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onApplyConfigs).toHaveBeenCalledWith(
    expect.objectContaining({
      rsi: expect.objectContaining({ period: 21, overbought: 80 }),
    })
  );
  expect(onClose).toHaveBeenCalledOnce();
});
it('renders Supertrend inputs and allows resetting to defaults', () => {
  const onApplyConfigs = vi.fn();
  const onApplyEmaLines = vi.fn();
  const onApplyAppearance = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorSettingsModal
      indicatorId="supertrend"
      configs={{
        ...defaultStudyConfigs(),
        supertrend: { period: 14, multiplier: 2, upColor: '#10b981', downColor: '#f43f5e' },
      }}
      emaLines={defaultEmaLines()}
      appearance={{ horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' }}
      onApplyConfigs={onApplyConfigs}
      onApplyEmaLines={onApplyEmaLines}
      onApplyAppearance={onApplyAppearance}
      onClose={onClose}
    />
  );

  expect(screen.getByLabelText('ATR Period')).toHaveValue(14);
  expect(screen.getByLabelText('Multiplier')).toHaveValue(2);

  // Click Defaults
  fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
  expect(screen.getByLabelText('ATR Period')).toHaveValue(10);
  expect(screen.getByLabelText('Multiplier')).toHaveValue(3);
});

it('renders MACD settings with fast, slow, and signal inputs', () => {
  const onApplyConfigs = vi.fn();
  const onApplyEmaLines = vi.fn();
  const onApplyAppearance = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorSettingsModal
      indicatorId="macd"
      configs={defaultStudyConfigs()}
      emaLines={defaultEmaLines()}
      appearance={{ horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' }}
      onApplyConfigs={onApplyConfigs}
      onApplyEmaLines={onApplyEmaLines}
      onApplyAppearance={onApplyAppearance}
      onClose={onClose}
    />
  );

  expect(screen.getByLabelText('Fast Length')).toHaveValue(12);
  expect(screen.getByLabelText('Slow Length')).toHaveValue(26);
  expect(screen.getByLabelText('Signal Smoothing')).toHaveValue(9);
});

it('renders visibility tab and source selector and applies updated settings', () => {
  const onApplyConfigs = vi.fn();
  const onApplyEmaLines = vi.fn();
  const onApplyAppearance = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorSettingsModal
      indicatorId="macd"
      configs={defaultStudyConfigs()}
      emaLines={defaultEmaLines()}
      appearance={{ horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' }}
      onApplyConfigs={onApplyConfigs}
      onApplyEmaLines={onApplyEmaLines}
      onApplyAppearance={onApplyAppearance}
      onClose={onClose}
    />
  );

  const sourceSelect = screen.getByLabelText('Source');
  fireEvent.change(sourceSelect, { target: { value: 'hlc3' } });

  fireEvent.click(screen.getByRole('tab', { name: 'Visibility' }));
  const dailyCheckbox = screen.getByLabelText(/Daily/i);
  expect(dailyCheckbox).toBeChecked();
  fireEvent.click(dailyCheckbox);
  expect(dailyCheckbox).not.toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onApplyConfigs).toHaveBeenCalledWith(
    expect.objectContaining({
      macd: expect.objectContaining({
        source: 'hlc3',
        visibility: expect.objectContaining({ daily: false }),
      }),
    })
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it('renders EMA settings modal with Inputs, Style, and Visibility tabs and applies updates', () => {
  const onApplyConfigs = vi.fn();
  const onApplyEmaLines = vi.fn();
  const onApplyAppearance = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorSettingsModal
      indicatorId="ema"
      configs={defaultStudyConfigs()}
      emaLines={defaultEmaLines()}
      appearance={{ horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' }}
      onApplyConfigs={onApplyConfigs}
      onApplyEmaLines={onApplyEmaLines}
      onApplyAppearance={onApplyAppearance}
      onClose={onClose}
    />
  );

  expect(screen.getByRole('dialog', { name: 'EMA Settings' })).toBeInTheDocument();

  // Inputs tab has period input for EMA 1
  const periodInputs = screen.getAllByRole('spinbutton');
  expect(periodInputs[0]).toHaveValue(9);
  fireEvent.change(periodInputs[0], { target: { value: '25' } });

  // Style tab
  fireEvent.click(screen.getByRole('tab', { name: 'Style' }));
  expect(screen.getByText('EMA 25')).toBeInTheDocument();

  // Click Apply
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onApplyEmaLines).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ period: 25 }),
    ])
  );
  expect(onClose).toHaveBeenCalledOnce();
});

