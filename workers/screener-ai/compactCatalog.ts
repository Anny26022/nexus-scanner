import type {AiFilterDefinition} from '../../frontend/src/api/aiFilterCatalog';
import {isIntegerParameter} from '../../frontend/src/utils/conditionValidation';
import {isClassificationFilter} from '../../frontend/src/data/classification';

export interface CompactParameter {
  t: string;
  l: string;
  d: unknown;
  e?: unknown[];
  labels?: string[];
  min?: number;
  max?: number;
  step?: number;
  u?: string;
  nullable?: true;
  integer?: true;
  meaning?: string;
}

export type CompactParameterSet = Record<string,CompactParameter>;

/** Keep ordinary parameters beside their filters; share repeated complete sets. */
export function compactCatalog(catalog: AiFilterDefinition[], query?: string) {
  const q = query?.toLowerCase() ?? '';
  const parameterSets = catalog.map(def => Object.fromEntries(def.parameters.map(p => {
    let options = p.options;
    if (query && options && options.length > 8 && (isClassificationFilter(def.id) || ['INDUSTRY', 'SECTOR', 'INDEX_MEMBERSHIP'].includes(def.id))) {
      const matched = q ? options.filter(o => q.includes(String(o.value).toLowerCase())) : [];
      const fallback = options.slice(0, 6);
      options = Array.from(new Set([...matched, ...fallback]));
    }
    const spec: CompactParameter = {
      t: p.type,
      l: p.label,
      d: p.defaultValue,
      ...(options ? {e: options.map(option => option.value)} : {}),
      ...(options?.some(option => option.label !== String(option.value)) ? {labels: options.map(option => option.label)} : {}),
      ...(p.min !== undefined ? {min: p.min} : {}),
      ...(p.max !== undefined ? {max: p.max} : {}),
      ...(p.step !== undefined ? {step: p.step} : {}),
      ...(p.unit ? {u: p.unit} : {}),
      ...(p.nullable ? {nullable: true as const} : {}),
      ...(isIntegerParameter(p) ? {integer: true as const} : {}),
      ...(p.description ? {meaning: p.description} : {}),
    };
    return [p.id, spec];
  })));

  const counts = new Map<string,number>();
  for (const parameters of parameterSets) {
    const key = JSON.stringify(parameters);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared: CompactParameterSet[] = [], indexes = new Map<string,number>();
  const filters = catalog.map((def, index) => {
    const parameters = parameterSets[index], key = JSON.stringify(parameters);
    const desc = query && def.description.length > 80 ? def.description.split('. ')[0].slice(0, 80) : def.description;
    if ((counts.get(key) ?? 0) > 1 && key.length > 40) {
      let sharedIndex = indexes.get(key);
      if (sharedIndex === undefined) {
        sharedIndex = shared.length;
        shared.push(parameters);
        indexes.set(key, sharedIndex);
      }
      return [def.id, def.label, desc, {use: sharedIndex}] as const;
    }
    return [def.id, def.label, desc, parameters] as const;
  });
  return {shared, filters};
}
