import type { SnapshotStock } from '../api/snapshotScreen';
import type { ActiveCondition } from '../types/screener';

const fundamentalFields:Record<string,string>={
  market_cap_crore:'marketCapCrore',pe_ratio:'peRatio',debt_to_equity:'debtToEquity',eps_ttm:'epsTtm',
  promoter_holding_percent:'promoterHoldingPct',public_holding_percent:'publicHoldingPct',number_of_shareholders:'numberOfShareholders',
  dividend_yield_percent:'dividendYieldPct',face_value:'faceValue',total_income_in_lakhs:'totalIncomeLakh',
  total_expense_in_lakhs:'totalExpenseLakh',profit_before_tax_in_lakhs:'profitBeforeTaxLakh',
  total_tax_expenses_in_lakhs:'totalTaxExpensesLakh',net_profit_in_lakhs:'netProfitLakh',total_equity_in_lakhs:'totalEquityLakh',
  total_assets_in_lakhs:'totalAssetsLakh',current_assets_in_lakhs:'currentAssetsLakh',non_current_assets_in_lakhs:'nonCurrentAssetsLakh',
  total_liabilities_in_lakhs:'totalLiabilitiesLakh',current_liabilities_in_lakhs:'currentLiabilitiesLakh',
  non_current_liabilities_in_lakhs:'nonCurrentLiabilitiesLakh',total_revenue_in_lakhs:'totalRevenueLakh',
  operating_cash_flow_in_lakhs:'operatingCashFlowLakh',investing_cash_flow_in_lakhs:'investingCashFlowLakh',
  net_cash_flow_in_lakhs:'netCashFlowLakh',interest_coverage:'interestCoverage',
};

const priceFields: Record<string,string> = {
  close:'close',open:'open',high:'high',low:'low',volume_lakh:'volume',
  vwap:'vwap',dividend_per_share_latest:'dividendPerShare',
  all_time_high:'allTimeHigh',all_time_low:'allTimeLow',return_5y:'return5yPct',
};
const metricFields: Record<string,string> = {
  sma_20:'sma20',sma_50:'sma50',sma_200:'sma200',return_1m:'return21',return_1y:'return252',
};

export function snapshotFieldDependency(field: string): 'core' | 'technical' | 'fundamentals' | null {
  if (Object.hasOwn(fundamentalFields,field)) return 'fundamentals';
  if (Object.hasOwn(metricFields,field) || ['all_time_high','all_time_low','return_5y'].includes(field)) return 'technical';
  if (['vwap','dividend_per_share_latest'].includes(field)) return 'fundamentals';
  return Object.hasOwn(priceFields,field) ? 'core' : null;
}

/** Published values and freshness rules are identical in text and builder screens. */
export function readSnapshotField(stock: SnapshotStock, field: string, session: string): number | null {
  if (!snapshotFieldDependency(field)) return null;
  const metadata = Object.hasOwn(fundamentalFields,field);
  const publishedOnly = ['vwap', 'dividend_per_share_latest'].includes(field);
  if (metadata ? stock.metadataAsOfDate !== session
    : stock.asOfDate !== session || (!publishedOnly && !stock.historyAligned)) return null;
  if (field === 'vwap' && stock.vwapAsOfDate !== session) return null;
  const value = Object.hasOwn(metricFields,field) ? stock.metrics?.[metricFields[field]]
    : (stock as unknown as Record<string,unknown>)[fundamentalFields[field] ?? priceFields[field]];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return field === 'volume_lakh' ? value / 100000 : value;
}

/** Only aliases with exactly equivalent published-value semantics are normalized. */
export function normalizeSnapshotCondition(condition: ActiveCondition): ActiveCondition {
  const id = condition.conditionId, p = condition.parameters;
  if (['rs_rating','rs_1month','rs_3month'].includes(id)) return {...condition,conditionId:'RS_RATING',parameters:{
    window:id === 'rs_rating' ? 'FRONT_WEIGHTED' : id === 'rs_1month' ? 'ONE_MONTH' : 'THREE_MONTH',
    comparison:'ABOVE',value:p.minRsRating ?? 80,
  }};
  if (id === 'range_52w_proximity') return {...condition,
    conditionId:p.target === 'Low' ? 'PCT_FROM_52W_LOW' : 'PCT_FROM_52W_HIGH',
    parameters:{comparison:'BELOW',pct:p.maxDistancePct ?? 5},
  };
  return condition;
}
