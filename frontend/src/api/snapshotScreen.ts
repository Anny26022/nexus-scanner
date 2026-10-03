import type { ActiveCondition, ExpressionNode, ScreenerRunRequest, ScreenerRunResponse, StockRow } from '../types/screener';

type Truth = boolean | null;
export interface SnapshotStock extends StockRow {
  asOfDate: string | null;
  metadataAsOfDate: string | null;
  historyAligned: boolean;
  indexMemberships: string[];
  metrics: Record<string, number | boolean | null>;
  presetMatches: Record<string, Truth>;
  roePct: number | null;
  freeFloatPct: number | null;
}
export interface Snapshot {
  referenceCounts?: Record<string, number>;
  revision: string;
  asOfDate: string;
  totalStocks: number;
  stocks: SnapshotStock[];
}
type Predicate = (s: SnapshotStock) => Truth;
const combine = (values: Truth[], all: boolean): Truth => all
  ? values.includes(false) ? false : values.includes(null) ? null : true
  : values.includes(true) ? true : values.includes(null) ? null : false;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const between = (value: unknown, min: number, max: number): Truth => number(value) == null ? null : (value as number) >= min && (value as number) <= max;
const compare = (value: unknown, op: string, target: number): Truth => {
  const n = number(value);
  if (n == null) return null;
  switch (op.toUpperCase()) {
    case 'ABOVE': return n >= target;
    case 'BELOW': return n <= target;
    case 'GREATER': return n > target;
    case 'LESS': return n < target;
    case 'EQUAL': return n === target;
    default: throw new Error('Unsupported comparison');
  }
};

function leaf(c: ActiveCondition, session: string): Predicate | null {
  const p = c.parameters;
  let fn: Predicate;
  let metadata = false;
  switch (c.conditionId) {
    case 'mom_rvol': fn = s => between(s.rvol, p.minRvol, p.maxRvol); break;
    case 'VOLUME_VS_AVG':
      if (p.avgDays !== 20 || p.withinDays !== 1) return null;
      fn = s => compare(s.rvol, String(p.comparison ?? 'ABOVE'), p.multiple); break;
    case 'trend_price_vs_ma': {
      if (p.maType !== 'SMA' || ![10,20,50,200].includes(Number(p.maPeriod))) return null;
      fn = s => {
        const ma = number(s.metrics[`sma${p.maPeriod}`]);
        if (ma == null || number(s.close) == null) return null;
        if (p.operator === 'within_pct') return Math.abs((s.close/ma-1)*100) <= p.thresholdPct;
        return p.operator === 'above' ? s.close > ma : s.close < ma;
      }; break;
    }
    case 'PRICE_VS_SMA':
      if (p.persistDays !== 1 || ![10,20,50,200].includes(Number(p.period))) return null;
      fn = s => {
        const ma = number(s.metrics[`sma${p.period}`]);
        return ma == null || number(s.close) == null ? null : p.comparison === 'ABOVE' ? s.close > ma : s.close < ma;
      }; break;
    case 'PRICE_VS_EMA':
      if (p.persistDays !== 1 || ![20,50,200].includes(Number(p.period))) return null;
      fn = s => {
        const ma = number(s[`ema${p.period}` as keyof SnapshotStock]);
        return ma == null || number(s.close) == null ? null : p.comparison === 'ABOVE' ? s.close > ma : s.close < ma;
      }; break;
    case 'PRICE_CHANGE_PCT': {
      const period = Number(p.overDays);
      if (![1,5,21,63,126,252].includes(period)) return null;
      fn = s => compare(period === 1 ? s.changePct : s.metrics[`return${period}`],p.comparison,p.comparison === 'BELOW' ? -Math.abs(p.pct) : p.pct); break;
    }
    case 'GAP_UP': case 'GAP_DOWN':
      if (Number(p.withinDays) !== 1) return null;
      fn = s => compare(s.metrics.gapPct,c.conditionId === 'GAP_UP' ? 'ABOVE' : 'BELOW',c.conditionId === 'GAP_UP' ? p.minGapPct : -p.minGapPct); break;
    case 'NEW_HIGH': case 'NEW_LOW':
      if (Number(p.withinDays) !== 1 || ![20,50,252].includes(Number(p.lookbackDays))) return null;
      fn = s => typeof s.metrics[`${c.conditionId === 'NEW_HIGH' ? 'newHigh' : 'newLow'}${p.lookbackDays}`] === 'boolean'
        ? Boolean(s.metrics[`${c.conditionId === 'NEW_HIGH' ? 'newHigh' : 'newLow'}${p.lookbackDays}`]) : null; break;
    case 'PCT_FROM_52W_HIGH': fn = s => compare(Math.abs(s.dist52wHighPct ?? NaN),p.comparison,p.pct); break;
    case 'PCT_FROM_52W_LOW': fn = s => compare(Math.abs(s.dist52wLowPct ?? NaN),p.comparison,p.pct); break;
    case 'ATR_PCT':
      if (Number(p.period) !== 14) return null;
      fn = s => compare(s.metrics.atrPct14,p.comparison,p.pct); break;
    case 'ADR_PCT':
      if (![14,20].includes(Number(p.lookbackDays))) return null;
      fn = s => compare(s.metrics[`adr${p.lookbackDays}`],p.comparison,p.pct); break;
    case 'RS_RATING': fn = s => {
      const ratings:Record<string,number|null|undefined>={FRONT_WEIGHTED:s.rsRating,ONE_MONTH:s.rsRating1m,THREE_MONTH:s.rsRating3m,SIX_MONTH:s.rsRating6m,TWELVE_MONTH:s.rsRating12m};
      return compare(ratings[String(p.window||'FRONT_WEIGHTED').toUpperCase()],p.comparison,p.value);
    }; break;
    case 'mom_return': {
      const period = Number(String(p.period).replace('D',''));
      if (![1,5,21,63,126,252].includes(period)) return null;
      fn = s => between(period === 1 ? s.changePct : s.metrics[`return${period}`],p.minReturn,p.maxReturn); break;
    }
    case 'mom_gap': fn = s => p.gapType === 'Gap Up' ? compare(s.metrics.gapPct,'ABOVE',p.minGapPct) : compare(s.metrics.gapPct,'BELOW',-p.minGapPct); break;
    case 'liq_turnover': fn = s => compare(s.metrics.turnover50,'ABOVE',p.minTurnoverCr); break;
    case 'AVG_TURNOVER':
      if (![20,50,100].includes(Number(p.lookbackDays)) || !['DAILY','daily',''].includes(String(p.windowMinutes ?? ''))) return null;
      fn = s => compare(s.metrics[`turnover${p.lookbackDays}`],p.comparison,p.valueCr); break;
    case 'liq_market_cap': metadata = true; fn = s => between(s.marketCapCrore,p.minMarketCap,p.maxMarketCap); break;
    case 'MARKETCAP': metadata = true; fn = s => compare(s.marketCapCrore,p.comparison,p.valueCr); break;
    case 'fund_pe_ratio': metadata = true; fn = s => between(s.peRatio,p.minPe,p.maxPe); break;
    case 'PE_RATIO':
      if (p.reportType !== 'PREFER_CONSOLIDATED') return null;
      metadata = true; fn = s => compare(s.peRatio,p.comparison,p.value); break;
    case 'FF_MARKETCAP': metadata = true; fn = s => {
      const cap=number(s.marketCapCrore), float=number(s.freeFloatPct);
      return cap == null || float == null ? null : compare(cap*float/100,p.comparison,p.valueCr);
    }; break;
    case 'ABSOLUTE_VOLUME': fn = s => compare(s.volume,p.comparison,p.value); break;
    case 'ABSOLUTE_EPS': metadata = true; fn = s => compare(s.epsTtm,p.comparison,p.value); break;
    case 'DIVIDEND_YIELD': metadata = true; fn = s => compare(s.dividendYieldPct,p.comparison,p.value); break;
    case 'fund_roe': metadata = true; fn = s => compare(s.roePct,'ABOVE',p.minRoe); break;
    case 'fund_free_float': metadata = true; fn = s => between(s.freeFloatPct,p.minFloat,p.maxFloat); break;
    case 'fund_stock_price': fn = s => compare(s.close,'GREATER',p.minPrice); break;
    case 'PRICE_RANGE': fn = s => between(s.close,p.minPrice,p.maxPrice); break;
    case 'PCT_FROM_ATH': fn = s => compare(s.distAthPct,p.comparison,p.pct); break;
    case 'FUNDAMENTAL_METRIC': {
      const field: Record<string, keyof SnapshotStock> = {
        ROE:'roePct', ROCE:'rocePct', OPM_TTM:'opmTtmPct', DEBT_TO_EQUITY:'debtToEquity',
        PEG_RATIO:'pegRatio', SALES_GROWTH_5Y:'salesGrowth5yPct',
        TOTAL_REVENUE_IN_LAKHS:'totalRevenueLakh', NON_CURRENT_ASSETS_IN_LAKHS:'nonCurrentAssetsLakh', TOTAL_LIABILITIES_IN_LAKHS:'totalLiabilitiesLakh', INTEREST_COVERAGE:'interestCoverage', DIVIDEND_PER_SHARE_LATEST:'dividendPerShare', VWAP:'vwap', ALL_TIME_HIGH:'allTimeHigh', ALL_TIME_LOW:'allTimeLow', RETURN_5Y:'return5yPct',
      };
      const key = field[String(p.metric).toUpperCase()];
      if (!key) return null;
      metadata = !['dividendPerShare','vwap','allTimeHigh','allTimeLow','return5yPct'].includes(key);
      fn = s => key === "vwap" && s.vwapAsOfDate !== session ? null : compare(s[key],p.comparison,p.value); break;
    }
    case 'EPS_LAST_YEAR_HIGHER':
      metadata = true; fn = s => {
        const latest = number(s.epsLastYear), prior = number(s.epsTwoYearsBack);
        return latest == null || prior == null ? null : latest > prior;
      }; break;
    case 'SECTOR': case 'INDUSTRY': {
      metadata = true;
      const values = String(p.values ?? '').split(',').map((value:string)=>value.trim().toLowerCase()).filter(Boolean);
      const key = c.conditionId === 'SECTOR' ? 'sector' : 'industry';
      fn = s => values.length ? values.includes(String(key === 'sector' ? s.sector : s.industry).toLowerCase()) : false; break;
    }
    case 'PRICE_BAND': {
      metadata = true; const values=String(p.values ?? '').split(',').map((value:string)=>value.trim().replace('%','')).filter(Boolean);
      fn=s=>s.circuitLimit ? values.includes(String(s.circuitLimit).replace('%','')) : null; break;
    }
    case 'CIRCUIT_BAND_MIN': metadata=true; fn=s=>{
      if (!s.circuitLimit) return null; if (/^(?:-|none|no\s*band)$/i.test(s.circuitLimit.trim())) return true;
      const value=Number(String(s.circuitLimit).replace('%','')); return Number.isFinite(value) ? value>=Number(p.minBandPct) : null;
    }; break;
    case 'SERIES': {
      metadata=true; const values=String(p.values ?? '').split(',').map((value:string)=>value.trim().toUpperCase()).filter(Boolean);
      fn=s=>values.length ? values.includes(String(s.series).toUpperCase()) : false; break;
    }
    case 'INDEX_MEMBERSHIP': metadata=true; fn=s=>String(p.indexName ?? '').trim() ? s.indexMemberships.map(value=>value.toUpperCase()).includes(String(p.indexName).toUpperCase()) : null; break;
    case 'FNO_BAN': metadata=true; fn=s=>s.fnoBan == null ? null : String(p.mode).toUpperCase()==='ONLY' ? s.fnoBan : !s.fnoBan; break;
    case 'EXCLUDE_SURVEILLANCE':
      metadata = true;
      fn = s => s.surveillanceAvailable !== true || s.surveillanceAsOfDate !== session
        ? null
        : !(s.isAsm || s.isGsm);
      break;
    case 'misc_exclude_circuit': metadata = true; fn = s => !s.circuitLimit ? null : !p.circuitBands.includes(s.circuitLimit.trim().replace('%','')); break;
    case 'misc_fno_only': metadata = true; fn = s => s.isFno == null ? null : s.isFno === (p.isFno === 'true'); break;
    default:
      if (!c.conditionId.startsWith('lib-')) return null;
      fn = s => s.presetMatches[c.conditionId] ?? null;
      return c.isNegated ? s => { const v = fn(s); return v == null ? null : !v; } : fn;
  }
  const checked: Predicate = s => metadata
    ? s.metadataAsOfDate === session ? fn(s) : null
    : s.historyAligned && s.asOfDate === session ? fn(s) : null;
  return c.isNegated ? s => { const v = checked(s); return v == null ? null : !v; } : checked;
}

export function evaluateSnapshotCondition(stock: SnapshotStock, condition: ActiveCondition, session: string): Truth {
  const plain = {...condition,isNegated:false};
  const predicate = leaf(plain,session);
  const value = predicate ? predicate(stock) : null;
  return condition.isNegated && value != null ? !value : value;
}

function compile(node: ExpressionNode, session: string): Predicate | null {
  if (node.type === 'condition') return leaf(node.condition, session);
  const children = node.children.map(n => compile(n, session));
  if (children.some(fn => fn == null)) return null;
  if (!children.length) return () => true;
  return s => combine(children.map(fn => fn!(s)), node.operator === 'all');
}

interface Matches { rows: SnapshotStock[]; universeCount: number }
const matchCache = new WeakMap<Snapshot,Map<string,Matches>>();

export function screenSnapshot(data: Snapshot, request: ScreenerRunRequest): ScreenerRunResponse | null {
  if (request.textQuery?.trim()) return null;
  const key = JSON.stringify([request.expressionTree,request.universe,request.customSymbols,request.sort]);
  let cache = matchCache.get(data);
  if (!cache) { cache = new Map(); matchCache.set(data,cache); }
  let matches = cache.get(key);
  if (!matches) {
    const predicate = compile(request.expressionTree, data.asOfDate);
    if (!predicate) return null;
    const labels: Record<string, string[]> = {
      nifty50:['NIFTY 50','NIFTY50'], nifty500:['NIFTY 500','NIFTY500'],
      midsmall400:['NIFTY MIDSMALLCAP 400','NIFTY MIDSMALL 400','MIDSMALL400'],
    };
    const symbols = new Set(request.customSymbols?.map(s => s.toUpperCase()));
    const universe = data.stocks.filter(s => request.universe === 'custom' ? symbols.has(s.symbol)
      : request.universe === 'mainboard' || s.indexMemberships.some(label => labels[request.universe]?.includes(label.toUpperCase())));
    const rows = universe.filter(s => predicate(s) === true && number(s.close) != null);
    const field = (request.sort?.field ?? 'symbol') as keyof SnapshotStock;
    rows.sort((a,b) => {
      const x = a[field], y = b[field];
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      const order = x < y ? -1 : x > y ? 1 : 0;
      return request.sort?.direction === 'desc' ? -order : order;
    });
    matches = {rows,universeCount:universe.length};
    cache.set(key,matches);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  const rows = matches.rows;
  const page = Math.max(1,request.page), size = Math.max(1,Math.min(100,request.pageSize));
  return { resolvedSession:{date:data.asOfDate,sessionId:`NSE-${data.asOfDate.replaceAll('-','')}-FINAL`,status:'closed',isHistorical:false},
    immutableRevision:data.revision,rows:rows.slice((page-1)*size,page*size),matchCount:rows.length,totalUniverseCount:matches.universeCount,
    page,pageSize:size,perConditionCoverage:{},unavailableDiagnostics:[],warnings:[] };
}
