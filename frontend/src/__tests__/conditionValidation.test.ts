import { expect, it } from 'vitest';
import { conditionValidationError, numericInputValue } from '../utils/conditionValidation';
const rule = (parameters: Record<string, unknown>, conditionId = 'MA_CONVERGENCE') => ({
  test: { instanceId:'test', conditionId, parameters },
});
it('preserves cleared numeric fields and validates zero-minimum inputs', () => {
  expect(numericInputValue('')).toBe('');
  expect(numericInputValue('0')).toBe(0);
  expect(conditionValidationError(rule({maxBarDifference:''}, 'DIVERGENCE'))).toContain('whole number');
  expect(conditionValidationError(rule({maxBarDifference:0}, 'DIVERGENCE'))).toBeNull();
  expect(conditionValidationError(rule({rightValue:Infinity}, 'INDICATOR_COMPARE'))).toContain('finite number');
});
it('validates session controls even when catalog step is omitted', () => {
  for (const [conditionId, parameter] of [
    ['mom_consecutive_up', 'minConsecutiveDays'], ['range_contraction', 'shortPeriod'],
    ['range_inside_bar', 'consecutive'], ['VCP_LEGS', 'minLegs'],
    ['PRICE_VS_EMA', 'period'],
  ]) {
    expect(conditionValidationError(rule({[parameter]:1.5}, conditionId))).toContain('whole number');
  }
});
it('rejects malformed and equivalent duplicate periods without substituting defaults', () => {
  for (const periods of ['9,20,9', '09,9', '9,foo', '9,20.5', '0,20', '9']) {
    expect(conditionValidationError(rule({periods}))).toContain('distinct positive integer');
  }
  expect(conditionValidationError(rule({periods:'9,20,50,200',withinDays:1}))).toBeNull();
});
it('rejects manually entered fractional session counts and offsets', () => {
  expect(conditionValidationError(rule({periods:'9,20',withinDays:1.5}))).toContain('whole number');
  expect(conditionValidationError(rule({leftOffset:0.5}, 'INDICATOR_COMPARE'))).toContain('whole number');
  expect(conditionValidationError(rule({periods:'9,20',withinDays:0}))).toContain('whole number');
});
