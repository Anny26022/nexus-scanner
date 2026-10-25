export type FilterChoices = Record<'SECTOR' | 'INDUSTRY' | 'SERIES' | 'PRICE_BAND' | 'INDEX_MEMBERSHIP', string[]> &
  Partial<Record<'THEME' | 'THEMATIC_BLOCK' | 'MACRO_PILLAR' | 'SUB_INDUSTRY' | 'LISTING_COHORT' | 'THEME_AGGREGATE', string[]>> &
  {TRADINGVIEW_METRIC?:string[]; ETF_FIELDS?:string[]; ETF_VALUES?:Record<string, string[]>; ETF_LABELS?:Record<string, Record<string, string>>};
