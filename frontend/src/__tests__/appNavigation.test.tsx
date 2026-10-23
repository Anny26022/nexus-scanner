import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import App from '../App';
import { screenerApi } from '../api/screenerApi';

vi.mock('../api/screenerApi', () => ({screenerApi: {
  getCurrentRevision: vi.fn(async () => ({latestSessionDate:'2026-10-21', immutableRevision:'a'.repeat(64)})),
  getChart: vi.fn(async () => ({candles:[]})),
  getAvailableSessions: vi.fn(async () => [{date:'2026-10-09', revision:'b'.repeat(64), isHistorical:true, label:'2026-10-09'}]),
}}));
vi.mock('../components/ExploreTab', () => ({ExploreTab: ({onOpenFullChart}: {onOpenFullChart: (symbol:string, revision:string, date:string)=>void}) => <>
  <input aria-label="Screener draft" defaultValue=""/>
  <button onClick={()=>onOpenFullChart('TEST', 'c'.repeat(64), '2026-10-08')}>Open snapshot chart</button>
</>}));
vi.mock('../components/ChartsTab', () => ({default: ({datasetRevision,sessionDate}:{datasetRevision:string;sessionDate:string}) => <p data-revision={datasetRevision} data-date={sessionDate}>Full chart workspace</p>}));
vi.mock('../components/NewListingsTab', () => ({NewListingsTab: () => <p>IPO workspace</p>}));
vi.mock('../components/SessionDatePicker', () => ({SessionDatePicker: ({onChange}:{onChange:(date:string)=>void}) => <button onClick={()=>onChange('2026-10-09')}>Select historical session</button>}));

afterEach(() => {cleanup(); localStorage.clear();});

it('retains the same Screener across sidebar Charts and IPO visits', async () => {
  render(<App/>);
  const draft = screen.getByRole('textbox', {name:'Screener draft'});
  fireEvent.change(draft, {target:{value:'unsaved query'}});
  fireEvent.click(screen.getByRole('button', {name:'Charts'}));
  await screen.findByText('Full chart workspace');
  await waitFor(() => expect(screenerApi.getChart).toHaveBeenCalledWith('RELIANCE', 'a'.repeat(64), '2026-10-21'));
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

it('keeps the snapshot date in sidebar charts and the mini-to-full handoff', async () => {
  render(<App/>);
  fireEvent.click(screen.getByText('Select historical session'));
  fireEvent.click(screen.getByRole('button', {name:'Charts'}));
  const chart = await screen.findByText('Full chart workspace');
  await waitFor(()=>expect(chart).toHaveAttribute('data-revision', 'b'.repeat(64)));
  expect(chart).toHaveAttribute('data-date', '2026-10-09');
  fireEvent.click(screen.getByRole('button', {name:'Screener'}));
  fireEvent.click(screen.getByText('Open snapshot chart'));
  expect(await screen.findByText('Full chart workspace')).toHaveAttribute('data-date', '2026-10-08');
  expect(screen.getByText('Full chart workspace')).toHaveAttribute('data-revision', 'c'.repeat(64));
});
