import fs from 'node:fs';
import path from 'node:path';

const GROUPS = [
  { slug: 'tata-group-stocks', name: 'Tata Group', grpId: 'TN' },
  { slug: 'adani-group-stocks', name: 'Adani Group', grpId: 'ADN' },
  { slug: 'mukesh-ambani-group-stocks', name: 'Mukesh Ambani Group', grpId: 'MDA' },
  { slug: 'anil-ambani-group-stocks', name: 'Anil Ambani Group', grpId: 'AL' },
  { slug: 'jindal-group-stocks', name: 'Jindal Group', grpId: 'JYOP,PRJI,DPJ,JYBC,JSW,NJIN,RJIN' },
  { slug: 'birla-group-stocks', name: 'Birla Group', grpId: 'DXMP,DXBK,DXAV,DXCK,DXKK,DXY' },
  { slug: 'bajaj-group-stocks', name: 'Bajaj Group', grpId: 'BH,BHS,BHH' },
  { slug: 'hinduja-group-stocks', name: 'Hinduja Group', grpId: 'HD' },
  { slug: 'godrej-group-stocks', name: 'Godrej Group', grpId: 'GJ' },
  { slug: 'hdfc-group-stocks', name: 'HDFC Group', grpId: 'HI' },
  { slug: 'icici-group-stocks', name: 'ICICI Group', grpId: 'ICI' },
  { slug: 'lt-group-stocks', name: 'L&T Group', grpId: 'LTG' },
  { slug: 'murugappa-group-stocks', name: 'Murugappa Group', grpId: 'NS' },
  { slug: 'mahindra-group-stocks', name: 'Mahindra Group', grpId: 'ML,KMG' }
];

const SCANX_URL = 'https://ow-scanx-analytics.dhan.co/customscan/fetchdt';
const DATA_PATH = path.resolve('reference/dhan/group-stocks.json');

const FIELDS = [
  'Isin', 'DispSym', 'Mcap', 'Pe', 'DivYeild', 'Revenue', 'Year1RevenueGrowth',
  'NetProfitMargin', 'YoYLastQtrlyProfitGrowth', 'EBIDTAMargin', 'volume',
  'PricePerchng1year', 'PricePerchng3year', 'PricePerchng5year', 'Ind_Pe', 'Pb',
  'Eps', 'DaySMA50CurrentCandle', 'DaySMA200CurrentCandle', 'DayRSI14CurrentCandle',
  'ROCE', 'Ltp', 'Roe', 'RtAwayFrom5YearHigh', 'RtAwayFrom1MonthHigh', 'High5yr',
  'High3Yr', 'High1Yr', 'High1Wk', 'Sym', 'PricePerchng1mon', 'PricePerchng1week',
  'PricePerchng3mon', 'YearlyEarningPerShare', 'OCFGrowthOnYr', 'Year1CAGREPSGrowth',
  'NetChangeInCash', 'FreeCashFlow', 'PricePerchng2week', 'DayBbUpper_Sub_BbLower',
  'DayATR14CurrentCandleMul_2', 'Min5HighCurrentCandle', 'Min15HighCurrentCandle',
  'Min5EMA50CurrentCandle', 'Min15EMA50CurrentCandle', 'Min15SMA100CurrentCandle',
  'Open', 'BcClose', 'Rmp', 'PledgeBenefit', 'DeliveryData.DailyTradedQty',
  'DeliveryData.DailyDeliveredQty', 'DeliveryData.DailyDeliveredPer', 'LastTradeTime'
];

async function fetchExchange(grpId, exch) {
  const body = {
    data: {
      sort: 'Mcap',
      sorder: 'desc',
      count: 100,
      pgno: 1,
      params: [
        { field: 'CompanyGrpId', op: '', val: grpId },
        { field: 'OgInst', op: '', val: 'ES' },
        { field: 'Seg', op: '', val: 'E' },
        { field: 'Exch', op: '', val: exch }
      ],
      fields: FIELDS
    }
  };

  const res = await fetch(SCANX_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} from ${SCANX_URL} (${exch})`);
  const json = await res.json();
  return json.data || [];
}

function mapStock(item, groupName, groupSlug) {
  return {
    groupName,
    groupSlug,
    symbol: item.Sym,
    name: item.DispSym,
    isin: item.Isin,
    exchange: item.Exch,
    segment: item.Seg,
    instrument: item.Inst,
    sid: item.Sid,
    seoSymbol: item.Seosym,
    ltp: item.Ltp,
    change: item.Pchange,
    pctChange: item.PPerchange,
    marketCapCr: item.Mcap,
    pe: item.Pe,
    pb: item.Pb,
    divYield: item.DivYeild,
    roce: item.ROCE,
    roe: item.Roe,
    high52w: item.High1Yr,
    low52w: item.Low1Yr,
    high5yr: item.High5yr,
    volume: item.Volume,
    deliveryPct: item.DeliveryData?.DailyDeliveredPer,
    dayRsi14: item.DayRSI14CurrentCandle,
    daySma50: item.DaySMA50CurrentCandle,
    daySma200: item.DaySMA200CurrentCandle,
    netProfitMargin: item.NetProfitMargin,
    yearlyEps: item.YearlyEarningPerShare,
    freeCashFlow: item.FreeCashFlow,
    lastTradeTime: item.LastTradeTime
  };
}

async function syncGroupStocks() {
  const previousData = fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) : null;
  const prevIsinsByGroup = new Map();
  if (previousData?.groups) {
    for (const [slug, g] of Object.entries(previousData.groups)) {
      prevIsinsByGroup.set(slug, new Set((g.stocks || []).map(s => s.isin)));
    }
  }

  const resultByGroup = {};
  const allStocks = [];
  const additions = [];
  const deletions = [];

  for (const g of GROUPS) {
    const [nseList, bseList] = await Promise.all([
      fetchExchange(g.grpId, 'NSE'),
      fetchExchange(g.grpId, 'BSE')
    ]);

    const isinSeen = new Set();
    const groupStocks = [];

    // Prioritize NSE entries, supplement with BSE-exclusive scrips
    for (const item of [...nseList, ...bseList]) {
      if (item.Isin && !isinSeen.has(item.Isin)) {
        isinSeen.add(item.Isin);
        const mapped = mapStock(item, g.name, g.slug);
        groupStocks.push(mapped);
        allStocks.push(mapped);
      }
    }

    // Incremental diff check
    const prevSet = prevIsinsByGroup.get(g.slug) || new Set();
    for (const s of groupStocks) {
      if (!prevSet.has(s.isin)) {
        additions.push({ group: g.name, symbol: s.symbol, name: s.name, isin: s.isin });
      }
    }
    for (const isin of prevSet) {
      if (!isinSeen.has(isin)) {
        const oldStock = previousData.groups[g.slug].stocks.find(s => s.isin === isin);
        deletions.push({ group: g.name, symbol: oldStock?.symbol || isin, isin });
      }
    }

    resultByGroup[g.slug] = {
      groupName: g.name,
      groupSlug: g.slug,
      sourceUrl: `https://dhan.co/stocks/market/${g.slug}/`,
      count: groupStocks.length,
      stocks: groupStocks
    };
  }

  const output = {
    source: 'Dhan (ow-scanx-analytics.dhan.co)',
    totalGroups: GROUPS.length,
    totalStocks: allStocks.length,
    lastSyncedAt: new Date().toISOString(),
    incrementalSummary: {
      added: additions.length,
      removed: deletions.length,
      additions,
      deletions
    },
    groups: resultByGroup,
    allStocks
  };

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));

  console.log(`[Dhan Group Sync] Processed ${GROUPS.length} groups, ${allStocks.length} stocks.`);
  if (additions.length > 0 || deletions.length > 0) {
    console.log(`[Dhan Group Sync] Detected changes: +${additions.length} added, -${deletions.length} removed.`);
    if (additions.length) console.log('  Added:', additions);
    if (deletions.length) console.log('  Removed:', deletions);
  } else {
    console.log('[Dhan Group Sync] Constituents unchanged. Market attributes updated.');
  }
}

syncGroupStocks().catch(err => {
  console.error('[Dhan Group Sync Error]', err);
  process.exit(1);
});
