import {validateAiScreenResult} from '../../frontend/src/api/aiScreenerContract';
import type {AiFilterDefinition} from '../../frontend/src/api/aiFilterCatalog';

const object = (value:unknown): value is Record<string,unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deterministically normalize semantic nuances so LLM quirks don't alter user intent.
 * 1. Strip unrequested minPe: 0 if user only asked for an upper bound (P/E at most X).
 * 2. Map AVG_TURNOVER windowMinutes "Daily" to the daily enum value.
 * PRICE_VS_EMA is never remapped here: a persistence filter for a current-close request is rejected by the
 * compiler so the fallback model retries, instead of being silently rewritten (with an invented period).
 */
function normalizeRawClauses(rawClauses: unknown[]): unknown[] {
  return rawClauses.map(item => {
    if (!object(item) || typeof item.conditionId !== 'string') return item;
    const clause = { ...item };
    const params = object(clause.parameters) ? { ...clause.parameters } : {};
    const src = typeof clause.sourceText === 'string' ? clause.sourceText.toLowerCase() : '';

    // Fix unrequested lower bound on P/E: if user asked for P/E <= X or at most X, don't inject minPe: 0
    if (clause.conditionId === 'fund_pe_ratio' && !/\b(positive|profitable|greater|above|min|minimum|kam se kam)\b/i.test(src)) {
      if (params.minPe === 0 && typeof params.maxPe === 'number') {
        delete params.minPe;
        clause.conditionId = 'PE_RATIO';
        clause.parameters = { comparison: 'BELOW', value: params.maxPe, reportType: 'PREFER_CONSOLIDATED' };
      }
    }

    // Normalize AVG_TURNOVER: LLMs often emit windowMinutes: "Daily" instead of ""
    if (clause.conditionId === 'AVG_TURNOVER') {
      if (typeof params.windowMinutes === 'string' && params.windowMinutes.toLowerCase() === 'daily') {
        params.windowMinutes = '';
        clause.parameters = params;
      }
    }

    return clause;
  });
}

/** Presentation is deterministic; fixed settings are restored by the shared validator. */
export function materializeCompilerResult(raw:unknown, catalog:AiFilterDefinition[]) {
  if (!object(raw) || !Array.isArray(raw.clauses)) throw new Error('invalid_result');
  // sourceText is kept as the model quoted it, so the compiler's coverage check can detect omitted constraints.
  const clauses = normalizeRawClauses(raw.clauses);
  const normalizedRaw = { ...raw, clauses };
  // Titles, summaries, labels and condition maps are always generated locally.
  const result = validateAiScreenResult({...normalizedRaw, name:'Custom screen', summary:'Screen preview.'},catalog);
  const matched = Object.keys(result.conditionsMap).length;
  const unsupported = result.unsupportedClauses.length;
  const title = result.clauses.filter(clause => clause.status !== 'UNSUPPORTED')
    .map(clause => clause.label).slice(0,2).join(result.matchMode === 'all' ? ' + ' : ' OR ');
  result.name = title ? title.length > 117 ? `${title.slice(0,117)}…` : title : 'Request needs clarification';
  result.summary = `${matched} filter${matched === 1 ? '' : 's'} built. Match ${result.matchMode === 'all' ? 'all' : 'any'} conditions.`
    + (unsupported ? ` ${unsupported} part${unsupported === 1 ? '' : 's'} of the request need clarification.` : '');
  return result;
}
