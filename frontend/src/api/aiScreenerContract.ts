import type {ActiveCondition, MatchMode} from '../types/screener';
import {isAvailableCondition} from '../utils/filterAvailability';
import {explainCondition} from '../utils/nqlParser';
import {conditionValidationError, isIntegerParameter} from '../utils/conditionValidation';
import {createAiFilterCatalog, type AiFilterDefinition, type AiParameter} from './aiFilterCatalog';

export interface ClauseCompilation {
  sourceText: string;
  status: 'EXACT' | 'APPROXIMATE' | 'UNSUPPORTED';
  assumption?: string;
  conditionId?: string;
  parameters?: Record<string, unknown>;
  label: string;
  isNegated?: boolean;
}

export interface AiScreenResult {
  name: string;
  summary: string;
  matchMode: MatchMode;
  clauses: ClauseCompilation[];
  conditionsMap: Record<string, ActiveCondition>;
  unsupportedClauses: string[];
  catalogRevision?: string;
  compilation?: {model:string; attempts:number; cacheHit:boolean; inputTokens:number; outputTokens:number; cachedTokens?:number};
}

// Shared by the Worker and browser. The request cannot supply its own catalogue.
export const AI_FILTER_CATALOG = createAiFilterCatalog();
export const MAX_PROMPT_LENGTH = 2000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 1000): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function validParameter(spec: AiParameter, value: unknown): boolean {
  if (value === null) return spec.nullable === true;
  if (spec.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max)
      && (!isIntegerParameter(spec) || Number.isSafeInteger(value));
  }
  if (spec.type === 'boolean') return typeof value === 'boolean';
  if (spec.type === 'select') return Boolean(spec.options?.some(option => option.value === value));
  if (spec.type === 'multiselect') return Array.isArray(value) && value.length > 0 && value.length <= 50
    && new Set(value).size === value.length && value.every(item => spec.options?.some(option => option.value === item));
  if (spec.type === 'string') return text(value, 200);
  return false;
}

export function validateAiScreenResult(raw: unknown, catalog: AiFilterDefinition[] = AI_FILTER_CATALOG): AiScreenResult {
  if (!record(raw) || !text(raw.name, 120) || !text(raw.summary)
      || typeof raw.matchMode !== 'string' || !['all', 'any'].includes(raw.matchMode) || !Array.isArray(raw.clauses)
      || raw.clauses.length < 1 || raw.clauses.length > 16) {
    throw new Error('The AI returned an invalid screen. Please rephrase your request.');
  }
  const conditionsMap: Record<string, ActiveCondition> = {};
  const clauses: ClauseCompilation[] = raw.clauses.map((value, index) => {
    if (!record(value) || !text(value.sourceText) || typeof value.status !== 'string'
        || !['EXACT','APPROXIMATE','UNSUPPORTED'].includes(value.status)) {
      throw new Error('The AI returned an invalid clause. Please try again.');
    }
    const unsupported = (reason: string): ClauseCompilation => ({sourceText: value.sourceText as string,
      status: 'UNSUPPORTED', label: 'Needs a different filter', assumption: reason});
    if (value.status === 'UNSUPPORTED') return unsupported(text(value.assumption) ? value.assumption : 'No available filter matches this request.');
    const def = catalog.find(definition => definition.id === value.conditionId);
    if (!def || !record(value.parameters)) return unsupported('This filter is not available in the screener.');
    const parameters = {...value.parameters};
    // Unknown keys, missing variable thresholds and stringly-typed numbers are rejected below, never repaired:
    // a single published option is a constant, but any other default would be a threshold the user never asked for.
    for (const parameter of def.parameters) {
      if (!Object.hasOwn(parameters, parameter.id) && parameter.type === 'select' && parameter.options?.length === 1) {
        parameters[parameter.id] = parameter.options[0].value;
      }
      if (parameter.type === 'select' && Object.hasOwn(parameters, parameter.id)) {
        const val = parameters[parameter.id];
        // Case-only normalisation of string enums; never coerce types (e.g. "200" → 200) or map display labels.
        const matched = typeof val === 'string' ? parameter.options?.find(opt =>
          typeof opt.value === 'string' && opt.value.toLowerCase() === val.toLowerCase()
        ) : undefined;
        if (matched) {
          parameters[parameter.id] = matched.value;
        }
      }
      if (parameter.type === 'multiselect' && Object.hasOwn(parameters, parameter.id)) {
        if (typeof parameters[parameter.id] === 'string') {
          parameters[parameter.id] = [parameters[parameter.id]];
        }
      }
    }
    if (Object.keys(parameters).some(key => !def.parameters.some(parameter => parameter.id === key))
      || def.parameters.some(parameter => !Object.hasOwn(parameters, parameter.id) || !validParameter(parameter, parameters[parameter.id]))) {
      return unsupported('The proposed parameters are not supported by this filter.');
    }
    if (value.isNegated !== undefined && typeof value.isNegated !== 'boolean') return unsupported('Invalid negation.');
    const condition: ActiveCondition = {instanceId: `ai_${index}`, conditionId: def.id, parameters,
      ...(value.isNegated ? {isNegated:true} : {})};
    if (!isAvailableCondition(condition) || conditionValidationError({[condition.instanceId]:condition})) return unsupported('This combination of parameters is not available in the published screener.');
    for (const key of Object.keys(parameters).filter(key=>/^min[A-Z]/.test(key))) {
      const maxKey = key.replace(/^min/,'max');
      if (typeof parameters[key] === 'number' && typeof parameters[maxKey] === 'number'
          && parameters[key] > parameters[maxKey]) return unsupported('The lower bound must not exceed the upper bound.');
    }
    if (value.status === 'APPROXIMATE' && !text(value.assumption)) return unsupported('The proposed interpretation needs an explanation.');
    conditionsMap[condition.instanceId] = condition;
    const explanation = explainCondition(condition).explanation;
    const label = explanation.includes('evaluated with parameters:')
      ? `${def.label}: ${def.parameters.map(parameter => {
        const selected = parameters[parameter.id];
        const display = parameter.options?.find(option => option.value === selected)?.label ?? String(selected);
        return `${parameter.label} ${display}`;
      }).join(', ')}` : explanation;
    return {sourceText: value.sourceText, status: value.status as ClauseCompilation['status'], conditionId: def.id,
      parameters, label:value.isNegated ? `NOT (${label})` : label,
      ...(value.isNegated ? {isNegated:true} : {}),
      ...(text(value.assumption) ? {assumption: value.assumption} : {})};
  });
  return {name: raw.name, summary: raw.summary, matchMode: raw.matchMode as MatchMode, clauses, conditionsMap,
    unsupportedClauses: clauses.filter(clause => clause.status === 'UNSUPPORTED').map(clause => clause.sourceText)};
}
