import type { EngineExpression } from './expression';
import baseMetrics from '../data/baseMetrics.json';

const OPERATORS: Record<string, string> = {
  '>': 'GREATER', '>=': 'ABOVE', '<': 'LESS', '<=': 'BELOW', '=': 'EQUAL',
};

const INDICATOR_FUNCTIONS = new Set([
  'rsi', 'cci', 'mfi', 'roc', 'obv', 'atr', 'stoch k', 'stoch d', 'williams r',
  'macd', 'macd signal', 'macd hist', 'plus di', 'minus di',
]);

/** Public query labels mapped to stable fields evaluated by FIELD_COMPARISON. */
export const QUERY_FIELD_ALIASES: Record<string, string> = {
  'market cap (in cr)': 'market_cap_crore', 'market cap': 'market_cap_crore',
  'price to earning (p/e)': 'pe_ratio', 'price to earnings (p/e)': 'pe_ratio',
  'p/e': 'pe_ratio', 'pe ratio': 'pe_ratio', 'debt to equity': 'debt_to_equity',
  'earning per share (eps)': 'eps_ttm', 'earnings per share (eps)': 'eps_ttm', 'eps': 'eps_ttm',
  'close price': 'close', 'current market price': 'close', 'open price': 'open',
  'high price': 'high', 'low price': 'low', 'volume (in lakhs)': 'volume_lakh', 'volume': 'volume_lakh',
  '20 dma': 'sma_20', '50 dma': 'sma_50', '200 dma': 'sma_200',
  '52w high': 'high_52w', '52w low': 'low_52w',
  'return over % 1 month': 'return_1m', 'return over % 1 year': 'return_1y',
  'return over % 3 years': 'return_3y', 'return over % 5 years': 'return_5y',
  'return over % year to date': 'return_ytd', 'daily volatility': 'daily_volatility',
  'annualized volatility': 'annualized_volatility', 'promoter holding (%)': 'promoter_holding_percent',
  'public holding': 'public_holding_percent', 'number of shareholders': 'number_of_shareholders',
  'dividend yield(%)': 'dividend_yield_percent', 'dividend yield (%)': 'dividend_yield_percent',
  'dividend yield': 'dividend_yield_percent', 'face value': 'face_value',
  'total income (in lakhs)': 'total_income_in_lakhs', 'total expense (in lakhs)': 'total_expense_in_lakhs',
  'profit before tax (in lakhs)': 'profit_before_tax_in_lakhs',
  'total tax expenses (in lakhs)': 'total_tax_expenses_in_lakhs',
  'net profit (in lakhs)': 'net_profit_in_lakhs', 'total equity (in lakhs)': 'total_equity_in_lakhs',
  'total assets (in lakhs)': 'total_assets_in_lakhs', 'current assets (in lakhs)': 'current_assets_in_lakhs',
  'non-current assets (in lakhs)': 'non_current_assets_in_lakhs',
  'total liabilities (in lakhs)': 'total_liabilities_in_lakhs',
  'current liabilities (in lakhs)': 'current_liabilities_in_lakhs',
  'non-current liabilities (in lakhs)': 'non_current_liabilities_in_lakhs',
  'total revenue (in lakhs)': 'total_revenue_in_lakhs',
  'operating cash flow (in lakhs)': 'operating_cash_flow_in_lakhs',
  'investing cash flow (in lakhs)': 'investing_cash_flow_in_lakhs',
  'net cash flow (in lakhs)': 'net_cash_flow_in_lakhs', 'interest coverage': 'interest_coverage',
  'vwap': 'vwap', 'dividend per share (dps)': 'dividend_per_share_latest',
  'all time high': 'all_time_high', 'all time low': 'all_time_low',
};

function leaf(conditionId: string, parameters: Record<string, unknown>): EngineExpression {
  return { type: 'condition', condition: { conditionId, parameters } };
}

function stripOuter(input: string): string {
  let text = input.trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0;
    let quote = '';
    let closesEarly = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if ((char === '"' || char === "'") && text[index - 1] !== '\\') quote = quote === char ? '' : quote || char;
      if (quote) continue;
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (depth < 0) throw new Error('Unbalanced parentheses in query');
      if (depth === 0 && index !== text.length - 1) { closesEarly = true; break; }
    }
    if (depth !== 0) throw new Error('Unbalanced parentheses in query');
    if (closesEarly) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function splitOutside(input: string, operator: 'OR' | 'AND'): string[] {
  const pieces: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if ((char === '"' || char === "'") && input[index - 1] !== '\\') { quote = quote === char ? '' : quote || char; continue; }
    if (quote) continue;
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (depth < 0) throw new Error('Unbalanced parentheses in query');
    if (depth !== 0) continue;
    const token = input.slice(index, index + operator.length);
    const before = input[index - 1];
    const after = input[index + operator.length];
    if (token.toUpperCase() === operator && (!before || /\s/.test(before)) && (!after || /\s/.test(after))) {
      pieces.push(input.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (depth !== 0 || quote) throw new Error('Unbalanced query expression');
  pieces.push(input.slice(start).trim());
  return pieces;
}

function argumentsOf(input: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if ((char === '"' || char === "'") && input[index - 1] !== '\\') { quote = quote === char ? '' : quote || char; continue; }
    if (quote) continue;
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      values.push(input.slice(start, index).trim().replace(/^['"]|['"]$/g, ''));
      start = index + 1;
    }
  }
  values.push(input.slice(start).trim().replace(/^['"]|['"]$/g, ''));
  return values;
}

function number(value: string, label: string): number {
  const parsed = Number(value.replaceAll(',', '').trim());
  if (!Number.isFinite(parsed)) throw new Error(`${label} requires a numeric value.`);
  return parsed;
}

function operand(value: string): number | { field: string } {
  const parsed = Number(value.replaceAll(',', '').trim());
  if (Number.isFinite(parsed)) return parsed;
  const field = QUERY_FIELD_ALIASES[value.trim().toLowerCase()];
  if (!field) throw new Error(`Unsupported query field: ${value.trim()}`);
  return { field };
}

function functionCondition(name: string, args: string[], operator?: string, rawValue?: string): EngineExpression {
  const key = name.replace(/[_\s]+/g, ' ').trim().toLowerCase();
  const comparison = OPERATORS[operator ?? '>='];
  const target = rawValue == null ? undefined : number(rawValue, name.trim());
  const arity = (minimum:number, maximum=minimum) => {
    if (args.length < minimum || args.length > maximum) throw new Error(`${name.trim()} requires ${minimum === maximum ? minimum : `${minimum}-${maximum}`} arguments.`);
  };
  if (['base stage', 'base metric', 'base formula'].includes(key)) {
    arity(key === 'base stage' ? 1 : key === 'base metric' ? 2 : 4, key === 'base stage' ? 2 : key === 'base metric' ? 2 : 4);
    const stage=args[0].toUpperCase();
    if (!['FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'].includes(stage)) throw new Error('Unsupported base stage');
    if (key === 'base stage') {
      if (operator) throw new Error('Base Stage does not accept a numeric comparison');
      const holdingPolicy=(args[1] || 'ANY').toUpperCase();
      if (!['ANY','STRICT','RETEST'].includes(holdingPolicy)) throw new Error('Unsupported holding policy');
      return leaf('BASE_STAGE',{stage,holdingPolicy});
    }
    if (target == null) throw new Error(`${name.trim()} requires a comparison and number.`);
    if (!baseMetrics.includes(args[1])) throw new Error('Unsupported base metric');
    if (key === 'base metric') return leaf('BASE_METRIC',{stage,metric:args[1],comparison,value:target});
    const arithmetic=args[2].toUpperCase();
    if (!['ADD','SUBTRACT','MULTIPLY','DIVIDE'].includes(arithmetic)) throw new Error('Unsupported base arithmetic');
    if (!baseMetrics.includes(args[3])) throw new Error('Unsupported base metric');
    return leaf('BASE_FORMULA',{stage,metric:args[1],arithmetic,rightMetric:args[3],comparison,value:target});
  }
  if (INDICATOR_FUNCTIONS.has(key)) {
    arity(0,1);
    if (target == null) throw new Error(`${name.trim()} requires a comparison and number.`);
    return leaf('INDICATOR_COMPARE', { leftIndicator:key.replaceAll(' ', '_').toUpperCase(), leftPeriod:number(args[0] || '14', name), leftOffset:0, op:comparison, rightIndicator:'', rightValue:target, rightPeriod:20, rightOffset:0, withinDays:1 });
  }
  if (key === 'adx') { arity(0,1); return leaf('ADX', { period:number(args[0] || '14', name), comparison, value:target }); }
  if (key === 'rvol') { arity(0,1); return leaf('VOLUME_VS_AVG', { avgDays:number(args[0] || '20', name), multiple:target, comparison, withinDays:1 }); }
  if (key === 'adr') { arity(0,1); return leaf('ADR_PCT', { lookbackDays:number(args[0] || '14', name), comparison, pct:target }); }
  if (key === 'volume trend') return leaf('AVG_VOLUME_RATIO', { recentDays:number(args[0], name), baseDays:number(args[1], name), comparison, ratio:target });
  if (key === 'earnings growth') return leaf('EARNINGS_GROWTH', { metric:args[0], basis:args[1], comparison, pct:target });
  if (key === 'days since earnings') {
    if (target == null) throw new Error('Days Since Earnings requires a comparison and number.');
    return leaf('DAYS_SINCE_EARNINGS', { comparison, days:target });
  }
  if (key === 'rs rating') {
    if (target == null) throw new Error('RS Rating requires a comparison and number.');
    return leaf('RS_RATING', { window:args[0] || 'FRONT_WEIGHTED', comparison, value:target });
  }
  if (key === 'vcp legs') {
    if (args.length < 3) throw new Error('VCP Legs requires minimum legs, lookback days and maximum final-leg percent.');
    return leaf('VCP_LEGS', { minLegs:number(args[0], name), lookbackDays:number(args[1], name), maxFinalLegPct:number(args[2], name), maxLegRatio:args[3] ? number(args[3], name) : 0.8, minSwingPct:args[4] ? number(args[4], name) : 1.5 });
  }
  if (key === 'delivery pct') {
    if (target == null) throw new Error('Delivery Pct requires a comparison and number.');
    return leaf('DELIVERY_PERCENT', { comparison, value:target });
  }
  if (key === 'ma stack') {
    if (args.length < 3) throw new Error('MA Stack requires periods, average type and price-above flag.');
    const periods = args[0].split(',').map(value => value.trim()).filter(Boolean);
    if (!periods.length || periods.some(value => !/^[1-9]\d*$/.test(value))) throw new Error('MA Stack periods must be positive integers.');
    return leaf('MA_STACK', { periods:periods.join(','), maType:args[1], priceAbove:args[2].toLowerCase() === 'true' });
  }
  if (key === 'ma slope') return leaf('MA_SLOPE', { period:number(args[0], name), maType:args[1], overDays:number(args[2], name), comparison, minChangePct:target });
  if (key === 'ma convergence') {
    if (target == null) throw new Error('MA Convergence requires a maximum spread comparison.');
    const periods = (args[0] ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (periods.length < 2 || new Set(periods).size !== periods.length || periods.some(value => !/^[1-9]\d*$/.test(value))) throw new Error('MA Convergence requires at least two distinct positive integer periods.');
    return leaf('MA_CONVERGENCE', { periods:periods.join(','), maType:args[1] || 'EMA', comparison, maxSpreadPct:target, withinDays:args[2] ? number(args[2], name) : 1 });
  }
  if (key === 'supertrend') return leaf('SUPERTREND', { period:number(args[0] || '10', name), multiplier:number(args[1] || '3', name), direction:args[2] || 'BULLISH', signal:args[3] || 'STATE', withinDays:args[4] ? number(args[4], name) : 1 });
  if (key === 'indicator compare') {
    if (args.length < 5) throw new Error('Indicator Compare requires left indicator, period, offset, operation and target.');
    const numericTarget = Number(args[4]);
    const rightIndicator = Number.isFinite(numericTarget) ? '' : args[4];
    return leaf('INDICATOR_COMPARE', { leftIndicator:args[0], leftPeriod:number(args[1], name), leftOffset:number(args[2], name), op:args[3], rightIndicator, rightValue:rightIndicator ? 0 : numericTarget, rightPeriod:rightIndicator && args[5] ? number(args[5], name) : 20, rightOffset:rightIndicator && args[6] ? number(args[6], name) : 0, withinDays:number(rightIndicator ? args[7] || '1' : args[5] || '1', name) });
  }
  if (key === 'divergence') {
    if (args.length < 9) throw new Error('Divergence requires oscillator, period, direction, type, pivot settings, lookback and recency.');
    return leaf('DIVERGENCE', { oscillator:args[0], oscPeriod:number(args[1], name), direction:args[2], variant:args[3], maxBarDifference:number(args[4], name), pivotLeft:number(args[5], name), pivotRight:number(args[6], name), lookbackDays:number(args[7], name), withinDays:number(args[8], name), invalidateOnBreak:args[9]?.toLowerCase() !== 'false' });
  }
  throw new Error(`Unsupported query function: ${name.trim()}`);
}

function compileLeaf(text: string): EngineExpression {
  const functionMatch = text.match(/^(.+?)\((.*)\)\s*(>=|<=|>|<|=)\s*(.+)$/);
  const fieldMatch = text.match(/^(.+?)\s*(>=|<=|>|<|=)\s*(.+)$/);
  const knownField = fieldMatch && QUERY_FIELD_ALIASES[fieldMatch[1].trim().toLowerCase()];
  if (functionMatch && !knownField) return functionCondition(functionMatch[1], argumentsOf(functionMatch[2]), functionMatch[3], functionMatch[4]);
  if (fieldMatch && ['days since earnings', 'rs rating', 'delivery pct'].includes(fieldMatch[1].trim().toLowerCase())) return functionCondition(fieldMatch[1], [], fieldMatch[2], fieldMatch[3]);
  const bareFunction = text.match(/^(.+?)\((.*)\)$/);
  if (bareFunction && !fieldMatch) return functionCondition(bareFunction[1], argumentsOf(bareFunction[2]));
  if (!fieldMatch) throw new Error(`Unsupported query clause: ${text}`);
  const left = operand(fieldMatch[1]);
  if (typeof left === 'number') throw new Error('The left side of a query comparison must be a field.');
  return leaf('FIELD_COMPARISON', { field:left.field, comparison:OPERATORS[fieldMatch[2]], value:operand(fieldMatch[3]) });
}

/** Compile the complete query or fail. No guessed clauses or reduced fallback. */
export function compileTextQuery(query: string): EngineExpression {
  const text = stripOuter(String(query ?? '').trim());
  if (!text) throw new Error('Text query is empty');
  for (const [word, operator] of [['OR', 'any'], ['AND', 'all']] as const) {
    const parts = splitOutside(text, word);
    if (parts.length > 1) {
      if (parts.some(part => !part)) throw new Error(`Unsupported query clause: ${text}`);
      return { type:'group', operator, children:parts.map(compileTextQuery) };
    }
  }
  return compileLeaf(text);
}
