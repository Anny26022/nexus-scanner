export const CLASSIFICATION_LEVELS = ['sector', 'industry', 'subIndustry', 'theme', 'block', 'macro', 'cohort', 'aggregate'] as const;
export type ClassificationLevel = typeof CLASSIFICATION_LEVELS[number];
export type ThematicLevel = Exclude<ClassificationLevel, 'sector' | 'industry'>;
export const CLASSIFICATION_FILTERS = {
  THEME: 'theme', THEMATIC_BLOCK: 'block', MACRO_PILLAR: 'macro', SUB_INDUSTRY: 'subIndustry', LISTING_COHORT: 'cohort',
  THEME_AGGREGATE: 'aggregate',
} as const satisfies Record<string, ThematicLevel>;
export function isClassificationFilter(id: string): id is keyof typeof CLASSIFICATION_FILTERS {
  return Object.hasOwn(CLASSIFICATION_FILTERS, id);
}
export interface ClassificationRecord {
  theme?: string | null;
  subIndustry?: string | null;
  block?: string | null;
  macro?: string | null;
  memberships?: Record<string, string>;
  cohorts?: Record<string, string>;
  levels?: Record<ThematicLevel, string[]>;
  aliases?: string[];
  availability?: Record<ThematicLevel, boolean>;
}
export interface ClassificationNode {
  id: string;
  enabled?: boolean;
  kind: 'business' | 'exposure' | 'cohort' | 'alias' | 'aggregate';
  block: string | null;
  macro: string | null;
  targets: string[];
}
export interface ThemeClassification {
  schemaVersion: number;
  version: string;
  asOfDate: string;
  nodes?: Record<string, ClassificationNode>;
  records: Record<string, ClassificationRecord>;
}
export function joinCompanyClassification(primary: {sector?:string|null; industry?:string|null} | undefined,
  thematic: ClassificationRecord): ClassificationRecord & {sector:string|null; industry:string|null} {
  // Legacy thematic payloads contain an unrelated Tracker `industry` field.
  return {...thematic, sector:primary?.sector ?? null, industry:primary?.industry ?? null};
}
const missing = new Set(['', 'unclassified', 'other', 'others', 'n/a', 'none', 'null']);
export function classificationLabel(value: unknown): string | null {
  const label = typeof value === 'string' ? value.trim() : '';
  return missing.has(label.toLowerCase()) ? null : label;
}
export function classificationLabels(
  row: {sector?: string | null; industry?: string | null},
  record: ClassificationRecord | undefined,
  level: ClassificationLevel,
): string[] {
  const unique = (values: unknown[]) => [...new Set(values.map(classificationLabel).filter((v): v is string => v !== null))].sort();
  if (level === 'sector' || level === 'industry') return unique([row[level]]);
  if (record?.levels) return unique(record.levels[level] ?? []);
  // Older immutable releases expose scalar parents and the complete membership map.
  if (level === 'theme') return unique([record?.theme, ...Object.keys(record?.memberships ?? {})]).filter(name => name !== 'IPO / Young Bases');
  if (level === 'cohort') return unique([...Object.keys(record?.cohorts ?? {}),
    ...(record?.theme === 'IPO / Young Bases' || record?.memberships?.['IPO / Young Bases'] ? ['IPO / Young Bases'] : [])]);
  if (level === 'aggregate') return [];
  if ((level === 'block' || level === 'macro') && record?.theme === 'IPO / Young Bases') return [];
  return unique([record?.[level]]);
}

/** Reject partial or malformed joins; unavailable classification is not an unmapped company. */
export function validateClassification(data: ThemeClassification, totalStocks: number): void {
  const fail = () => { throw new Error('Invalid theme classification'); };
  if (!data.records || typeof data.records !== 'object' || Array.isArray(data.records)
      || Object.keys(data.records).length !== totalStocks) fail();
  for (const record of Object.values(data.records)) {
    if (!record || typeof record !== 'object') fail();
    if (data.schemaVersion === 2) {
      if (!data.nodes || !record.levels || !record.memberships || !record.cohorts
          || (record.theme && !Object.hasOwn(record.memberships, record.theme))) fail();
      for (const level of ['subIndustry', 'theme', 'block', 'macro', 'cohort', 'aggregate'] as const) {
        const values = record.levels![level];
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || classificationLabel(value) !== value)
            || new Set(values).size !== values.length) fail();
      }
      for (const name of Object.keys(record.memberships!)) {
        const node = data.nodes![name];
        if (!node || node.kind === 'alias' || node.kind === 'cohort' || !record.levels!.theme.includes(name)) fail();
      }
      for (const name of Object.keys(record.cohorts!)) if (data.nodes![name]?.kind !== 'cohort') fail();
    }
  }
}
