import type { ActiveCondition } from '../types/screener';

export interface BasePresetDefinition {
  id: string;
  setupFamily?: string;
  expression: {children: Array<{kind: string; params: Record<string, any>}>};
}

/** Materialize the whole frozen setup expression, shared by browser and Worker. */
export function materializeBasePreset(preset: BasePresetDefinition, p: Record<string, any>): ActiveCondition[] {
  const family = preset.setupFamily;
  const stage = family ? (p.setupStage === undefined ? 'FORMING' : p.setupStage) : preset.expression.children[0].params.stage;
  if (!['FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'].includes(stage)) throw new Error('Unsupported setup stage');
  let leaves: ActiveCondition[] = preset.expression.children.map((node, index) => {
    const parameters: Record<string, any> = {...node.params, stage};
    if (node.kind === 'BASE_METRIC') {
      if (p[`threshold${index}`] !== undefined) parameters.value = p[`threshold${index}`];
      if (family && stage !== 'FORMING') {
        if (parameters.metric.startsWith('current.')) parameters.metric = 'selection.' + parameters.metric.slice(8);
        if (parameters.metric === 'distanceFromPivotPct') parameters.metric = 'selection.distanceFromPivotPct';
      }
    }
    if (node.kind === 'BASE_STAGE' && p.holdingPolicy !== undefined) parameters.holdingPolicy = p.holdingPolicy;
    return {instanceId: String(index), conditionId: node.kind, parameters};
  });
  if (!family) return leaves;
  const number = (key: string, fallback: number, low: number, high: number, integer = false): number => {
    const value = p[key] === undefined ? fallback : p[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || integer && !Number.isInteger(value)) throw new Error('Invalid setup parameter: ' + key);
    return value;
  };
  const append = (metric: string, comparison: string, value: number) => leaves.push({instanceId: 'family-' + leaves.length, conditionId: 'BASE_METRIC', parameters: {stage, metric, comparison, value}});
  leaves=leaves.filter(leaf=>!(leaf.conditionId==='BASE_METRIC' && leaf.parameters.metric==='base.depthPct' && leaf.parameters.comparison==='BELOW'));
  const method=p.contractionMethod === undefined ? 'RAW_TR' : p.contractionMethod;
  const methods:Record<string,string>={RAW_TR:'base.trueRangeContraction',WILDER_ATR:'base.atrContraction',SIMPLE_ATR:'base.atrSimpleContraction'};
  if (!Object.hasOwn(methods,method)) throw new Error('Unsupported contraction method');
  if (family==='vcp') for (const leaf of leaves) if (Object.values(methods).includes(leaf.parameters.metric)) leaf.parameters.metric=methods[method];
  append('base.depthPct','BELOW',number('maxBaseDepth',['vcp','ipo'].includes(family) ? 35 : 95,1,95));
  const boolean=(key:string,fallback=false):boolean=>{const value=p[key]===undefined?fallback:p[key];if(typeof value!=='boolean')throw new Error(key+' must be boolean');return value;};
  const strict=boolean('strictContractionLegs');
  let legs = number('minContractionLegs',strict?2:0,0,10,true);
  if(strict&&legs===0)legs=2;
  const legRatio = number('maxContractionLegRatio',1,0,2);
  if(strict&&legRatio>1)throw new Error('Strict contraction ratio must not exceed one');
  if (legs === 1) throw new Error('Contraction ratio requires at least two legs');
  if (legs) { append('base.contractionLegCount','ABOVE',legs); append('base.contractionMaxRatio',strict?'LESS':'BELOW',legRatio); }
  const scope=stage==='FORMING'?'current':'selection';
  const prior=number('minPriorAdvancePct',0,0,1000);
  if(prior)append('base.priorAdvance63Pct','ABOVE',prior);
  if(boolean('requireAccumulation'))append('base.netUpDownVolume','GREATER',0);
  if(boolean('requireRising200'))append(scope+'.slopeSMA200','GREATER',0);
  for(const [key,path] of [['reclaim200Within','reclaimSMA200Age'],['slopeTurn200Within','slopeTurnSMA200Age']]){const days=number(key,0,0,252,true);if(days)append(scope+'.'+path,'LESS',days);}
  const persistence=number('above50Persistence',1,1,252,true);
  if(persistence>=1)append(scope+'.aboveSMA50Sessions','ABOVE',persistence);
  const confirm=boolean('requireBreakoutConfirmation');
  const volume=number('minBreakoutVolume',1.5,0,100),closeRange=number('minBreakoutCloseInRange',.7,0,1),extension=number('maxBreakoutExtensionPct',5,0,1000),age=number('maxBreakoutAge',5,0,1500,true);
  if(confirm){
    if(stage==='FORMING')throw new Error('Breakout confirmation requires a post-breakout stage');
    append('breakout.volumeRatio','ABOVE',volume);append('breakout.closeInRange','ABOVE',closeRange);append('breakout.throughPct','GREATER',0);
    if(stage==='FRESH_BREAKOUT'){append('breakoutAgeSessions','BELOW',age);append('distanceFromPivotPct','ABOVE',0);append('distanceFromPivotPct','BELOW',extension);}
  }
  const first = p.requireFirstBase === undefined ? family === 'ipo' : p.requireFirstBase;
  if (typeof first !== 'boolean') throw new Error('requireFirstBase must be boolean');
  leaves = leaves.filter(leaf => leaf.parameters.metric !== 'firstEligibleBase');
  if (first) append('firstEligibleBase','EQUAL',1);
  const ath = p.athPolicy === undefined ? 'INTRADAY_AVAILABLE' : p.athPolicy;
  if (!['CLOSING_AVAILABLE','INTRADAY_AVAILABLE','AUDITED_INTRADAY'].includes(ath)) throw new Error('Unsupported ATH policy');
  if (family === 'blue-sky' && ath !== 'CLOSING_AVAILABLE') {
    const scope = stage === 'FORMING' ? 'current' : 'selection';
    append(scope + '.historyCoverageComplete','EQUAL',1);
    append(scope + '.pivotVsHistoricalIntradayHigh','ABOVE',0);
    if (ath === 'AUDITED_INTRADAY') append(scope + '.lifetimePriceHistoryVerified','EQUAL',1);
  }
  return leaves;
}

/** Keep setup controls valid in the same user edit; engine validation remains strict. */
export function updateSetupParameter(parameters:Record<string,any>,key:string,value:any):Record<string,any>{
  const next={...parameters,[key]:key==='minContractionLegs'&&value===1?2:value};
  if(key==='requireBreakoutConfirmation'&&value===true&&(next.setupStage??'FORMING')==='FORMING')next.setupStage='FRESH_BREAKOUT';
  if(key==='setupStage'&&value==='FORMING')next.requireBreakoutConfirmation=false;
  return next;
}
