import type { ParameterSpec } from '../types/screener';
import technicalConfigurations from '../data/snapshotTechnicals.json';

export const RANGE_FILTERS = ['PRICE_RANGE', 'mom_return', 'mom_rvol', 'fund_free_float', 'fund_pe_ratio', 'liq_market_cap'];

// Presentation only: retain the evaluator's parameter values and boundaries.
export function comparisonLabel(conditionId: string, value: string | number, fallback: string): string {
  const op = String(value).toUpperCase();
  if (conditionId === 'PRICE_CHANGE_PCT') {
    if (op === 'ABOVE') return '≥ Return at least';
    if (op === 'BELOW') return '≤ − Decline at least';
  }
  if (['PRICE_VS_EMA', 'PRICE_VS_SMA', 'trend_price_vs_ma'].includes(conditionId)) {
    if (op === 'ABOVE') return '> Above';
    if (op === 'BELOW') return '< Below';
  }
  return ({ABOVE:'≥ At least', BELOW:'≤ At most', GREATER:'> Greater than', LESS:'< Less than', EQUAL:'= Equal to'} as Record<string, string>)[op] ?? fallback;
}

export function parameterPresentation(conditionId: string, parameter: ParameterSpec) {
  const config = technicalConfigurations.find(config => config.id === conditionId);
  const fixedOperator = config?.threshold === parameter.id && !config.comparison ? config.operator : undefined;
  const boundary = ({
    PRICE_RANGE: {minPrice:'≥', maxPrice:'≤'},
    mom_return: {minReturn:'≥', maxReturn:'≤'},
    mom_rvol: {minRvol:'≥', maxRvol:'≤'},
    fund_free_float: {minFloat:'≥', maxFloat:'≤'},
    fund_pe_ratio: {minPe:'≥', maxPe:'≤'},
    liq_market_cap: {minMarketCap:'≥', maxMarketCap:'≤'},
    fund_stock_price: {minPrice:'>'},
    fund_roe: {minRoe:'≥'},
    liq_turnover: {minTurnoverCr:'≥'},
    trend_persistent_momentum: {minDaysAboveEMA:'≥'},
    range_52w_proximity: {maxDistancePct:'≤'},
    VOLUME_VS_AVG: {multiple:'≥'},
    CIRCUIT_BAND_MIN: {minBandPct:'≥'},
    rs_rating: {minRsRating:'≥'},
  } as Record<string, Record<string, string>>)[conditionId]?.[parameter.id];
  return {label: parameter.label, prefix: boundary ?? (fixedOperator === 'ABOVE' ? '≥' : fixedOperator === 'BELOW' ? '≤' : ''), unit: parameter.unit};
}

export function filterLogicHint(conditionId: string, parameters: Record<string, unknown>): string | undefined {
  if (conditionId === 'PERSISTENT_MOMENTUM') return 'Match any one EMA rule (OR). One dip is allowed if a later bar reaches its high and closes above the EMA.';
  if (conditionId === 'MA_STACK') {
    const periods = [...new Set(String(parameters.periods).split(',').map(Number))]
      .filter(period => Number.isInteger(period) && period > 0).sort((a, b) => a - b);
    return [...(parameters.priceAbove ? ['Close'] : []), ...periods.map(period => `${parameters.maType} ${period}`)].join(' > ');
  }
  if (RANGE_FILTERS.includes(conditionId)) return 'Between both bounds, inclusive (AND).';
  return undefined;
}
