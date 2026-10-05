import { describe,it,expect } from 'vitest';
import { evaluateSnapshotCondition, type SnapshotStock } from '../api/snapshotScreen';
import { PRESET_CATALOG } from '../data/presetCatalog';
import definitions from '../data/presetDefinitions.json';
const session='2026-10-01';
const base={continuousHolding:true,holdsPivot:true,distanceFromPivotPct:2,breakoutAgeSessions:2,
  base:{ageSessions:40,depthPct:20,atrContraction:.6,volumeDryUp:.6},
  selection:{medianTurnover20:10,distanceSMA200:10,slopeSMA200:1,rsRating:90,rsChange22:5,distanceClosing52wHigh:10},
  current:{medianTurnover20:1,rsRating:20},breakout:{volumeRatio:2,closeInRange:.8,throughPct:2}};
const stock={historyAligned:true,asOfDate:session,bases:{FRESH_BREAKOUT:base,HOLDING:base}} as unknown as SnapshotStock;
const condition=(id:string,parameters:Record<string,unknown>={})=>({instanceId:'test',conditionId:id,parameters});
describe('editable Nexus base presets',()=>{
  it('exposes seven editable presets without losing the original 45',()=>{
    expect(PRESET_CATALOG.filter(p=>p.id.startsWith('lib-nexus-')&&!p.id.endsWith('-setup'))).toHaveLength(7);
    expect(PRESET_CATALOG.filter(p=>!p.id.startsWith('lib-nexus-'))).toHaveLength(45);
    expect(PRESET_CATALOG.find(p=>p.id==='lib-nexus-fresh-breakouts')?.parameters.length).toBeGreaterThan(1);
  });
  it('evaluates frozen quality and applies edited thresholds',()=>{
    const id='lib-nexus-fresh-breakouts';
    expect(evaluateSnapshotCondition(stock,condition(id),session)).toBe(true);
    const preset=definitions.find(p=>p.id===id)!;
    const index=preset.expression.children.findIndex(node=>(node.params as Record<string,unknown>).metric==='base.depthPct');
    expect(index).toBeGreaterThan(0);
    expect(evaluateSnapshotCondition(stock,condition(id,{[`threshold${index}`]:19}),session)).toBe(false);
  });
  it('rejects incompatible sessions rather than using stale bases',()=>{
    expect(evaluateSnapshotCondition(stock,condition('lib-nexus-fresh-breakouts'),'2026-10-02')).toBe(null);
  });
});

import { expressionPlan } from '../api/capabilityRegistry';
import { materializeBasePreset } from './basePresets';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
describe('versioned setup family parity',()=>{
  it('exposes four additional families and matches Python materialization across lifecycle stages',()=>{
    const families=definitions.filter(p=>p.id.endsWith('-setup'));
    expect(families).toHaveLength(4);
    const root=path.resolve(process.cwd(),'..');
    const requests=families.flatMap(preset=>['FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'].map(setupStage=>({id:preset.id,parameters:{setupStage,minContractionLegs:3,maxContractionLegRatio:.8,athPolicy:'AUDITED_INTRADAY',requireFirstBase:true,maxBaseDepth:30}})));
    const script=`import sys,json;sys.path.insert(0,'DO NOT DELETE EDL PIPELINE/src');from edl_pipeline.scanner.presets import get_preset;from edl_pipeline.scanner.base_presets import materialize_base_preset;requests=json.loads(sys.argv[1]);print(json.dumps([materialize_base_preset(get_preset(r['id']),r['parameters'])['children'] for r in requests]))`;
    const reference=JSON.parse(execFileSync('python3',['-c',script,JSON.stringify(requests)],{cwd:root,encoding:'utf8'}));
    requests.forEach((request,i)=>{
      const actual=materializeBasePreset(definitions.find(p=>p.id===request.id)!,request.parameters).map(leaf=>({type:'condition',kind:leaf.conditionId,params:leaf.parameters}));
      expect(actual).toEqual(reference[i]);
    });
  });
  it('routes complete presets to advanced when an optional policy needs private history facts',()=>{
    const local=condition('lib-nexus-blue-sky-setup',{setupStage:'HOLDING'});
    const strict=condition('lib-nexus-blue-sky-setup',{setupStage:'HOLDING',athPolicy:'AUDITED_INTRADAY'});
    expect(expressionPlan({type:'condition',condition:local}).browser).toBe(true);
    expect(expressionPlan({type:'condition',condition:strict}).browser).toBe(false);
    expect(expressionPlan({type:'condition',condition:condition('BASE_METRIC',{metric:'base.rsMinimum',value:80})}).browser).toBe(false);
  });
  it('rejects invalid optional policies rather than quietly replacing them',()=>{
    const preset=definitions.find(p=>p.id==='lib-nexus-vcp-setup')!;
    for(const parameters of [{minContractionLegs:1},{maxBaseDepth:null},{setupStage:null},{requireFirstBase:null},{athPolicy:'UNKNOWN'}]) expect(()=>materializeBasePreset(preset,parameters)).toThrow();
  });
  it('uses frozen liquidity, strength and pivot position for played-out families',()=>{
    const facts={stage:'PLAYED_OUT',base:{overheadPct:0,depthPct:40},selection:{historyFromListing:1,rsRating:90,marketCapCr:500,medianTurnover20:2,distanceFromPivotPct:-3},current:{rsRating:1,marketCapCr:10,medianTurnover20:0}};
    const input={historyAligned:true,asOfDate:session,bases:{PLAYED_OUT:facts}} as unknown as SnapshotStock;
    expect(evaluateSnapshotCondition(input,condition('lib-nexus-blue-sky-setup',{setupStage:'PLAYED_OUT'}),session)).toBe(true);
    expect(evaluateSnapshotCondition(input,condition('lib-nexus-blue-sky-setup',{setupStage:'PLAYED_OUT',athPolicy:'AUDITED_INTRADAY'}),session)).toBe(null);
  });
});
