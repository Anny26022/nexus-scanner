import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import definitions from '../data/presetDefinitions.json';
import {selectSetupEpisode,type BaseRecord} from './baseConditions';
import {materializeBasePreset} from './basePresets';
import {evaluateHistoryCondition,type AdvancedContext,type CandleSeries} from './historyEngine';
import {evaluateExpression} from './expression';
import type {SnapshotStock} from '../api/snapshotScreen';
const ipo=definitions.find(p=>p.id==='lib-nexus-ipo-setup')!;
const candidate=(id:string,startDate:string,firstEligibleBase=1):BaseRecord=>({id,stage:'FORMING',pivotBasis:'CLOSE',setupCandidateOnly:true,firstEligibleBase,pivot:100,distanceFromPivotPct:-2,config:{min_sessions:15},base:{startDate,ageSessions:60,depthPct:20},current:{listingAgeSessionWeeks:20,distanceSMA50:2,marketCapCr:500,medianTurnover20:2}});

describe('correlated setup selection',()=>{
  it('does not hide a first IPO base behind a later candidate',()=>{
    const first=candidate('first','2025-01-01'),later=candidate('later','2025-03-01',0);
    expect(selectSetupEpisode([later,first],ipo,{}).record?.id).toBe('first');
    expect(selectSetupEpisode([first,later],ipo,{requireFirstBase:false}).record?.id).toBe('later');
  });
  it('matches Python truth values and witness identities, including unknowns',()=>{
    const rich=candidate('rich','2025-01-01'),liquid=candidate('liquid','2025-02-01');
    (rich.current as BaseRecord).medianTurnover20=.1;(liquid.current as BaseRecord).marketCapCr=100;
    const unknown=candidate('unknown','2025-01-01');(unknown.current as BaseRecord).medianTurnover20=null;
    const requests=[{episodes:[candidate('first','2025-01-01'),candidate('later','2025-02-01',0)],parameters:{}},{episodes:[rich,liquid],parameters:{}},{episodes:[unknown],parameters:{}},{episodes:[],parameters:{}},{episodes:null,parameters:{}}];
    const root=path.resolve(process.cwd(),'..');
    const script="import sys,json;sys.path.insert(0,'DO NOT DELETE EDL PIPELINE/src');from edl_pipeline.scanner.base_conditions import select_setup_episode;from edl_pipeline.scanner.presets import get_preset;requests=json.load(sys.stdin);results=[select_setup_episode(r['episodes'],get_preset('lib-nexus-ipo-setup'),r['parameters']) for r in requests];print(json.dumps([{'value':value,'id':record['id'] if record else None} for value,record in results]))";
    const expected=JSON.parse(execFileSync('python3',['-c',script],{cwd:root,input:JSON.stringify(requests),encoding:'utf8'}));
    requests.forEach((request,i)=>{const result=selectSetupEpisode(request.episodes??undefined,ipo,request.parameters);expect({value:result.value,id:result.record?.id??null}).toEqual(expected[i]);});
  });
  it('ports every optional policy identically and rejects invalid strict rules',()=>{
    const parameters={setupStage:'FRESH_BREAKOUT',requireBreakoutConfirmation:true,strictContractionLegs:true,minContractionLegs:0,requireAccumulation:true,minPriorAdvancePct:20,requireRising200:true,reclaim200Within:5,slopeTurn200Within:10,above50Persistence:3};
    const root=path.resolve(process.cwd(),'..');
    const script="import sys,json;sys.path.insert(0,'DO NOT DELETE EDL PIPELINE/src');from edl_pipeline.scanner.base_presets import materialize_base_preset;from edl_pipeline.scanner.presets import get_preset;print(json.dumps(materialize_base_preset(get_preset('lib-nexus-vcp-setup'),json.load(sys.stdin))['children']))";
    const expected=JSON.parse(execFileSync('python3',['-c',script],{cwd:root,input:JSON.stringify(parameters),encoding:'utf8'}));
    expect(materializeBasePreset(definitions.find(p=>p.id==='lib-nexus-vcp-setup')!,parameters).map(leaf=>({type:'condition',kind:leaf.conditionId,params:leaf.parameters}))).toEqual(expected);
    expect(()=>materializeBasePreset(ipo,{strictContractionLegs:true,maxContractionLegRatio:1.1})).toThrow();
    expect(()=>materializeBasePreset(ipo,{requireBreakoutConfirmation:true})).toThrow();
  });
  it('preserves nesting, negation, and separate evidence for repeated family instances',()=>{
    const session='2026-10-01';
    const context:AdvancedContext={session,stock:{historyAligned:true,asOfDate:session} as SnapshotStock,setupCandidates:[candidate('first','2025-01-01'),candidate('later','2025-02-01',0)],setupMatches:{}};
    const series:CandleSeries={dates:new Int32Array(),open:new Float64Array(),high:new Float64Array(),low:new Float64Array(),close:new Float64Array(),volume:new Float64Array()};
    const a={instanceId:'first-only',conditionId:ipo.id,parameters:{}},b={instanceId:'any-base',conditionId:ipo.id,parameters:{requireFirstBase:false}},negative={...a,isNegated:true};
    const expression={type:'group' as const,operator:'all' as const,children:[{type:'condition' as const,condition:a},{type:'group' as const,operator:'any' as const,children:[{type:'condition' as const,condition:negative},{type:'condition' as const,condition:b}]}]};
    expect(evaluateExpression(expression,condition=>evaluateHistoryCondition(series,{...condition,instanceId:condition.instanceId??"test",isNegated:false},context))).toBe(true);
    expect(context.setupMatches?.['first-only'].id).toBe('first');expect(context.setupMatches?.['any-base'].id).toBe('later');
    expect(evaluateHistoryCondition(series,negative,context)).toBe(false);
    expect(evaluateHistoryCondition(series,a,{...context,setupCandidates:undefined})).toBeNull();
  });
});
