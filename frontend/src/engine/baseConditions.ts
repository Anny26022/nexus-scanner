import metrics from '../data/baseMetrics.json';
import { compare, type Truth } from './expression';
import type { ActiveCondition } from '../types/screener';

export type BaseRecord = Record<string,unknown>;
export type SelectedBases = Partial<Record<'FORMING'|'FRESH_BREAKOUT'|'HOLDING'|'PLAYED_OUT',BaseRecord>>;
const stages = ['FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'];
const allowed = new Set<string>(metrics);
function metric(record: unknown,path:unknown): number|null {
  if(typeof path!=='string'||!allowed.has(path))throw new Error('Unsupported base metric');
  let value:unknown=record;
  for(const key of path.split('.'))value=value&&typeof value==='object'?(value as BaseRecord)[key]:undefined;
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}
export function evaluateBaseCondition(bases: SelectedBases|undefined,condition:ActiveCondition):Truth {
  const p=condition.parameters,stage=String(p.stage??'FORMING');
  if(!stages.includes(stage))throw new Error('Unsupported base stage');
  const record=bases?.[stage as keyof SelectedBases];
  if(condition.conditionId==='BASE_STAGE'){
    const policy=String(p.holdingPolicy??'ANY');
    if(!['ANY','STRICT','RETEST'].includes(policy))throw new Error('Unsupported holding policy');
    if(bases===undefined)return null;
    if(!record)return false;
    return policy==='STRICT'?record.continuousHolding===true&&record.holdsPivot===true:policy==='RETEST'?record.holdsPivot===true:true;
  }
  let value=metric(record,p.metric);
  if(condition.conditionId==='BASE_FORMULA'){
    const right=metric(record,p.rightMetric),operation=String(p.arithmetic??'DIVIDE');
    if(!['ADD','SUBTRACT','MULTIPLY','DIVIDE'].includes(operation))throw new Error('Unsupported base arithmetic');
    value=value===null||right===null||(operation==='DIVIDE'&&right===0)?null:
      operation==='ADD'?value+right:operation==='SUBTRACT'?value-right:operation==='MULTIPLY'?value*right:value/right;
  }else if(condition.conditionId!=='BASE_METRIC')throw new Error('Unsupported base condition');
  if(typeof p.value!=='number'||!Number.isFinite(p.value))throw new Error('Base comparison requires a finite number');
  if(!['GREATER','ABOVE','LESS','BELOW','EQUAL'].includes(String(p.comparison??'ABOVE')))throw new Error('Unsupported base comparison');
  return compare(value,p.comparison??'ABOVE',p.value);
}
