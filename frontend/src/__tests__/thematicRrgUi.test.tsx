import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ThematicRrgTab from '../components/ThematicRrgTab';
import type { ThematicRrgResponse, RrgBlockItem, RrgIpoItem } from '../types/thematicRrg';

const metrics = {
  excessReturn1m: 2,
  excessReturn3m: 12,
  excessReturn6m: 20,
  medianRs: 80,
  rsMomentum21d: 3,
  beatingBenchmarkPct: 60,
  improvingRsPct: 40,
  setupCoveragePct: 10,
  totalTurnover20Cr: 50,
  concentrationTop3Pct: 30,
  constituentCount: 1,
  topContributors: ['ALPHA'],
};

const block: RrgBlockItem = {
  name: 'Industrials',
  parentBlock: null,
  macro: 'Manufacturing',
  quadrant: 'Leading',
  x: 12,
  y: 3,
  trail: [{ week: 0, date: '2026-10-19', x: 12, y: 3, quadrant: 'Leading' }],
  metrics,
  niches: ['Precision'],
  nicheCount: 1,
  constituents: [
    {
      symbol: 'ALPHA',
      name: 'Alpha Industries',
      close: 100,
      changePct: 2,
      marketCapCr: 200,
      rsRating: null,
      rsChange21d: null,
      return1m: 2,
      return3m: 4,
      return6m: 6,
      excessReturn3m: 10,
      turnover20Cr: 50,
      setups: {
        stage2: true,
        vcp: true,
        darvas: false,
        bullFlag: false,
        cupHandle: false,
        pocketPivot: false,
        coiled: false,
        tightWeeks: false,
      },
      trendScore: 8,
      status: 'strengthening',
    },
  ],
};

const ipo: RrgIpoItem = {
  symbol: 'NEW',
  name: 'New Industries',
  listingDate: '2026-10-01',
  listingAgeDays: 18,
  sessions: 12,
  marketCapCr: 1000,
  close: 200,
  changePct: -1,
  excessReturn10d: 4,
  turnoverIntensity: -10,
  turnoverCr: 20,
  deliveryPct: null,
  gainSinceListingPct: 5,
  quadrant: 'Weakening',
  x: 4,
  y: -10,
  trail: [],
  theme: 'Precision',
  block: 'Industrials',
};

const data: ThematicRrgResponse = {
  schemaVersion: 1,
  asOfDate: '2026-10-19',
  generatedAt: '',
  benchmark: 'NIFTY 500',
  benchmark3mReturn: 1,
  trailWeeks: 12,
  totalBlocks: 2,
  totalNiches: 1,
  totalEquities: 2,
  constituentEligibility: {
    marketCapCrStrictlyGreaterThan: 999,
    closeStrictlyGreaterThan: 10,
    eligibleSymbols: 1_000,
  },
  blocks: [
    block,
    { ...block, name: 'Services', quadrant: 'Lagging', x: -2, y: -1, metrics: { ...metrics, excessReturn3m: -2 } },
  ],
  niches: [{ ...block, name: 'Precision', parentBlock: block.name }],
  ipoTactical: [ipo],
};

afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['thematicRrg', undefined], data);
  render(
    <QueryClientProvider client={client}>
      <ThematicRrgTab />
    </QueryClientProvider>
  );
}

it('renders the thematic rotation controls and real metric labels', () => {
  mount();
  expect(screen.getByText('Where leadership is moving')).toBeTruthy();
  expect(screen.getByText(/Median 3-month excess return versus NIFTY 500/i)).toBeTruthy();
  expect(screen.getByText('1,000 institutional equities')).toBeTruthy();
  expect(screen.getByRole('tab', { name: /Blocks/i })).toBeTruthy();
  expect(screen.getByRole('tab', { name: /Niches/i })).toBeTruthy();
  expect(screen.getByRole('tab', { name: /New listings/i })).toBeTruthy();
  expect(screen.queryByText('Labels')).toBeNull();
});

it('uses the zero-centred thematic rotation quadrants', () => {
  mount();
  expect(screen.getAllByText('Improving').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Leading').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Lagging').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Weakening').length).toBeGreaterThan(0);
  expect(screen.getByText(/quadrant boundaries are 0% excess return and 0 RS-rating points/i)).toBeTruthy();
});

it('does not mislabel the raw metrics as JdK ratio and momentum', () => {
  mount();
  expect(screen.getByText(/3-month excess return vs NIFTY 500/i)).toBeTruthy();
  expect(screen.getAllByText(/21-day relative-strength momentum/i).length).toBeGreaterThan(0);
  expect(screen.queryByText('JdK RS-Ratio')).toBeNull();
});

it('switches to the separate new-listing rotation model', () => {
  mount();
  fireEvent.click(screen.getByRole('tab', { name: /New listings/i }));
  expect(screen.getAllByText('NEW').length).toBeGreaterThan(0);
  expect(screen.getByText(/Turnover intensity vs baseline/i)).toBeTruthy();
});
