import type {AiFilterDefinition} from '../../frontend/src/api/aiFilterCatalog';
import {isIntegerParameter} from '../../frontend/src/utils/conditionValidation';

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
export function compactCatalog(catalog: AiFilterDefinition[]) {
  const parameterSets = catalog.map(def => Object.fromEntries(def.parameters.map(p => {
      const spec: CompactParameter = {t:p.type, l:p.label, d:p.defaultValue,
        ...(p.options ? {e:p.options.map(option => option.value)} : {}),
        ...(p.options?.some(option=>option.label !== String(option.value)) ? {labels:p.options.map(option=>option.label)} : {}),
        ...(p.min !== undefined ? {min:p.min} : {}), ...(p.max !== undefined ? {max:p.max} : {}),
        ...(p.step !== undefined ? {step:p.step} : {}), ...(p.unit ? {u:p.unit} : {}),
        ...(p.nullable ? {nullable:true as const} : {}), ...(isIntegerParameter(p) ? {integer:true as const} : {}),
        ...(p.description ? {meaning:p.description} : {})};
      return [p.id,spec];
    })));
  const counts = new Map<string,number>();
  for (const parameters of parameterSets) {
    const key=JSON.stringify(parameters);counts.set(key,(counts.get(key) ?? 0)+1);
  }
  const shared:CompactParameterSet[] = [], indexes = new Map<string,number>();
  const filters = catalog.map((def,index) => {
    const parameters=parameterSets[index], key=JSON.stringify(parameters);
    if ((counts.get(key) ?? 0)>1 && key.length>100) {
      let sharedIndex=indexes.get(key);
      if(sharedIndex === undefined) {sharedIndex=shared.length;shared.push(parameters);indexes.set(key,sharedIndex);}
      return [def.id,def.label,def.description,{use:sharedIndex}] as const;
    }
    return [def.id,def.label,def.description,parameters] as const;
  });
  return {shared, filters};
}
