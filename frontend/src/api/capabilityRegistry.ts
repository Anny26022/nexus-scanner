import type { ActiveCondition, ExpressionNode } from '../types/screener';
import presetDefinitions from '../data/presetDefinitions.json';
import baseContextKeys from '../data/baseContextKeys.json';

export type PackDependency = 'core' | 'technical' | 'fundamentals' | 'advanced';
export interface ConditionCapability { dependencies: PackDependency[]; browser: (condition: ActiveCondition) => boolean }

const always = () => true;
const never = () => false;
const technical = (browser: ConditionCapability['browser'] = always): ConditionCapability => ({dependencies:['core','technical'],browser});
const fundamental = (browser: ConditionCapability['browser'] = always): ConditionCapability => ({dependencies:['core','fundamentals'],browser});
const advanced = (): ConditionCapability => ({dependencies:['core','advanced'],browser:never});
const presetIds = new Set(presetDefinitions.map(item => item.id));

const scalarTechnical = new Set([
  'BASE_STAGE','BASE_METRIC','BASE_FORMULA','PRICE_VS_SMA','PRICE_VS_EMA','PRICE_CHANGE_PCT','GAP_UP','GAP_DOWN','VOLUME_VS_AVG','NEW_HIGH','NEW_LOW','PCT_FROM_52W_HIGH',
  'PCT_FROM_52W_LOW','PCT_FROM_ATH','ATR_PCT','RS_RATING','AVG_TURNOVER','ADR_PCT','ABSOLUTE_VOLUME',
  'PRICE_RANGE','trend_price_vs_ma','mom_rvol','mom_return','mom_gap','liq_turnover','fund_stock_price',
]);
const scalarFundamental = new Set([
  'MARKETCAP','FF_MARKETCAP','PE_RATIO','FUNDAMENTAL_METRIC','EPS_LAST_YEAR_HIGHER',
  'SECTOR','INDUSTRY','PRICE_BAND','CIRCUIT_BAND_MIN','SERIES','INDEX_MEMBERSHIP','FNO_BAN',
  'EXCLUDE_SURVEILLANCE','ABSOLUTE_EPS','DIVIDEND_YIELD','fund_pe_ratio','fund_roe','fund_free_float',
  'liq_market_cap','misc_exclude_circuit','misc_fno_only',
]);

function parameterCompatible(condition: ActiveCondition): boolean {
  const p = condition.parameters;
  switch (condition.conditionId) {
    case 'BASE_METRIC': case 'BASE_FORMULA': return ![p.metric,p.rightMetric].some(value=>{const path=String(value??'');return path.startsWith('base.parts.')||(['current','selection'].includes(path.split('.')[0])&&!baseContextKeys.includes(path.split('.')[1]));});
    case 'PRICE_CHANGE_PCT': return [1,5,21,63,126,252].includes(Number(p.overDays));
    case 'VOLUME_VS_AVG': return Number(p.avgDays) === 20 && Number(p.withinDays) === 1;
    case 'PRICE_VS_EMA': return Number(p.persistDays) === 1 && [20,50,200].includes(Number(p.period));
    case 'PRICE_VS_SMA': return Number(p.persistDays) === 1 && [10,20,50,200].includes(Number(p.period));
    case 'GAP_UP': case 'GAP_DOWN': return Number(p.withinDays) === 1;
    case 'NEW_HIGH': case 'NEW_LOW': return Number(p.withinDays) === 1 && [20,50,252].includes(Number(p.lookbackDays));
    case 'ATR_PCT': return Number(p.period) === 14;
    case 'AVG_TURNOVER': return ['', 'DAILY', 'daily'].includes(String(p.windowMinutes ?? '')) && [20,50,100].includes(Number(p.lookbackDays));
    case 'ADR_PCT': return [14,20].includes(Number(p.lookbackDays));
    case 'PE_RATIO': return String(p.reportType) === 'PREFER_CONSOLIDATED';
    case 'trend_price_vs_ma': return String(p.maType) === 'SMA' && [10,20,50,200].includes(Number(p.maPeriod));
    case 'mom_return': return [1,5,21,63,126,252].includes(Number(String(p.period).replace('D','')));
    default: return true;
  }
}

export function conditionCapability(condition: ActiveCondition): ConditionCapability {
  if (condition.conditionId.startsWith('lib-')) return presetIds.has(condition.conditionId) ? technical() : advanced();
  if (condition.conditionId === 'FUNDAMENTAL_METRIC' && ['ALL_TIME_HIGH','ALL_TIME_LOW','RETURN_5Y'].includes(String(condition.parameters.metric))) return technical();
  if (scalarTechnical.has(condition.conditionId)) return technical(parameterCompatible);
  if (scalarFundamental.has(condition.conditionId)) return fundamental(parameterCompatible);
  return advanced();
}

export function expressionPlan(expression: ExpressionNode, hasTextQuery = false) {
  const dependencies = new Set<PackDependency>(['core']);
  let browser = !hasTextQuery;
  const visit = (node: ExpressionNode) => {
    if (node.type === 'group') { node.children.forEach(visit); return; }
    const capability = conditionCapability(node.condition);
    capability.dependencies.forEach(value => dependencies.add(value));
    browser &&= capability.browser(node.condition);
  };
  visit(expression);
  if (!browser) dependencies.add('advanced');
  return {browser, dependencies:[...dependencies]};
}
