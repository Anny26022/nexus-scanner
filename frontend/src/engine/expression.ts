export type Truth = true | false | null;

export interface EngineCondition {
  instanceId?: string;
  conditionId: string;
  parameters: Record<string, unknown>;
  isNegated?: boolean;
}

export type EngineExpression =
  | { type: 'condition'; condition: EngineCondition }
  | { type: 'group'; operator: 'all' | 'any'; children: EngineExpression[] };

export function and(values: Truth[]): Truth {
  return values.includes(false) ? false : values.includes(null) ? null : true;
}

export function or(values: Truth[]): Truth {
  return values.includes(true) ? true : values.includes(null) ? null : false;
}

export function negate(value: Truth): Truth {
  return value == null ? null : !value;
}

export function compare(value: unknown, operation: unknown, target: unknown): Truth {
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof target !== 'number' || !Number.isFinite(target)) return null;
  switch (String(operation).toUpperCase()) {
    case 'GREATER': case 'GREATER_THAN': return value > target;
    case 'ABOVE': case 'GREATER_OR_EQUAL': return value >= target;
    case 'LESS': case 'LESS_THAN': return value < target;
    case 'BELOW': case 'LESS_OR_EQUAL': return value <= target;
    case 'EQUAL': return value === target;
    default: throw new Error(`Unsupported comparison: ${String(operation)}`);
  }
}

export function evaluateExpression(
  expression: EngineExpression,
  resolve: (condition: EngineCondition) => Truth,
): Truth {
  if (expression.type === 'condition') {
    const value = resolve(expression.condition);
    return expression.condition.isNegated ? negate(value) : value;
  }
  const values = expression.children.map(child => evaluateExpression(child, resolve));
  return expression.operator === 'all' ? and(values) : or(values);
}

export function walkExpression(expression: EngineExpression): EngineCondition[] {
  return expression.type === 'condition'
    ? [expression.condition]
    : expression.children.flatMap(walkExpression);
}

export function expressionDepth(expression: EngineExpression): number {
  return expression.type === 'condition' ? 1 : 1 + Math.max(0, ...expression.children.map(expressionDepth));
}
