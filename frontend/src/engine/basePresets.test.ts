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
    expect(PRESET_CATALOG.filter(p=>p.id.startsWith('lib-nexus-'))).toHaveLength(7);
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
