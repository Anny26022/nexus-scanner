import { describe, it, expect } from 'vitest';
import { explainCondition, explainExpressionTree } from '../utils/nqlParser';
import { ExpressionGroupNode, ActiveCondition } from '../types/screener';

describe('Nexus Query Language (NQL) & Expression Serialization', () => {
  it('should serialize trend_price_vs_ma condition into human-readable explanation', () => {
    const condition: ActiveCondition = {
      instanceId: 'c1',
      conditionId: 'trend_price_vs_ma',
      parameters: { maType: 'SMA', maPeriod: 50, operator: 'above', thresholdPct: 0 },
    };

    const res = explainCondition(condition);
    expect(res.explanation).toContain('Price is ABOVE SMA 50');
    expect(res.isAvailable).toBe(true);
  });

  it('should handle negated condition serialization', () => {
    const condition: ActiveCondition = {
      instanceId: 'c2',
      conditionId: 'mom_rvol',
      parameters: { minRvol: 2.0, maxRvol: 10.0 },
      isNegated: true,
    };

    const res = explainCondition(condition);
    expect(res.explanation).toContain('NOT (');
    expect(res.explanation).toContain('Relative Volume');
  });

  it('explains the production delivery condition', () => {
    const tree: ExpressionGroupNode = {
      type: 'group',
      operator: 'all',
      children: [
        {
          type: 'condition',
          condition: {
            instanceId: 'c3',
            conditionId: 'mom_delivery_vol',
            parameters: { minDeliveryPct: 50 },
          },
        },
      ],
    };

    for (const session of ['2023-11-15', '2026-10-02']) {
      const exp = explainExpressionTree(tree, session);
      expect(exp.compiledExplanations[0].isDataAvailableForSession).toBe(true);
      expect(exp.compiledExplanations[0].humanReadableText).toBe('NSE Delivery Volume is AT LEAST 50% of total volume');
      expect(exp.warnings).toEqual([]);
    }
  });
});
