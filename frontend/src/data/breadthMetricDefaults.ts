const PERCENT_METRICS = new Set([
  'pctAboveSma10', 'pctAboveSma20', 'pctAboveSma50', 'pctAboveSma200',
  'new_52w_high_pct', 'new_52w_low_pct',
]);
const RATIO_METRICS = new Set([
  'adRatioSma10', 'advance_decline_ratio_5d', 'advance_decline_ratio_10d',
  'volume_ratio_20', 'thrust_4_ratio', 'thrust_4_5_ratio',
]);

/** A useful starting threshold for each Market Breadth Gate scale. */
export function breadthMetricDefault(metric: unknown): number {
  const value = String(metric ?? '');
  if (PERCENT_METRICS.has(value)) return 50;
  if (RATIO_METRICS.has(value)) return 1;
  if (value === 'warning_day') return 1;
  if (value === 'mbi_score' || value === 'xp' || value === 'index_change_pct' || value === 'net_breadth') return 0;
  return 1;
}
