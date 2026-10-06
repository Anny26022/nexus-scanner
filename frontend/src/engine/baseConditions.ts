import metrics from '../data/baseMetrics.json';
import publicBaseKeys from '../data/basePublicKeys.json';
import publicContextKeys from '../data/baseContextKeys.json';
import { materializeBasePreset, type BasePresetDefinition } from './basePresets';
import { and, or, compare, type Truth, type EngineCondition } from './expression';
import type { ActiveCondition } from '../types/screener';

export type BaseRecord = Record<string,unknown>;
export type SelectedBases = Partial<Record<'FORMING'|'FRESH_BREAKOUT'|'HOLDING'|'PLAYED_OUT',BaseRecord>>;
const stages = ['FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'];
const allowed = new Set<string>(metrics);
function metric(record: unknown,path:unknown): number|null {
  if(typeof path!=='string'||!allowed.has(path))throw new Error('Unsupported base metric');
  let value:unknown=record;
  for(const key of path.split('.'))value=value&&typeof value==='object'?(value as BaseRecord)[key]:undefined;
  if(['breakoutFailed','exitSignaled','tradeClosed'].includes(path)&&typeof value==='boolean')return Number(value);
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}
/** Parse bounded arithmetic without eval; validate every metric even if missing. */
export function evaluateBaseFormula(record:unknown,source:unknown):number|null {
  if(typeof source!=='string'||!source.trim()||source.length>2048)throw new Error('Base formula requires 1-2048 characters');
  const input=source.trim(),tokens:string[]=[];let position=0,cursor=0;
  while(position<input.length){
    const match=/^\s*(\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9_.]*|[()+*/-])/.exec(input.slice(position));
    if(!match)throw new Error('Invalid base formula token');
    tokens.push(match[1]);position+=match[0].length;
  }
  if(tokens.length>64)throw new Error('Base formula exceeds 64 tokens');
  const priorities:Record<string,number>={'+':1,'-':1,'*':2,'/':2};
  const expression=(depth=0,minimum=0):number|null=>{
    if(depth>8||cursor>=tokens.length)throw new Error('Invalid base formula depth or operand');
    const token=tokens[cursor++];let left:number|null;
    if(token==='+'||token==='-'){left=expression(depth+1,3);if(left!==null&&token==='-')left=-left;}
    else if(token==='('){left=expression(depth+1);if(tokens[cursor++]!==')')throw new Error('Unclosed base formula parenthesis');}
    else if(/^\d/.test(token)){left=Number(token);if(!Number.isFinite(left))throw new Error('Nonfinite base formula constant');}
    else if(/^[A-Za-z]/.test(token))left=metric(record,token);
    else throw new Error('Invalid base formula operand');
    while(cursor<tokens.length&&(priorities[tokens[cursor]]??0)>minimum){
      const op=tokens[cursor++],right=expression(depth+1,priorities[op]);
      left=left===null||right===null||(op==='/'&&right===0)?null:op==='+'?left+right:op==='-'?left-right:op==='*'?left*right:left/right;
      if(left!==null&&!Number.isFinite(left))left=null;
    }
    return left;
  };
  const value=expression();if(cursor!==tokens.length)throw new Error('Unexpected base formula token');return value;
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
  let value=condition.conditionId==='BASE_FORMULA'&&p.formula?evaluateBaseFormula(record,p.formula):metric(record,p.metric);
  if(condition.conditionId==='BASE_FORMULA'&&!p.formula){
    const right=metric(record,p.rightMetric),operation=String(p.arithmetic??'DIVIDE');
    if(!['ADD','SUBTRACT','MULTIPLY','DIVIDE'].includes(operation))throw new Error('Unsupported base arithmetic');
    value=value===null||right===null||(operation==='DIVIDE'&&right===0)?null:
      operation==='ADD'?value+right:operation==='SUBTRACT'?value-right:operation==='MULTIPLY'?value*right:value/right;
    if(value!==null&&!Number.isFinite(value))value=null;
  }else if(!['BASE_METRIC','BASE_FORMULA'].includes(condition.conditionId))throw new Error('Unsupported base condition');
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
    base:record.base&&typeof record.base==='object'?Object.fromEntries(Object.entries(record.base).filter(([key])=>publicBaseKeys.includes(key))):record.base,
    current:context(record.current),selection:context(record.selection)}]));
}

export function baseStageForCondition(condition:EngineCondition):keyof SelectedBases|undefined {
  if(['BASE_STAGE','BASE_METRIC','BASE_FORMULA'].includes(condition.conditionId)){
    const stage=String(condition.parameters.stage??'FORMING');
    return stages.includes(stage)?stage as keyof SelectedBases:undefined;
  }
  if(['lib-nexus-vcp-setup','lib-nexus-blue-sky-setup','lib-nexus-multi-year-setup','lib-nexus-ipo-setup'].includes(condition.conditionId)) { const stage=String(condition.parameters.setupStage??'FORMING'); return stages.includes(stage)?stage as keyof SelectedBases:undefined; }
  if(condition.conditionId==='lib-nexus-fresh-breakouts')return 'FRESH_BREAKOUT';
  if(condition.conditionId==='lib-nexus-holding-breakouts')return 'HOLDING';
  if(['lib-nexus-strong-bases','lib-nexus-vcp-base','lib-nexus-blue-sky','lib-nexus-multi-year-base','lib-nexus-ipo-base'].includes(condition.conditionId))return 'FORMING';
  return undefined;
}


/** Existential family qualification; all clauses bind to the same candidate. */
export function selectSetupEpisode(episodes:BaseRecord[]|undefined,preset:BasePresetDefinition,p:Record<string,unknown>,completedHistoryComplete=true):{value:Truth;record?:BaseRecord}{
  const leaves=materializeBasePreset(preset,p),stage=String(leaves[0].parameters.stage);
  const basis=preset.setupFamily==='blue-sky'&&(p.athPolicy??'INTRADAY_AVAILABLE')!=='CLOSING_AVAILABLE'?'HIGH':'CLOSE';
  if(episodes===undefined)return {value:null};
  // The latest-session pack deliberately retains only a bounded completed
  // witness set.  Never evaluate an outcome screen against that partial set.
  if(stage==='PLAYED_OUT'&&!completedHistoryComplete)return {value:null};
  const familyRecords=episodes.filter(record=>record.setupCandidateOnly===true),source=familyRecords.length?familyRecords:episodes;
  const evaluated=source.filter(record=>(record.pivotBasis??'CLOSE')===basis&&record.stage===stage).map(record=>({record,value:and(leaves.map(leaf=>evaluateBaseCondition({[stage]:record},leaf)))}));
  const matches=evaluated.filter(item=>item.value===true).sort((a,b)=>{
    const key=(record:BaseRecord)=>String((record.breakout as BaseRecord|undefined)?.date??(record.base as BaseRecord).startDate);
    return key(a.record)<key(b.record)?1:key(a.record)>key(b.record)?-1:String(a.record.id)<String(b.record.id)?1:String(a.record.id)>String(b.record.id)?-1:0;
  });
  return {value:or(evaluated.map(item=>item.value)),record:matches[0]?.record};
}

export function publicSetupMatch(record:BaseRecord):BaseRecord {
  const stage=String(record.stage) as keyof SelectedBases;
  const result=publicSelectedBases({[stage]:record})![stage]!;
  const {config:_config,...publicRecord}=result;
  return publicRecord;
}
