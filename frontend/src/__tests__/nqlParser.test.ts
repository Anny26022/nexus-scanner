import { describe, it, expect } from 'vitest';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
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

  it('does not guess availability from the calendar date', () => {
    const tree: ExpressionGroupNode = {
      type: 'group',
      operator: 'all',
      children: [
        {
          type: 'condition',
          condition: {
            instanceId: 'c3',
            conditionId: 'mom_delivery_pct',
            parameters: { minDeliveryPct: 50 },
          },
        },
      ],
    };

    // The legacy ID is no longer in the UI catalog. Register its definition
    // so this regression actually reaches the former calendar-date gate.
    const delivery = NEXUS_CONDITION_CATALOG.find(item => item.id === 'mom_delivery_vol')!;
    NEXUS_CONDITION_CATALOG.push({...delivery, id:'mom_delivery_pct'});
    try {
      for (const session of ['2023-11-15', '2026-10-02']) {
        const exp = explainExpressionTree(tree, session);
        expect(exp.compiledExplanations[0].isDataAvailableForSession).toBe(true);
        expect(exp.warnings).toEqual([]);
      }
    } finally {
      NEXUS_CONDITION_CATALOG.pop();
    }
  });
});
