import { ConditionDef, ConditionCategory } from '../types/screener';
import definitions from './presetDefinitions.json';
import recipes from './scanRecipes.json';

const categories: Record<string, ConditionCategory> = {
  'Top Gainers': 'momentum', 'Momentum & Leadership': 'momentum', Breakouts: 'trend',
  'Bases & Contraction': 'range', 'Pullbacks & Reclaims': 'trend',
  'Volume & Delivery': 'momentum', Gaps: 'momentum', Reversals: 'relative_strength',
  'Earnings & Value': 'fundamentals', 'Regime & Universe': 'liquidity',
};

export interface RecipeCondition { type: 'condition'; kind: string; params: Record<string, unknown> }
export interface RecipeGroup { type: 'group'; op: 'AND' | 'OR'; children: (RecipeGroup | RecipeCondition)[] }

/** One library scan, as the library shows it. */
export interface LibraryScan {
  id: string; name: string; category: string; horizon: string;
  description: string; rules: string[]; aka: string[];
  /** Recipes run in the browser from native filters; the rest are matched by the daily pipeline. */
  recipe?: RecipeGroup;
}

export const SCAN_CATEGORIES = ['Top Gainers', ...new Set(definitions.map(p => p.category))];

export const SCAN_LIBRARY: LibraryScan[] = [
  ...(recipes as unknown as (LibraryScan & {expression: RecipeGroup})[]).map(({expression, ...scan}) => ({...scan, recipe: expression})),
  ...definitions.map(p => ({id: p.id, name: p.name, category: p.category, horizon: p.horizon, description: p.description,
    rules: p.rules, aka: p.aka ?? []})),
];

/** Shown first in the library when nothing is searched. */
export const POPULAR_SCANS = ['scan-top-gainers-1m', 'scan-top-gainers-3m', 'scan-top-gainers-6m', 'scan-leaders-1m', 'scan-leaders-3m',
  'scan-leaders-6m', 'scan-near-52w-high', 'scan-near-high-breakout'];

/** Recipe-only condition: a cross-sectional rank on a published daily metric. Not offered as a filter. */
export const RANK_KIND = 'PERFORMANCE_RANK';

export const RECIPES: ReadonlyMap<string, RecipeGroup> = new Map(SCAN_LIBRARY.flatMap(scan => scan.recipe ? [[scan.id, scan.recipe]] : []));

/** Published daily metrics a recipe reads (the extended-metric `metric` ids), so the library knows what a snapshot lacks. */
export function recipeMetrics(id: string): string[] {
  const walk = (node: RecipeGroup | RecipeCondition): string[] => node.type === 'group' ? node.children.flatMap(walk)
    : (node.kind.startsWith('TV_') || node.kind === RANK_KIND) && typeof node.params.metric === 'string' ? [node.params.metric] : [];
  const recipe = RECIPES.get(id);
  return recipe ? walk(recipe) : [];
}
export const recipeUsesExtended = (id: string) => recipeMetrics(id).length > 0;
/** Ranked scans order their results by the metric they rank on. */
export function rankedMetric(id: string): string | null {
  const walk = (node: RecipeGroup | RecipeCondition): string | null => node.type === 'group'
    ? node.children.map(walk).find(Boolean) ?? null : node.kind === RANK_KIND ? String(node.params.metric) : null;
  const recipe = RECIPES.get(id);
  return recipe ? walk(recipe) : null;
}

export const PRESET_CATALOG: ConditionDef[] = SCAN_LIBRARY.map(p => ({
  id: p.id, label: p.name, category: categories[p.category] ?? 'trend',
  description: p.rules.join('; '), parameters: [],
}));
