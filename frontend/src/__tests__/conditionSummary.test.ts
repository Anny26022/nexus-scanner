import { expect, it } from 'vitest';
import { explainCondition } from '../utils/nqlParser';

it('summarises every filter in words, never as raw settings', () => {
  const text = (conditionId: string, parameters: Record<string, unknown>) => explainCondition({instanceId: conditionId, conditionId, parameters}).explanation;
  expect(text('GAP_UP', {minGapPct: 2, withinDays: 1})).toBe('Gap Up: min gap 2%, fired within 1');
  expect(text('UNFILLED_GAP', {direction: 'UP', minGapPct: 3, withinDays: 60, state: 'UNFILLED'})).toBe('Unfilled Gap: direction Up, min gap 3%, within 60 days, state Still open');
  expect(text('scan-top-gainers-1m', {})).toBe('Top 1M Gainers: 1M performance at least 25%');
  expect(text('lib-vcp', {})).toMatch(/^VCP Contraction: .+\. Eligibility: /);
  expect(text('VOLUME_VS_AVG', {avgDays: 20, multiple: 2, withinDays: 1})).not.toMatch(/[{}]|parameters/);
});
