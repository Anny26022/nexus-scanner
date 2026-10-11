import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IpoDetailsCard } from '../components/IpoDetailsCard';
import type { IPORow } from '../types/screener';

afterEach(cleanup);
const row: IPORow = {symbol: 'TEST', name: 'Test IPO', listingDate: '2026-10-01', currentPrice: 100,
  turnoverCrore: 1, marketCapCrore: 200, sector: 'Industrials', industry: 'Equipment'};
const props = {id: 'test-ipo', left: 0, top: 0, placement: 'right' as const,
  onClose: vi.fn(), onMouseEnter: vi.fn(), onMouseLeave: vi.fn()};

it('shows decoded offer terms without an offer object and a registrar without allotment status', () => {
  render(<IpoDetailsCard {...props} row={{...row, ipoResearch: {ipoDecode: {
    registrar: 'Example Registrar', issue: {priceBandLow: 90, priceBandHigh: 100, lotSize: 50, minInvestment: 5000},
  }}}} />);
  expect(screen.getByRole('heading', {name: 'Offer'})).toBeInTheDocument();
  expect(screen.getByText('₹90-₹100')).toBeInTheDocument();
  expect(screen.getByText('₹5,000')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', {name: 'IPO Decode'}));
  expect(screen.getByText('Example Registrar')).toBeInTheDocument();
});

it('shows ScanX-only allotment dates and refresh failures without an empty Decode tab', () => {
  render(<IpoDetailsCard {...props} row={{...row,
    ipoDetailStatus: {lastSuccessAt: '2026-10-04T06:00:00Z', failedEndpoints: ['issue']},
    ipoResearch: {scanx: {allotmentDate: '2026-09-30T10:00:00Z'}},
  }} />);
  expect(screen.queryByRole('tab', {name: 'IPO Decode'})).not.toBeInTheDocument();
  expect(screen.getByText(/Last updated: .*11:30:00 am IST/)).toBeInTheDocument();
  expect(screen.getByText(/Refresh errors: issue/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', {name: 'Research'}));
  expect(screen.getByText('30 Sept 2026')).toBeInTheDocument();
  expect(screen.getByText(/Refresh errors: issue/)).toBeInTheDocument();
});

it('moves focus and activates available tabs with arrows, Home and End', () => {
  render(<IpoDetailsCard {...props} row={{...row, ipoResearch: {
    ipoDecode: {registrar: 'Registrar'}, scanx: {allotmentDate: '2026-09-30'},
  }}} />);
  const overview = screen.getByRole('tab', {name: 'Overview'});
  const decode = screen.getByRole('tab', {name: 'IPO Decode'});
  const research = screen.getByRole('tab', {name: 'Research'});
  fireEvent.keyDown(overview, {key: 'ArrowRight'});
  expect(decode).toHaveFocus();
  expect(decode).toHaveAttribute('aria-selected', 'true');
  expect(overview).toHaveAttribute('tabindex', '-1');
  fireEvent.keyDown(decode, {key: 'End'});
  expect(research).toHaveFocus();
  fireEvent.keyDown(research, {key: 'ArrowRight'});
  expect(overview).toHaveFocus();
  fireEvent.keyDown(overview, {key: 'ArrowLeft'});
  expect(research).toHaveFocus();
  fireEvent.keyDown(research, {key: 'Home'});
  expect(overview).toHaveFocus();
});
