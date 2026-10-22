import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import App from '../App';

vi.mock('../api/screenerApi', () => ({screenerApi: {
  getCurrentRevision: vi.fn(async () => ({latestSessionDate:'2026-10-21', immutableRevision:'a'.repeat(64)})),
  getAvailableSessions: vi.fn(async () => []),
}}));
vi.mock('../components/ExploreTab', () => ({ExploreTab: () => <input aria-label="Screener draft" defaultValue=""/>}));
vi.mock('../components/ChartsTab', () => ({default: () => <p>Full chart workspace</p>}));
vi.mock('../components/NewListingsTab', () => ({NewListingsTab: () => <p>IPO workspace</p>}));
vi.mock('../components/SessionDatePicker', () => ({SessionDatePicker: () => null}));

afterEach(() => {cleanup(); localStorage.clear();});

it('retains the same Screener across sidebar Charts and IPO visits', async () => {
  render(<App/>);
  const draft = screen.getByRole('textbox', {name:'Screener draft'});
  fireEvent.change(draft, {target:{value:'unsaved query'}});
  fireEvent.click(screen.getByRole('button', {name:'Charts'}));
  await screen.findByText('Full chart workspace');
  expect(draft).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', {name:'IPO Catalogue'}));
  await screen.findByText('IPO workspace');
  fireEvent.click(screen.getByRole('button', {name:'Screener'}));
  expect(screen.getByRole('textbox', {name:'Screener draft'})).toBe(draft);
  expect(draft).toHaveValue('unsaved query');
  expect(draft).toBeVisible();
});

it('does not mount Screener until first visited from a saved Charts session', async () => {
  localStorage.setItem('nexus-scanner.ui.active-tab.v1', JSON.stringify('charts'));
  render(<App/>);
  await screen.findByText('Full chart workspace');
  expect(screen.queryByLabelText('Screener draft')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'Screener'}));
  await waitFor(() => expect(screen.getByRole('textbox', {name:'Screener draft'})).toBeVisible());
});
