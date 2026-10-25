import data from './narratives.json';

/** core: the narrative is the main business; exposure: a stated, material share of revenue or orders. */
export type NarrativeRole = 'core' | 'exposure';
export interface NarrativeMember { role: NarrativeRole; source: string; evidence: string }
export interface Narrative { id: string; name: string; thesis: string; members: Record<string, NarrativeMember> }
export interface NarrativeTag { id: string; name: string; role: NarrativeRole }

/** Hand-curated cross-industry narratives, kept apart from themes, industries and cohorts. */
export const NARRATIVES: readonly Narrative[] = (data as unknown as {narratives: Narrative[]}).narratives;
export const NARRATIVE_NAMES = NARRATIVES.map(narrative => narrative.name);

const bySymbol = new Map<string, NarrativeTag[]>();
for (const narrative of NARRATIVES) for (const [symbol, member] of Object.entries(narrative.members)) {
  bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), {id: narrative.id, name: narrative.name, role: member.role}]);
}
// Core memberships first, so a stock's main story leads wherever only one fits.
for (const tags of bySymbol.values()) tags.sort((a, b) => Number(a.role !== 'core') - Number(b.role !== 'core') || a.name.localeCompare(b.name));

export const narrativesOf = (symbol: string): readonly NarrativeTag[] => bySymbol.get(symbol) ?? [];
