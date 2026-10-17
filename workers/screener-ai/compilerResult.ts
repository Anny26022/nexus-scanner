import {validateAiScreenResult} from '../../frontend/src/api/aiScreenerContract';
import type {AiFilterDefinition} from '../../frontend/src/api/aiFilterCatalog';

const object = (value:unknown): value is Record<string,unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deterministically normalize semantic nuances so LLM quirks don't alter user intent.
 * 1. Remap PRICE_VS_EMA to PRICE_VS_MAS if query expresses simple current price/close above/below without persistence phrasing.
 * 2. Strip unrequested minPe: 0 if user only asked for an upper bound (P/E at most X).
 */
function normalizeRawClauses(rawClauses: unknown[]): unknown[] {
  return rawClauses.map(item => {
    if (!object(item) || typeof item.conditionId !== 'string') return item;
    const clause = { ...item };
    const params = object(clause.parameters) ? { ...clause.parameters } : {};
    const src = typeof clause.sourceText === 'string' ? clause.sourceText.toLowerCase() : '';

    // Remap PRICE_VS_EMA -> PRICE_VS_MAS if no consecutive/persistent days were requested
    if (clause.conditionId === 'PRICE_VS_EMA' && !/\b(consecutive|days|sessions|persist|lag)\b/i.test(src)) {
      const period = typeof params.period === 'number' ? params.period : 50;
      const comp = params.comparison === 'BELOW' ? 'BELOW' : 'ABOVE';
      clause.conditionId = 'PRICE_VS_MAS';
      clause.parameters = { rules: [`${comp}_EMA_${period}`] };
    }

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
export function materializeCompilerResult(raw:unknown, catalog:AiFilterDefinition[], query?:string) {
  if (!object(raw) || !Array.isArray(raw.clauses)) throw new Error('invalid_result');
  let clauses = normalizeRawClauses(raw.clauses);
  if (query && clauses.length === 1 && object(clauses[0]) && clauses[0].status !== 'UNSUPPORTED') {
    clauses = [{ ...clauses[0], sourceText: query.trim() }];
  }
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
