// @vitest-environment node
import { describe,it,expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import metrics from '../data/baseMetrics.json';
import { evaluateBaseCondition,type SelectedBases } from './baseConditions';
import { evaluateHistoryCondition,type CandleSeries } from './historyEngine';
import { expressionPlan } from '../api/capabilityRegistry';
import type { SnapshotStock } from '../api/snapshotScreen';
import { compileTextQuery } from './queryCompiler';
const condition=(id:string,parameters:Record<string,unknown>)=>({instanceId:'test',conditionId:id,parameters});
describe('base Python/browser/advanced parity',()=>{
  it('compiles base queries identically in Python and TypeScript and rejects invalid clauses',()=>{
    const queries=['Base Stage(FORMING)','Base Stage(HOLDING, STRICT)',
      'Base Metric(FORMING, base.depthPct) < 25',
      'Base Metric(FRESH_BREAKOUT, breakoutAgeSessions) <= 5',
      'Base Formula(FORMING, base.parts.half_2.volume, DIVIDE, base.parts.half_1.volume) <= 0.8'];
    const invalid=['Base Stage(UNKNOWN)','Base Stage(FORMING) > 1','Base Stage(HOLDING, UNKNOWN)',
      'Base Metric(FORMING, imaginary) > 1','Base Metric(FORMING, base.depthPct)',
      'Base Formula(FORMING, base.depthPct, MOD, pivot) > 1'];
    const source=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
    const script="import json,sys;from edl_pipeline.scanner.query import compile_query;q=json.load(sys.stdin);out=[]\nfor text in q:\n try: out.append(compile_query(text))\n except ValueError: out.append(None)\nprint(json.dumps(out))";
    const run=spawnSync('python3',['-c',script],{env:{...process.env,PYTHONPATH:`${source}/DO NOT DELETE EDL PIPELINE/src`},input:JSON.stringify([...queries,...invalid]),encoding:'utf8'});
    expect(run.status,run.stderr).toBe(0);
    const compiled=JSON.parse(run.stdout);
    queries.forEach((query,index)=>{
      const leaf=compileTextQuery(query);
      expect(leaf).toMatchObject({type:'condition',condition:{conditionId:compiled[index].kind,parameters:compiled[index].params}});
    });
    invalid.forEach((query,index)=>{expect(()=>compileTextQuery(query)).toThrow();expect(compiled[queries.length+index]).toBeNull();});
    expect(compileTextQuery(`${queries[0]} AND (${queries[2]} OR ${queries[3]})`)).toMatchObject({type:'group',operator:'all',children:[{type:'condition'},{type:'group',operator:'any'}]});
  });
  it('keeps expanded trend context private without dropping its condition',()=>{
    const leaf=condition('BASE_METRIC',{stage:'FORMING',metric:'current.distanceEMA150',comparison:'ABOVE',value:0});
    const local=condition('BASE_METRIC',{stage:'FORMING',metric:'current.distanceSMA200',comparison:'ABOVE',value:0});
    expect(expressionPlan({type:'condition',condition:leaf}).browser).toBe(false);
    expect(expressionPlan({type:'condition',condition:local}).browser).toBe(true);
  });

  it('matches Python for every exposed metric, comparison boundary and arithmetic operation',()=>{
    const record:Record<string,any>={continuousHolding:false,holdsPivot:true,id:'selected'};
    metrics.forEach((path,index)=>{const keys=path.split('.');let target=record;keys.slice(0,-1).forEach(key=>{target[key]??={};target=target[key];});target[keys.at(-1)!]=index+1;});
    const cases=metrics.flatMap((metric,index)=>['GREATER','ABOVE','LESS','BELOW','EQUAL'].map(comparison=>({bases:{HOLDING:record} as SelectedBases,condition:condition('BASE_METRIC',{stage:'HOLDING',metric,comparison,value:index+1})})));
    for(const arithmetic of ['ADD','SUBTRACT','MULTIPLY','DIVIDE'])cases.push({bases:{HOLDING:record},condition:condition('BASE_FORMULA',{stage:'HOLDING',metric:'base.parts.half_2.volume',rightMetric:'base.parts.half_1.volume',arithmetic,comparison:'ABOVE',value:1})});
    const source=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
    const script="import json,sys;from edl_pipeline.scanner.base_conditions import evaluate_base_condition;c=json.load(sys.stdin);print(json.dumps([evaluate_base_condition(x['bases'],x['condition']['conditionId'],x['condition']['parameters']) for x in c]))";
    const run=spawnSync('python3',['-c',script],{env:{...process.env,PYTHONPATH:`${source}/DO NOT DELETE EDL PIPELINE/src`},input:JSON.stringify(cases),encoding:'utf8',maxBuffer:5*1024*1024});
    expect(run.status,run.stderr).toBe(0);
    expect(cases.map(item=>evaluateBaseCondition(item.bases,item.condition))).toEqual(JSON.parse(run.stdout));
  });
  it('routes slice formulas intact to advanced and selects detail by stable base ID',()=>{
    const leaf=condition('BASE_FORMULA',{stage:'FORMING',metric:'base.parts.half_2.volume',rightMetric:'base.parts.half_1.volume',arithmetic:'DIVIDE',comparison:'BELOW',value:.8});
    expect(expressionPlan({type:'condition',condition:leaf}).browser).toBe(false);
    const series:CandleSeries={dates:new Int32Array(),open:new Float64Array(),high:new Float64Array(),low:new Float64Array(),close:new Float64Array(),volume:new Float64Array()};
    const stock={historyAligned:true,asOfDate:'2026-10-01',bases:{FORMING:{id:'chosen',base:{}}}} as unknown as SnapshotStock;
    expect(evaluateHistoryCondition(series,leaf,{stock,session:'2026-10-01',bases:[{id:'other',base:{parts:{half_1:{volume:100},half_2:{volume:200}}}},{id:'chosen',base:{parts:{half_1:{volume:100},half_2:{volume:50}}}}]})).toBe(true);
  });
});
