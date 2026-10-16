import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IndicatorsCatalogModal } from '../components/IndicatorsCatalogModal';
import { defaultStudies } from '../chart/studies';
import { defaultEmaLines } from '../chart/model';

it('renders catalog, filters by search and category, and toggles studies', () => {
  const onApplyStudies = vi.fn();
  const onApplyEmaLines = vi.fn();
  const onOpenIndicatorSettings = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorsCatalogModal
      studies={defaultStudies()}
      emaLines={defaultEmaLines()}
      interval="D"
      onApplyStudies={onApplyStudies}
      onApplyEmaLines={onApplyEmaLines}
      onOpenIndicatorSettings={onOpenIndicatorSettings}
      onClose={onClose}
    />
  );

  expect(screen.getByRole('dialog', { name: 'Indicators' })).toBeInTheDocument();
  expect(screen.getByLabelText('RSI 14')).not.toBeChecked();

  // Search filter
  const searchInput = screen.getByPlaceholderText(/Search indicators/i);
  fireEvent.change(searchInput, { target: { value: 'supertrend' } });
  expect(screen.getByText('Supertrend')).toBeInTheDocument();
  expect(screen.queryByText('Relative Strength Index')).not.toBeInTheDocument();

  // Clear search
  fireEvent.change(searchInput, { target: { value: '' } });
  expect(screen.getByText('Relative Strength Index')).toBeInTheDocument();

  // Category filter
  fireEvent.click(screen.getByRole('tab', { name: 'Oscillators' }));
  expect(screen.getByText('Relative Strength Index')).toBeInTheDocument();
  expect(screen.getByText('Moving Average Convergence Divergence')).toBeInTheDocument();
  expect(screen.queryByText('Supertrend')).not.toBeInTheDocument();

  // Toggle study
  fireEvent.click(screen.getByLabelText('RSI 14'));
  expect(onApplyStudies).toHaveBeenCalledWith(
    expect.objectContaining({ rsi: true })
  );

  // Settings button on RSI card
  const rsiSettingsBtn = screen.getByTitle('Customize Relative Strength Index');
  fireEvent.click(rsiSettingsBtn);
  expect(onOpenIndicatorSettings).toHaveBeenCalledWith('rsi');
});

it('renders EMA as standard catalog item and handles toggle and settings', () => {
  const onApplyStudies = vi.fn();
  const onApplyEmaLines = vi.fn();
  const onOpenIndicatorSettings = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorsCatalogModal
      studies={defaultStudies()}
      emaLines={defaultEmaLines()}
      interval="D"
      onApplyStudies={onApplyStudies}
      onApplyEmaLines={onApplyEmaLines}
      onOpenIndicatorSettings={onOpenIndicatorSettings}
      onClose={onClose}
    />
  );

  // EMA is visible
  expect(screen.getByText('Exponential Moving Average')).toBeInTheDocument();
  expect(screen.getByLabelText('EMA lines')).toBeInTheDocument();

  // Settings button opens EMA settings modal
  const emaSettingsBtn = screen.getByTitle('Customize Exponential Moving Average');
  fireEvent.click(emaSettingsBtn);
  expect(onOpenIndicatorSettings).toHaveBeenCalledWith('ema');

  // Toggle EMA off
  const emaCheckbox = screen.getByLabelText('EMA lines');
  expect(emaCheckbox).toBeChecked();
  fireEvent.click(emaCheckbox);
  expect(onApplyEmaLines).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ enabled: false }),
    ])
  );
});

it('renders Volume as an indicator in catalog, supports category tab, toggling, and opening volume settings', () => {
  const onApplyAppearance = vi.fn();
  const onOpenIndicatorSettings = vi.fn();
  const onClose = vi.fn();

  render(
    <IndicatorsCatalogModal
      studies={defaultStudies()}
      emaLines={defaultEmaLines()}
      interval="D"
      appearance={{ horizontalGrid: true, verticalGrid: true, crosshair: true, volume: true, scaleMode: 'normal' }}
      onApplyStudies={vi.fn()}
      onApplyEmaLines={vi.fn()}
      onApplyAppearance={onApplyAppearance}
      onOpenIndicatorSettings={onOpenIndicatorSettings}
      onClose={onClose}
    />
  );

  // Volume tab filter
  fireEvent.click(screen.getByRole('tab', { name: 'Volume' }));
  expect(screen.getByText('Volume', { selector: '.catalog-item-name' })).toBeInTheDocument();
  expect(screen.getByText('Vol')).toBeInTheDocument();

  // Volume is checked
  const volCheckbox = screen.getByLabelText('Volume histogram');
  expect(volCheckbox).toBeChecked();

  // Settings button opens volume settings
  const volSettingsBtn = screen.getByTitle('Customize Volume');
  fireEvent.click(volSettingsBtn);
  expect(onOpenIndicatorSettings).toHaveBeenCalledWith('volume');

  // Toggle Volume off
  fireEvent.click(volCheckbox);
  expect(onApplyAppearance).toHaveBeenCalledWith(
    expect.objectContaining({ volume: false })
  );
});
