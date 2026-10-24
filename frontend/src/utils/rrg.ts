/**
 * Relative rotation maths, after JdK: RS-Ratio (the trend of an item's strength against a benchmark) and
 * RS-Momentum (the rate of change of that trend), both normalized around 100.
 *
 * JdK's exact formula is unpublished. This open approximation smooths relative strength (RS = price /
 * benchmark) with a fast and a slow EMA: RS-Ratio = 100 × fast / slow, so it sits above 100 while strength
 * is trending up. RS-Momentum = 100 × RS-Ratio / its own EMA, so it leads RS-Ratio and turns first. Tuned on
 * NSE sector indices for trails that rotate rather than zigzag.
 */

export type Quadrant = 'leading' | 'weakening' | 'lagging' | 'improving';
export const QUADRANTS: Quadrant[] = ['leading', 'weakening', 'lagging', 'improving'];
export const SMOOTHING = {fast: 5, slow: 26, momentum: 9} as const;
/** Periods before the first point: the slow average and then the momentum average must both settle. */
export const WARM_UP = SMOOTHING.slow + SMOOTHING.momentum;

export interface RotationPoint { x: number; y: number }

/** EMA that starts at the first finite value; NaN until `settle` observations have been seen. */
function ema(values: ArrayLike<number>, period: number, settle = period): Float64Array {
  const out = new Float64Array(values.length).fill(NaN);
  const alpha = 2 / (period + 1);
  let level = NaN, seen = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) { level = NaN; seen = 0; continue; }
    level = seen ? level + alpha * (value - level) : value;
    seen++;
    if (seen >= settle) out[i] = level;
  }
  return out;
}

/** RS-Ratio and RS-Momentum for each aligned period; NaN until enough history exists. */
export function rotation(prices: ArrayLike<number>, benchmark: ArrayLike<number>) {
  const strength = new Float64Array(prices.length);
  for (let i = 0; i < prices.length; i++) {
    strength[i] = prices[i] > 0 && benchmark[i] > 0 ? 100 * prices[i] / benchmark[i] : NaN;
  }
  const fast = ema(strength, SMOOTHING.fast, SMOOTHING.slow), slow = ema(strength, SMOOTHING.slow);
  const ratio = fast.map((value, i) => 100 * value / slow[i]);
  const trend = ema(ratio, SMOOTHING.momentum);
  const momentum = ratio.map((value, i) => 100 * value / trend[i]);
  return {ratio, momentum};
}

export const quadrantOf = ({x, y}: RotationPoint): Quadrant =>
  x >= 100 ? (y >= 100 ? 'leading' : 'weakening') : (y >= 100 ? 'improving' : 'lagging');

/** Direction of the last move, in degrees counter-clockwise from the positive RS-Ratio axis, and its length. */
export function heading(from: RotationPoint | undefined, to: RotationPoint): {angle: number; speed: number} | null {
  if (!from) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  return {angle: Math.atan2(dy, dx) * 180 / Math.PI, speed: Math.hypot(dx, dy)};
}

/**
 * Half-widths of each axis around 100 that hold 98% of points, so one outlier cannot squeeze the rest.
 * The axes scale independently: momentum swings in a narrower band than RS-Ratio.
 */
export function bounds(points: readonly RotationPoint[], minimum = 0.25): {x: number; y: number} {
  const reach = (values: number[]) => {
    const sorted = values.filter(Number.isFinite).map(value => Math.abs(value - 100)).sort((a, b) => a - b);
    return sorted.length ? Math.max(minimum, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] * 1.15) : minimum * 4;
  };
  return {x: reach(points.map(point => point.x)), y: reach(points.map(point => point.y))};
}

/** Fit the selected replay path without allowing unselected outliers to compress the overview. */
export function fitSelection(half: {x: number; y: number}, ratio: ArrayLike<number>, momentum: ArrayLike<number>, start: number, end: number) {
  const reach = {...half};
  for (let i = Math.max(0, start); i <= end; i++) {
    if (Number.isFinite(ratio[i])) reach.x = Math.max(reach.x, Math.abs(ratio[i] - 100) * 1.15);
    if (Number.isFinite(momentum[i])) reach.y = Math.max(reach.y, Math.abs(momentum[i] - 100) * 1.15);
  }
  return reach;
}

/** Point on the straight path between two observations, for smooth replay between periods. */
export const between = (from: RotationPoint, to: RotationPoint, t: number): RotationPoint =>
  ({x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t});
