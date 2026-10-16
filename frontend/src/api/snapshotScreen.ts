import type { ActiveCondition, ExpressionNode, ScreenerRunRequest, ScreenerRunResponse, StockRow } from '../types/screener';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { PRESET_ELIGIBILITY, presetEligibilityTargets, hasCustomPresetEligibility } from '../data/presetEligibility';
import { snapshotFundamentals } from '../data/snapshotFundamentals';
import technicalConfigurations from '../data/snapshotTechnicals.json';
import { MOVING_AVERAGE_RULES } from '../data/movingAverageRules';
import { isTradingViewCondition, tradingViewFilterGroups, tradingViewMetrics } from '../data/tradingViewMetrics';

const presetIds = new Set(PRESET_CATALOG.map(preset => preset.id));

type Truth = boolean | null;
export interface SnapshotStock extends StockRow {
  asOfDate: string | null;
  metadataAsOfDate: string | null;
  historyAligned: boolean;
  indexMemberships: string[];
  metrics: Record<string, number | null>;
  fnoBanAsOfDate?: string | null;
  presetMatches: Record<string, Truth>;
  presetRuleMatches?: Record<string, Truth>;
  roePct: number | null;
  freeFloatPct: number | null;
}
export interface Snapshot {
  tradingViewMetricsVersion?: number;
  presetRuleMatchesVersion?: number;
  technicalMetricsVersion?: number;
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
const list = (value: unknown) => (Array.isArray(value) ? value : String(value ?? '').split(','))
  .map(item => String(item).trim().toUpperCase()).filter(Boolean);
const band = (value: unknown) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (['NO BAND','NONE','-'].includes(normalized)) return 'NO BAND';
  const numeric = normalized.replace('%','').trim();
  return numeric && Number.isFinite(Number(numeric)) ? String(Number(numeric)) : null;
};
const extraFundamentalFields = Object.fromEntries(snapshotFundamentals.map(metric => [metric.value, metric.field]));
export const SNAPSHOT_MA_PERIODS = [9,10,20,21,50,150,200];
const maPeriods = SNAPSHOT_MA_PERIODS;

function leaf(c: ActiveCondition, session: string): Predicate | null {
  const p = c.parameters;
  if (isTradingViewCondition(c.conditionId)) {
    const metric = tradingViewMetrics.find(metric => metric.id === p.metric
      && metric.category === tradingViewFilterGroups[c.conditionId].category);
    if (!metric || !['ABOVE','BELOW','GREATER','LESS','EQUAL'].includes(p.comparison)
        || String(p.value ?? '').trim() === '' || !Number.isFinite(Number(p.value))) return null;
    return s => {
      const value = s.tradingview?.asOfDate === session ? s.tradingview.values[metric.id] : null;
      const result = compare(value, p.comparison, Number(p.value));
      return result == null ? null : c.isNegated ? !result : result;
    };
  }
  let fn: Predicate;
  let metadata = false;
  const config = technicalConfigurations.find(config => config.id === c.conditionId);
  if (config) {
    if (Object.entries(config.fixed).some(([key, value]) => typeof value === 'boolean' ? p[key] !== value : String(p[key]) !== String(value))) return null;
    if (config.threshold && (String(p[config.threshold] ?? '').trim() === '' || !Number.isFinite(Number(p[config.threshold])))) return null;
    if (config.comparison && !['ABOVE','BELOW','GREATER','LESS','EQUAL'].includes(p[config.comparison])) return null;
    if (['CONSECUTIVE_UP_DAYS','mom_consecutive_up'].includes(c.conditionId)
        && (!Number.isInteger(Number(p[config.threshold!])) || Number(p[config.threshold!]) < 1)) return null;
    fn = s => {
      if (['CONSECUTIVE_UP_DAYS','mom_consecutive_up'].includes(c.conditionId)
          && (number(s.metrics.historySessions) == null || Number(s.metrics.historySessions) <= Number(p[config.threshold!]))) return null;
      const value = s.metrics[c.conditionId];
      return config.threshold ? compare(value, config.comparison ? p[config.comparison] : config.operator!, Number(p[config.threshold]))
        : value === 1 ? true : value === 0 ? false : null;
    };
    const checked: Predicate = s => s.historyAligned && s.asOfDate === session ? fn(s) : null;
    return c.isNegated ? s => { const value = checked(s); return value == null ? null : !value; } : checked;
  }
  switch (c.conditionId) {
    case 'PRICE_VS_MAS': {
      if (!Array.isArray(p.rules) || !p.rules.length || new Set(p.rules).size !== p.rules.length) return null;
      const rules = p.rules.map((value: unknown) => MOVING_AVERAGE_RULES.find(rule => rule.value === value));
      if (rules.some(rule => !rule)) return null;
      fn = s => combine(rules.map(rule => {
        const average = number(s.metrics[rule!.field]), close = number(s.close);
        return average == null || close == null ? null : rule!.above ? close > average : close < average;
      }), true);
      break;
    }
    case 'PRICE_VS_EMA': case 'trend_persistent_momentum': {
      const period = c.conditionId === 'PRICE_VS_EMA' ? Number(p.period) : 20;
      const days = Number(c.conditionId === 'PRICE_VS_EMA' ? p.persistDays : p.minDaysAboveEMA);
      const side = c.conditionId === 'PRICE_VS_EMA' ? p.comparison : 'ABOVE';
      if (!maPeriods.includes(period) || !Number.isInteger(days) || days < 1 || !['ABOVE','BELOW'].includes(side)) return null;
      fn = s => {
        const valid = number(s.metrics[`emaValid${period}`]);
        return valid == null || valid < days ? null : compare(s.metrics[`ema${side === 'ABOVE' ? 'Above' : 'Below'}Run${period}`], 'ABOVE', days);
      }; break;
    }
    case 'FNO_BAN':
      if (!['ONLY','EXCLUDE'].includes(p.mode)) return null;
      fn = s => s.fnoBanAsOfDate !== session || typeof s.fnoBan !== 'boolean' ? null : p.mode === 'ONLY' ? s.fnoBan : !s.fnoBan; break;
    case 'SECTOR': case 'INDUSTRY': case 'SERIES': {
      metadata = true;
      const field = c.conditionId === 'SECTOR' ? 'sector' : c.conditionId === 'INDUSTRY' ? 'industry' : 'series';
      const wanted = list(p.values);
      fn = s => !s[field] ? null : wanted.includes(s[field].trim().toUpperCase()); break;
    }
    case 'INDEX_MEMBERSHIP':
      metadata = true; fn = s => Array.isArray(s.indexMemberships) && s.indexMemberships.length > 0
        ? s.indexMemberships.some(value => value.trim().toUpperCase() === String(p.indexName).trim().toUpperCase()) : null; break;
    case 'PRICE_BAND': {
      metadata = true; const wanted = list(p.values).map(band);
      fn = s => band(s.circuitLimit) == null ? null : wanted.includes(band(s.circuitLimit)); break;
    }
    case 'CIRCUIT_BAND_MIN':
      metadata = true; fn = s => {
        const value = band(s.circuitLimit);
        return value == null ? null : value === 'NO BAND' || Number(value) >= p.minBandPct;
      }; break;
    case 'FF_MARKETCAP':
      metadata = true; fn = s => {
        const cap = number(s.marketCapCrore), float = number(s.freeFloatPct);
        return cap == null || float == null ? null : compare(cap * float / 100, p.comparison, p.valueCr);
      }; break;
    case 'rs_rating': fn = s => compare(s.rsRating, 'ABOVE', p.minRsRating); break;
    case 'RS_RATING':
      if (p.window !== 'FRONT_WEIGHTED') return null;
      fn = s => compare(s.rsRating, p.comparison, p.value); break;
    case 'PRICE_CHANGE_PCT': {
      const period = Number(p.overDays);
      if (![1,5,21,63,126,252].includes(period)) return null;
      // Match the Python scanner: "Below 5%" means a decline of at least 5%.
      const target = p.comparison === 'BELOW' ? -Math.abs(p.pct) : p.pct;
      fn = s => compare(period === 1 ? s.changePct : s.metrics[`return${period}`], p.comparison, target); break;
    }
    case 'GAP_UP': case 'GAP_DOWN':
      if (Number(p.withinDays) !== 1) return null;
      fn = s => compare(s.metrics.gapPct, c.conditionId === 'GAP_UP' ? 'ABOVE' : 'BELOW',
        c.conditionId === 'GAP_UP' ? p.minGapPct : -p.minGapPct); break;
    case 'PCT_FROM_52W_HIGH': case 'PCT_FROM_52W_LOW': case 'range_52w_proximity':
      fn = s => {
        const high = c.conditionId === 'PCT_FROM_52W_HIGH' || (c.conditionId === 'range_52w_proximity' && p.target === 'High');
        const value = number(high ? s.dist52wHighPct : s.dist52wLowPct);
        return s.metadataAsOfDate !== session || value == null ? null : compare(Math.abs(value),
          c.conditionId === 'range_52w_proximity' ? 'BELOW' : p.comparison,
          c.conditionId === 'range_52w_proximity' ? p.maxDistancePct : p.pct);
      }; break;
    case 'ATR_PCT':
      if (Number(p.period) !== 14) return null;
      fn = s => {
        const atr = number(s.atr14), close = number(s.close);
        return s.metadataAsOfDate !== session || atr == null || close == null || close <= 0 ? null : compare(atr / close * 100, p.comparison, p.pct);
      }; break;
    case 'ADR_PCT':
      if (Number(p.lookbackDays) !== 20) return null;
      fn = s => s.metadataAsOfDate !== session ? null : compare(s.adr20Pct, p.comparison, p.pct); break;
    case 'MA_STACK': case 'trend_ma_stack': {
      const periods = c.conditionId === 'trend_ma_stack' ? p.stackOrder === '10_above_20_above_50' ? [10,20,50] : [20,50,200]
        : list(p.periods).map(Number).sort((a,b) => a-b);
      const kind = c.conditionId === 'trend_ma_stack' ? p.stackOrder === '10_above_20_above_50' ? 'SMA' : 'EMA' : p.maType;
      if (c.conditionId === 'trend_ma_stack' ? p.stackOrder !== '10_above_20_above_50'
          && p.stackOrder !== '20_above_50_above_200'
        : !['SMA','EMA'].includes(kind) || periods.length < 2 || new Set(periods).size !== periods.length
          || periods.some(period => !maPeriods.includes(period))) return null;
      fn = s => {
        const values = periods.map(period => number(s.metrics[`${kind.toLowerCase()}${period}`]));
        if (values.some(value => value == null) || (p.priceAbove && number(s.close) == null)) return null;
        return values.slice(1).every((value, index) => values[index]! > value!)
          && (!p.priceAbove || s.close > values[0]!);
      }; break;
    }
    case 'mom_rvol': fn = s => between(s.rvol, p.minRvol, p.maxRvol); break;
    case 'VOLUME_VS_AVG':
      if (p.avgDays !== 20 || p.withinDays !== 1) return null;
      fn = s => compare(s.rvol, 'ABOVE', p.multiple); break;
    case 'trend_price_vs_ma': {
      if (!['SMA','EMA'].includes(p.maType) || !maPeriods.includes(Number(p.maPeriod))) return null;
      fn = s => {
        const ma = number(s.metrics[`${p.maType.toLowerCase()}${p.maPeriod}`]);
        if (ma == null || number(s.close) == null) return null;
        if (p.operator === 'within_pct') return Math.abs((s.close/ma-1)*100) <= p.thresholdPct;
        if (p.maType === 'EMA') return compare(s.metrics[`ema${p.operator === 'above' ? 'Above' : 'Below'}Run${p.maPeriod}`], 'ABOVE', 1);
        return p.operator === 'above' ? s.close > ma : s.close < ma;
      }; break;
    }
    case 'PRICE_VS_SMA':
      if (p.persistDays !== 1 || !maPeriods.includes(Number(p.period))) return null;
      fn = s => {
        const ma = number(s.metrics[`sma${p.period}`]);
        return ma == null || number(s.close) == null ? null : p.comparison === 'ABOVE' ? s.close > ma : s.close < ma;
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
        ...extraFundamentalFields,
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
    case 'EXCLUDE_SURVEILLANCE':
      metadata = true;
      fn = s => s.surveillanceAvailable !== true || s.surveillanceAsOfDate !== session
        ? null
        : !(s.isAsm || s.isGsm);
      break;
    case 'misc_exclude_circuit': metadata = true; fn = s => !s.circuitLimit ? null : !p.circuitBands.includes(s.circuitLimit.trim().replace('%','')); break;
    case 'misc_fno_only': metadata = true; fn = s => s.isFno == null ? null : s.isFno === (p.isFno === 'true'); break;
    default:
      if (!presetIds.has(c.conditionId)) return null;
      const targets = presetEligibilityTargets(p);
      if (!targets) return null;
      fn = s => {
        if (!hasCustomPresetEligibility(p)) return s.presetMatches[c.conditionId] ?? null;
        const eligibility = PRESET_ELIGIBILITY.map((rule, i): Truth => {
          if (targets[i] === null) return true;
          const value = rule.field === 'turnover50' ? s.metrics.turnover50 : s[rule.field as keyof SnapshotStock];
          return s.asOfDate !== session || s.metadataAsOfDate !== session ? null : compare(value, 'GREATER', targets[i]!);
        });
        const ruleMatch = s.historyAligned && s.asOfDate === session ? s.presetRuleMatches?.[c.conditionId] ?? null : null;
        return combine([...eligibility, ruleMatch], true);
      };
      return c.isNegated ? s => { const v = fn(s); return v == null ? null : !v; } : fn;
  }
  const checked: Predicate = s => metadata
    ? s.metadataAsOfDate === session ? fn(s) : null
    : s.historyAligned && s.asOfDate === session ? fn(s) : null;
  return c.isNegated ? s => { const v = checked(s); return v == null ? null : !v; } : checked;
}

type Coverage = ScreenerRunResponse['perConditionCoverage'];
function compile(node: ExpressionNode, session: string, coverage: Coverage): Predicate | null {
  if (node.type === 'condition') {
    const predicate = leaf(node.condition, session);
    if (!predicate) return null;
    const item = coverage[node.condition.instanceId] = {conditionId:node.condition.conditionId, evaluated:0, matched:0, coveragePct:0};
    return stock => {
      const value = predicate(stock);
      if (value != null) item.evaluated++;
      if (value === true) item.matched++;
      return value;
    };
  }
  const children = node.children.map(n => compile(n, session, coverage));
  if (children.some(fn => fn == null)) return null;
  if (!children.length) return () => true;
  return s => combine(children.map(fn => fn!(s)), node.operator === 'all');
}

function needsExpandedMetrics(node: ExpressionNode): boolean {
  if (node.type === 'group') return node.children.some(needsExpandedMetrics);
  const {conditionId:id, parameters:p} = node.condition;
  if (technicalConfigurations.some(config => config.id === id) || ['PRICE_VS_MAS','PRICE_VS_EMA','trend_persistent_momentum'].includes(id)) return true;
  if (id === 'MA_STACK') return p.maType === 'EMA' || list(p.periods).map(Number).some(period => ![10,20,50,200].includes(period));
  if (id === 'trend_ma_stack') return p.stackOrder !== '10_above_20_above_50';
  if (id === 'trend_price_vs_ma') return p.maType === 'EMA' || ![10,20,50,200].includes(Number(p.maPeriod));
  return id === 'PRICE_VS_SMA' && ![10,20,50,200].includes(Number(p.period));
}

// Share the evaluator's capability check with the filter UI, without loading data.
export function supportsSnapshotCondition(condition: ActiveCondition): boolean {
  return leaf(condition, '') !== null;
}

interface Matches { rows: SnapshotStock[]; universeCount: number; coverage:Coverage; diagnostics:ScreenerRunResponse['unavailableDiagnostics']; warnings:string[] }
const matchCache = new WeakMap<Snapshot,Map<string,Matches>>();

export function screenSnapshot(data: Snapshot, request: ScreenerRunRequest, allRows = false): ScreenerRunResponse | null {
  if (request.textQuery?.trim()) return null;
  const usesTradingView = (node:ExpressionNode):boolean => node.type === 'group'
    ? node.children.some(usesTradingView) : isTradingViewCondition(node.condition.conditionId);
  if (data.tradingViewMetricsVersion !== 1 && usesTradingView(request.expressionTree)) {
    throw new Error('These filters need a newer dataset. Try after the next daily data refresh.');
  }
  const customPreset = (node: ExpressionNode): boolean => node.type === 'group'
    ? node.children.some(customPreset) : presetIds.has(node.condition.conditionId) && hasCustomPresetEligibility(node.condition.parameters);
  if (data.presetRuleMatchesVersion !== 1 && customPreset(request.expressionTree)) {
    throw new Error('Preset eligibility edits need a newer dataset. Restore the default thresholds or try after the next data refresh.');
  }
  const key = JSON.stringify([request.expressionTree,request.universe,request.customSymbols,request.sort,request.announcementSymbols]);
  let cache = matchCache.get(data);
  if (!cache) { cache = new Map(); matchCache.set(data,cache); }
  let matches = cache.get(key);
  if (!matches) {
    const coverage: Coverage = {};
    const predicate = compile(request.expressionTree, data.asOfDate, coverage);
    if (!predicate) return null;
    const labels: Record<string, string[]> = {
      nifty50:['NIFTY 50','NIFTY50'], nifty500:['NIFTY 500','NIFTY500'],
      midsmall400:['NIFTY MIDSMALLCAP 400','NIFTY MIDSMALL 400','MIDSMALL400'],
    };
    const symbols = new Set(request.customSymbols?.map(s => s.toUpperCase()));
    const universe = data.stocks.filter(s => request.universe === 'custom' ? symbols.has(s.symbol)
      : request.universe === 'mainboard' || s.indexMemberships.some(label => labels[request.universe]?.includes(label.toUpperCase())));
    const announcementSymbols = request.announcementSymbols ? new Set(request.announcementSymbols) : null;
    const candidates = universe.filter(s => !announcementSymbols || announcementSymbols.has(s.symbol));
    const rows = candidates.filter(s => predicate(s) === true && number(s.close) != null);
    const diagnostics: ScreenerRunResponse['unavailableDiagnostics'] = [];
    for (const item of Object.values(coverage)) {
      item.coveragePct = candidates.length ? item.evaluated / candidates.length * 100 : 0;
      if (item.evaluated < candidates.length) diagnostics.push({conditionId:item.conditionId,
        reason:'Snapshot value or aligned history unavailable', affectedCount:candidates.length - item.evaluated});
    }
    const field = (request.sort?.field ?? 'symbol') as keyof SnapshotStock;
    rows.sort((a,b) => {
      const x = a[field], y = b[field];
      const order = x == null ? y == null ? 0 : -1 : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0;
      return request.sort?.direction === 'desc' ? -order : order;
    });
    const newerMetricsNeeded = data.technicalMetricsVersion !== 1 && needsExpandedMetrics(request.expressionTree);
    const warnings = diagnostics.length && newerMetricsNeeded
      ? ['This published snapshot predates the expanded technical filters. A new pipeline release is needed for their results.'] : [];
    matches = {rows,universeCount:universe.length,coverage,diagnostics,warnings};
    cache.set(key,matches);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  const search = request.symbolSearch?.trim().toLowerCase();
  const rows = search ? matches.rows.filter(row => row.symbol.toLowerCase().includes(search) || row.name.toLowerCase().includes(search)) : matches.rows;
  const page = Math.max(1,request.page), size = Math.max(1,Math.min(100,request.pageSize));
  return { resolvedSession:{date:data.asOfDate,sessionId:`NSE-${data.asOfDate.replaceAll('-','')}-FINAL`,status:'closed',isHistorical:false},
    immutableRevision:data.revision,rows:allRows ? rows : rows.slice((page-1)*size,page*size),matchedSymbols:rows.map(row=>row.symbol),matchCount:rows.length,totalUniverseCount:matches.universeCount,
    page,pageSize:size,perConditionCoverage:matches.coverage,unavailableDiagnostics:matches.diagnostics,warnings:matches.warnings };
}
