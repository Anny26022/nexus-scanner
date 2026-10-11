import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Navbar } from '../components/Navbar';
import { SymbolWithLogo } from '../components/SymbolWithLogo';

afterEach(() => {cleanup(); vi.unstubAllGlobals(); localStorage.clear(); delete document.documentElement.dataset.theme;});
it('preserves the primary navigation and supports persistent appearance choices', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})));
  const change = vi.fn();
  render(<Navbar activeTab="screener" onTabChange={change} />);
  expect(screen.getByRole('button', {name: 'Screener'})).toHaveAttribute('aria-current', 'page');
  fireEvent.click(screen.getByRole('button', {name: 'IPO Catalogue'}));
  expect(change).toHaveBeenCalledWith('ipo');
  fireEvent.click(screen.getByRole('button', {name: 'Dark appearance'}));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem('nexus-scanner.ui.theme.v1')).toBe('"dark"');
  fireEvent.click(screen.getByRole('button', {name: 'System appearance'}));
  expect(document.documentElement.dataset.theme).toBe('light');
});

it('retains the StockScans fallback and starts with Dhan again when the symbol changes', () => {
  const view = render(<SymbolWithLogo symbol="AVTNPL" name="Avt Natural Products" />);
  const image = view.container.querySelector('img')!;
  fireEvent.error(image);
  expect(image.src).toBe('https://www.stockscans.in/api/company/logos/NSE:AVTNPL');
  view.rerender(<SymbolWithLogo symbol="WORTHPERI" name="Worth Peripherals" />);
  expect(image.src).toBe('https://images.dhan.co/symbol/WORTHPERI.png');
});
