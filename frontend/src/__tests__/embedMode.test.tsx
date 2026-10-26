import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {configureOrigins, dataUrl, apiUrl} from '../api/origins';
import {manifestSnapshotSource, resolveManifestUrls, type Manifest} from '../api/manifest';
import {readStored, setStorageNamespace, writeStored} from '../storage/store';
import {ScannerApp} from '../embed';

vi.mock('../api/screenerApi', () => ({screenerApi: {
  getCurrentRevision: vi.fn(async () => ({latestSessionDate: '2026-10-21', immutableRevision: 'a'.repeat(64)})),
  getChart: vi.fn(async () => ({candles: []})),
  getAvailableSessions: vi.fn(async () => []),
}}));
vi.mock('../components/ExploreTab', () => ({ExploreTab: () => <p>Screener workspace</p>}));
vi.mock('../components/MarketTab', () => ({default: ({onOpenChart}: {onOpenChart: (symbol: string) => void}) =>
  <button onClick={() => onOpenChart('TCS')}>Open TCS</button>}));
vi.mock('../components/SessionDatePicker', () => ({SessionDatePicker: () => <span>Session picker</span>}));

const revision = 'a'.repeat(64);
const origin = 'https://scanner.example.com';

afterEach(() => {
  cleanup();
  configureOrigins({dataOrigin: '', apiOrigin: ''});
  setStorageNamespace('');
  localStorage.clear();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

it('keeps same-origin URLs by default and resolves them against a configured data origin', () => {
  expect(dataUrl('/data/current.json')).toBe('/data/current.json');
  configureOrigins({dataOrigin: `${origin}/`, apiOrigin: origin});
  expect(dataUrl('/data/current.json')).toBe(`${origin}/data/current.json`);
  expect(dataUrl('https://r2.example.com/objects/x.json.gz')).toBe('https://r2.example.com/objects/x.json.gz');
  expect(dataUrl('//cdn.example.com/x')).toBe('//cdn.example.com/x');
  expect(apiUrl('/api/screener/ai-compile')).toBe(`${origin}/api/screener/ai-compile`);
});

it('resolves every relative release URL and still prefers the packed gzip snapshot', () => {
  configureOrigins({dataOrigin: origin});
  vi.stubGlobal('DecompressionStream', class {});
  const manifest = resolveManifestUrls({revision, sessionDate: '2026-10-23', schemaVersion: 7, totalStocks: 1,
    datasetUrl: `https://r2.example.com/releases/${revision}/stocks.json`,
    datasetPackedGzipUrl: `/data/revisions/${revision}/stocks.packed.json.gz`,
    iposUrl: `/data/revisions/${revision}/ipos.json.gz`,
    financialHistoryUrlTemplate: `/data/revisions/${revision}/financial-history/{symbol}.json.gz`,
    objectUrlTemplate: 'https://r2.example.com/objects/{hash}.json.gz'} as Manifest);
  expect(manifest.iposUrl).toBe(`${origin}/data/revisions/${revision}/ipos.json.gz`);
  expect(manifest.financialHistoryUrlTemplate).toBe(`${origin}/data/revisions/${revision}/financial-history/{symbol}.json.gz`);
  expect(manifest.datasetUrl).toBe(`https://r2.example.com/releases/${revision}/stocks.json`);
  expect(manifestSnapshotSource(manifest).url).toBe(`${origin}/data/revisions/${revision}/stocks.packed.json.gz`);
  expect(manifestSnapshotSource(manifest, 'b'.repeat(64)).url).toBe(`${origin}/data/revisions/${'b'.repeat(64)}/stocks.json.gz`);
});

it('namespaces stored keys without changing the standalone keys', () => {
  writeStored('nexus-scanner.ui.theme.v1', 'dark');
  expect(localStorage.getItem('nexus-scanner.ui.theme.v1')).toBe('"dark"');
  setStorageNamespace('journal');
  expect(readStored('nexus-scanner.ui.theme.v1', 'light')).toBe('light');
  writeStored('nexus-scanner.ui.theme.v1', 'light');
  expect(localStorage.getItem('journal:nexus-scanner.ui.theme.v1')).toBe('"light"');
  expect(localStorage.getItem('nexus-scanner.ui.theme.v1')).toBe('"dark"');
});

it('renders a sub-navigation inside a scoped root and leaves the host document alone', async () => {
  const onOpenSymbol = vi.fn(() => true);
  const {container} = render(<ScannerApp embedded dataOrigin={origin} theme="dark" storageNamespace="journal" onOpenSymbol={onOpenSymbol}/>);
  const root = container.firstElementChild as HTMLElement;
  expect(root).toHaveClass('nexus-scanner-root');
  expect(root.dataset.theme).toBe('dark');
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(document.body.querySelector(':scope > .nexus-scanner-portal')).toHaveAttribute('data-theme', 'dark');
  expect(await screen.findByText('Screener workspace')).toBeInTheDocument();
  expect(screen.getByRole('navigation', {name: 'Scanner navigation'})).toBeInTheDocument();
  expect(screen.queryByRole('group', {name: 'Appearance'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Hide sidebar'})).toBeNull();

  fireEvent.click(screen.getByRole('button', {name: 'Market'}));
  expect(localStorage.getItem('journal:nexus-scanner.ui.active-tab.v1')).toBe('"market"');
  fireEvent.click(await screen.findByText('Open TCS'));
  expect(onOpenSymbol).toHaveBeenCalledWith('TCS');
  // The host handled the symbol, so the scanner stays on Market.
  expect(screen.getByText('Open TCS')).toBeInTheDocument();
});

it('lets the host take over a tab switch', async () => {
  const onNavigateExternal = vi.fn((path: string) => path === '/charts');
  render(<ScannerApp embedded onNavigateExternal={onNavigateExternal}/>);
  await screen.findByText('Screener workspace');
  fireEvent.click(screen.getByRole('button', {name: 'Charts'}));
  expect(onNavigateExternal).toHaveBeenCalledWith('/charts');
  expect(screen.getByRole('button', {name: 'Screener'})).toHaveAttribute('aria-current', 'page');
});
