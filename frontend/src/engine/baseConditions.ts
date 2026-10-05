import metrics from '../data/baseMetrics.json';
import publicContextKeys from '../data/baseContextKeys.json';
import { compare, type Truth, type EngineCondition } from './expression';
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

export function detailedSelectedBases(selected:SelectedBases|undefined,episodes:BaseRecord[]|undefined):SelectedBases|undefined {
  if(!episodes)return selected;
  const result:SelectedBases={};
  for(const stage of stages){
    const summary=selected?.[stage as keyof SelectedBases];
    if(!summary)continue;
    const episode=episodes.find(record=>record.id===summary.id);
    result[stage as keyof SelectedBases]=episode?{...summary,base:episode.base,current:episode.current??summary.current,selection:episode.selection??summary.selection}:summary;
  }
  return result;
}

/** Restore compact table explanations without retaining private slice/context detail. */
export function publicSelectedBases(selected:SelectedBases|undefined):SelectedBases|undefined {
  if(!selected)return selected;
  const context=(value:unknown)=>value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).filter(([key])=>publicContextKeys.includes(key))):value;
  return Object.fromEntries(Object.entries(selected).map(([stage,record])=>[stage,{...record,
    base:record.base&&typeof record.base==='object'?Object.fromEntries(Object.entries(record.base).filter(([key])=>key!=='parts')):record.base,
    current:context(record.current),selection:context(record.selection)}]));
}

export function baseStageForCondition(condition:EngineCondition):keyof SelectedBases|undefined {
  if(['BASE_STAGE','BASE_METRIC','BASE_FORMULA'].includes(condition.conditionId)){
    const stage=String(condition.parameters.stage??'FORMING');
    return stages.includes(stage)?stage as keyof SelectedBases:undefined;
  }
  if(condition.conditionId==='lib-nexus-fresh-breakouts')return 'FRESH_BREAKOUT';
  if(condition.conditionId==='lib-nexus-holding-breakouts')return 'HOLDING';
  if(['lib-nexus-strong-bases','lib-nexus-vcp-base','lib-nexus-blue-sky','lib-nexus-multi-year-base','lib-nexus-ipo-base'].includes(condition.conditionId))return 'FORMING';
  return undefined;
}
