import {validateAiScreenResult} from '../../frontend/src/api/aiScreenerContract';
import type {AiFilterDefinition} from '../../frontend/src/api/aiFilterCatalog';

const object = (value:unknown): value is Record<string,unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Presentation is deterministic; fixed settings are restored by the shared validator. */
export function materializeCompilerResult(raw:unknown, catalog:AiFilterDefinition[]) {
  if (!object(raw) || !Array.isArray(raw.clauses)) throw new Error('invalid_result');
  // Titles, summaries, labels and condition maps are always generated locally.
  const result = validateAiScreenResult({...raw, name:'Custom screen', summary:'Screen preview.'},catalog);
  const matched = Object.keys(result.conditionsMap).length;
  const unsupported = result.unsupportedClauses.length;
  const title = result.clauses.filter(clause => clause.status !== 'UNSUPPORTED')
    .map(clause => clause.label).slice(0,2).join(result.matchMode === 'all' ? ' + ' : ' OR ');
  result.name = title ? title.length > 117 ? `${title.slice(0,117)}…` : title : 'Request needs clarification';
  result.summary = `${matched} filter${matched === 1 ? '' : 's'} built. Match ${result.matchMode === 'all' ? 'all' : 'any'} conditions.`
    + (unsupported ? ` ${unsupported} part${unsupported === 1 ? '' : 's'} of the request need clarification.` : '');
  return result;
}
