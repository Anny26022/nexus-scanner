import {
  ExpressionNode,
  ActiveCondition,
  ExplainResponse,
} from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';

/**
 * Compiles a condition into a clear human-readable explanation string.
 */
export function explainCondition(condition: ActiveCondition): {
  explanation: string;
  conditionId: string;
  isAvailable: boolean;
  unavailableReason?: string;
} {
  const def = NEXUS_CONDITION_CATALOG.find((c) => c.id === condition.conditionId) ||
              PRESET_CATALOG.find((c) => c.id === condition.conditionId);
  
  if (!def) {
    return {
      explanation: `Unknown condition [${condition.conditionId}]`,
      conditionId: condition.conditionId,
      isAvailable: false,
      unavailableReason: 'Condition definition not found in catalog.',
    };
  }

  const p = condition.parameters;
  let explanation = '';

  switch (condition.conditionId) {
    case 'INDICATOR_COMPARE':
      explanation = `${p.leftIndicator}(${p.leftPeriod}) ${String(p.op).replaceAll('_', ' ')} ${p.rightIndicator ? `${p.rightIndicator}(${p.rightPeriod})` : p.rightValue}${p.withinDays > 1 ? ` within ${p.withinDays} sessions` : ''}`;
      break;
    case 'MA_CONVERGENCE':
      explanation = `${p.maType} ${p.periods} are within ${p.maxSpreadPct}% of close${p.withinDays > 1 ? ` within ${p.withinDays} sessions` : ''}`;
      break;
    case 'DIVERGENCE':
      explanation = `${p.variant} ${p.direction} price / ${p.oscillator}(${p.oscPeriod}) divergence, confirmed with ${p.pivotRight} right bars`;
      break;
    case 'SUPERTREND':
      explanation = `Supertrend(${p.period}, ${p.multiplier}) is ${p.direction}${p.signal === 'TURN' ? ` after turning within ${p.withinDays} sessions` : ''}`;
      break;
    case 'trend_price_vs_ma':
      explanation = `Price is ${p.operator === 'above' ? 'ABOVE' : p.operator === 'below' ? 'BELOW' : 'WITHIN % RANGE OF'} ${p.maType} ${p.maPeriod}${p.thresholdPct ? ` (threshold: ${p.thresholdPct}%)` : ''}`;
      break;
    case 'trend_ma_stack':
      explanation = `Moving Average Stack alignment is set to: ${p.stackOrder === '20_above_50_above_200' ? 'EMA 20 > EMA 50 > EMA 200 (Bullish)' : p.stackOrder}`;
      break;
    case 'trend_ma_slope':
      explanation = `20-Day slope of ${p.targetMa} SMA is AT LEAST +${p.minSlopePct}%`;
      break;
    case 'trend_persistent_momentum':
      explanation = `20 EMA above-run of at least ${p.minDaysAboveEMA} sessions; a contrary close resets only after a later trade breaks its low`;
      break;
    case 'trend_ema_reclaim':
      explanation = `Price reclaimed ${p.reclaimedEma} within the last ${p.reclaimedWithin} sessions`;
      break;
    case 'trend_days_above_ma':
      explanation = `At least ${p.minDaysPct}% of sessions in the past 50 days traded ABOVE 50 SMA`;
      break;
    case 'mom_price_change':
      explanation = `${p.period.toUpperCase()} Return is BETWEEN +${p.minChangePct}% and +${p.maxChangePct}%`;
      break;
    case 'mom_rvol':
      explanation = `Relative Volume (20-Day RVOL) is BETWEEN ${p.minRvol}x and ${p.maxRvol}x average volume`;
      break;
    case 'mom_consecutive_up_days':
      explanation = `Has closed HIGHER for AT LEAST ${p.minDays} consecutive sessions`;
      break;
    case 'mom_gap_up_down':
      explanation = `${p.gapType === 'gap_up' ? 'Gapped UP' : 'Gapped DOWN'} by AT LEAST ${p.minGapPct}% today`;
      break;
    case 'mom_delivery_pct':
      explanation = `NSE Delivery Volume is AT LEAST ${p.minDeliveryPct}% of total volume`;
      break;
    case 'range_52w_high_low':
      explanation = `${p.metric === 'dist_52w_high' ? `Within ${p.maxDistancePct}% of 52-Week High` : p.metric === 'new_52w_high' ? 'Made a NEW 52-Week High today' : p.metric}`;
      break;
    case 'range_contraction_nr7':
      explanation = `Pattern setup detected: ${p.pattern === 'nr7' ? 'NR7 (Narrowest Range in 7 Days)' : p.pattern === 'inside_bar' ? 'Inside Bar' : 'VCP Contraction Leg'}`;
      break;
    case 'INSIDE_BAR':
      explanation = `${p.timeframe === 'WEEKLY' ? `${p.weeklyMode === 'CURRENT' ? 'Current provisional' : 'Last completed'} weekly` : 'Daily'} inside bar${p.consecutive > 1 ? `, ${p.consecutive} consecutive` : ''}`;
      break;
    case 'range_atr_pct':
      explanation = `14-Day ATR Volatility % is BETWEEN ${p.minAtrPct}% and ${p.maxAtrPct}% of price`;
      break;
    case 'rs_rating_nexus':
      explanation = `Nexus Relative Strength (RS) Rating is AT LEAST ${p.minRsRating} (Top ${100 - p.minRsRating}% of market)`;
      break;
    case 'rs_new_high':
      explanation = `RS Line versus benchmark [${p.benchmarkIndex}] is making a NEW 52-Week High`;
      break;
    case 'fund_market_cap':
      explanation = `Market Capitalization is BETWEEN ₹${p.minMarketCap} Cr. and ₹${p.maxMarketCap} Cr.`;
      break;
    case 'fund_pe_ratio':
      explanation = `P/E Ratio is BETWEEN ${p.minPe} and ${p.maxPe}`;
      break;
    case 'fund_fno_status':
      explanation = `Securities universe restricted to: ${p.fnoFilter === 'fno_only' ? 'F&O Segment Equities' : p.fnoFilter === 'in_fno_ban' ? 'Equities under F&O Ban' : 'Non-F&O Segment Equities'}`;
      break;
    case 'liq_turnover':
      explanation = `20-Day Average Daily Turnover is AT LEAST ₹${p.minTurnoverCr} Cr.`;
      break;
    case 'liq_adr_pct':
      explanation = `20-Day Average Daily Range (ADR %) is AT LEAST ${p.minAdrPct}%`;
      break;
    default:
      if (condition.conditionId.startsWith('preset_') || condition.conditionId.startsWith('lib-')) {
        explanation = `Pre-built Scan: ${def.label} (${def.description})`;
      } else {
        explanation = `${def.label} evaluated with parameters: ${JSON.stringify(p)}`;
      }
  }

  if (condition.isNegated) {
    explanation = `NOT (${explanation})`;
  }

  return {
    explanation,
    conditionId: condition.conditionId,
    isAvailable: true,
  };
}

/**
 * Validates an expression tree and returns structured explanation output.
 */
export function explainExpressionTree(
  node: ExpressionNode,
  _asOfDate: string
): ExplainResponse {
  const explanations: Array<{
    conditionId: string;
    humanReadableText: string;
    isDataAvailableForSession: boolean;
    unavailableReason?: string;
  }> = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  function traverse(n: ExpressionNode) {
    if (n.type === 'condition') {
      const res = explainCondition(n.condition);
      
      explanations.push({
        conditionId: n.condition.conditionId,
        humanReadableText: res.explanation,
        isDataAvailableForSession: res.isAvailable,
        unavailableReason: res.unavailableReason,
      });
    } else if (n.type === 'group') {
      if (!n.children || n.children.length === 0) {
        errors.push('Expression group contains no active conditions.');
      } else {
        n.children.forEach(traverse);
      }
    }
  }

  traverse(node);

  return {
    isValid: errors.length === 0,
    errors,
    compiledExplanations: explanations,
    warnings,
  };
}
