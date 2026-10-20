import { it, expect, vi, afterEach } from 'vitest';

const revision = 'a'.repeat(64);
const mockRrgData = {
  schemaVersion: 1,
  asOfDate: '2026-10-19',
  generatedAt: '2026-10-20T14:00:00Z',
  benchmark: 'NIFTY 500',
  benchmark3mReturn: -5.56,
  trailWeeks: 12,
  totalBlocks: 28,
  totalNiches: 217,
  totalEquities: 2604,
  blocks: [
    {
      name: 'DEFENSE & AEROSPACE SYSTEMS',
      parentBlock: null,
      macro: 'CAPITAL GOODS & INFRASTRUCTURE',
      quadrant: 'Leading',
      x: 12.4,
      y: 6.8,
      trail: Array.from({ length: 13 }, (_, i) => ({
        week: 12 - i,
        date: `2026-0${Math.floor(i / 4) + 7}-01`,
        x: 10 + i * 0.2,
        y: 4 + i * 0.2,
        quadrant: 'Leading',
      })),
      metrics: {
        excessReturn1m: 3.2,
        excessReturn3m: 12.4,
        excessReturn6m: 24.1,
        medianRs: 82,
        rsMomentum21d: 6.8,
        beatingBenchmarkPct: 88,
        improvingRsPct: 75,
        setupCoveragePct: 62,
        totalTurnover20Cr: 1540.2,
        concentrationTop3Pct: 42.1,
        constituentCount: 38,
        topContributors: ['AZAD', 'UNIMECH', 'DYNAMATECH'],
      },
      constituents: [
        {
          symbol: 'AZAD',
          name: 'Azad Engineering Ltd',
          close: 1450.5,
          changePct: 2.4,
          marketCapCr: 8500,
          rsRating: 92,
          rsChange21d: 8,
          return1m: 14.2,
          return3m: 28.5,
          return6m: 45.0,
          excessReturn3m: 34.06,
          turnover20Cr: 120.5,
          setups: {
            stage2: true,
            vcp: true,
            darvas: false,
            bullFlag: true,
            cupHandle: false,
            pocketPivot: true,
            coiled: false,
            tightWeeks: true,
          },
          trendScore: 9,
          status: 'strengthening',
        },
      ],
      niches: ['Defense Precision Forgings', 'Unmanned & Drone Systems'],
      nicheCount: 2,
    },
  ],
  niches: [
    {
      name: 'Precision Engineering & Complex Manufacturing',
      parentBlock: 'EMERGING THEMES',
      macro: 'EMERGING & CROSS-CUTTING',
      quadrant: 'Leading',
      x: 14.8,
      y: 9.2,
      trail: Array.from({ length: 13 }, (_, i) => ({
        week: 12 - i,
        date: `2026-0${Math.floor(i / 4) + 7}-01`,
        x: 12 + i * 0.2,
        y: 6 + i * 0.2,
        quadrant: 'Leading',
      })),
      metrics: {
        excessReturn1m: 5.1,
        excessReturn3m: 14.8,
        excessReturn6m: 32.0,
        medianRs: 86,
        rsMomentum21d: 9.2,
        beatingBenchmarkPct: 90,
        improvingRsPct: 80,
        setupCoveragePct: 70,
        totalTurnover20Cr: 890.0,
        concentrationTop3Pct: 55.0,
        constituentCount: 10,
        topContributors: ['AZAD', 'KDDL', 'BALUFORGE'],
      },
      constituents: [],
    },
  ],
  ipoTactical: [
    {
      symbol: 'DEEPA',
      name: 'Deepa Jewellers',
      listingDate: '2026-09-08',
      listingAgeDays: 41,
      sessions: 22,
      marketCapCr: 450.0,
      close: 245.5,
      changePct: 3.2,
      excessReturn10d: 26.13,
      turnoverIntensity: 12.9,
      turnoverCr: 36.9,
      deliveryPct: 30.56,
      gainSinceListingPct: 26.3,
      quadrant: 'Leading',
      x: 26.13,
      y: 12.9,
      trail: [
        { week: 0, date: '2026-10-19', x: 26.13, y: 12.9, quadrant: 'Leading' },
      ],
      theme: 'Jewellery',
      block: 'Lifestyle & Retail',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('loads and caches Thematic RRG dataset', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(mockRrgData)));
  vi.stubGlobal('fetch', fetchMock);

  const { realAdapter } = await import('../api/realAdapter');
  const [first, second] = await Promise.all([
    realAdapter.getThematicRrg(revision),
    realAdapter.getThematicRrg(revision),
  ]);

  expect(first).toBe(second);
  expect(first.benchmark).toBe('NIFTY 500');
  expect(first.blocks).toHaveLength(1);
  expect(first.blocks[0].name).toBe('DEFENSE & AEROSPACE SYSTEMS');
  expect(first.blocks[0].quadrant).toBe('Leading');
  expect(first.blocks[0].trail).toHaveLength(13);
  expect(first.niches[0].parentBlock).toBe('EMERGING THEMES');
  expect(first.ipoTactical).toHaveLength(1);
  expect(first.ipoTactical[0].symbol).toBe('DEEPA');
  expect(first.ipoTactical[0].quadrant).toBe('Leading');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('correctly categorizes quadrants across positive and negative domains', () => {
  const determineQuadrant = (x: number, y: number) => {
    if (x >= 0) return y >= 0 ? 'Leading' : 'Weakening';
    return y >= 0 ? 'Improving' : 'Lagging';
  };

  expect(determineQuadrant(5.2, 3.1)).toBe('Leading');
  expect(determineQuadrant(5.2, -3.1)).toBe('Weakening');
  expect(determineQuadrant(-5.2, -3.1)).toBe('Lagging');
  expect(determineQuadrant(-5.2, 3.1)).toBe('Improving');
  expect(determineQuadrant(0, 0)).toBe('Leading');
});
