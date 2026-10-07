import { describe, expect, it } from 'vitest';
import { screenSnapshot, evaluateSnapshotCondition, type SnapshotStock } from '../api/snapshotScreen';
import { expressionPlan } from '../api/capabilityRegistry';
import { createSnapshotEngine } from '../api/snapshotEngine';
import { evaluateHistoryCondition, type CandleSeries } from '../engine/historyEngine';
import { compileTextQuery } from '../engine/queryCompiler';
import type { ActiveCondition, ExpressionNode, ScreenerRunRequest } from '../types/screener';

const session='2026-10-01',revision='a'.repeat(64);
const stock={symbol:'TEST',close:100,volume:250000,marketCapCrore:3000,peRatio:20,
  asOfDate:session,metadataAsOfDate:session,historyAligned:true,indexMemberships:[],
  metrics:{sma20:90,sma50:80,return21:15},presetMatches:{},rsRating:85,dist52wHighPct:-3,
} as unknown as SnapshotStock;
const empty:CandleSeries={dates:new Int32Array(),open:new Float64Array(),high:new Float64Array(),
  low:new Float64Array(),close:new Float64Array(),volume:new Float64Array()};
const leaf=(conditionId:string,parameters:Record<string,unknown>):ActiveCondition=>({instanceId:conditionId,conditionId,parameters});
const request:ScreenerRunRequest={asOfDate:session,datasetRevision:revision,universe:'mainboard',page:1,pageSize:10,
  expressionTree:{type:'group',operator:'all',children:[]}};
const compiled=(text:string)=>compileTextQuery(text) as ExpressionNode;

describe('snapshot and advanced query equivalence',()=>{
  it.each([
    ['Market Cap > 2000','MARKETCAP',{comparison:'GREATER',valueCr:2000}],
    ['P/E <= 20','PE_RATIO',{comparison:'BELOW',value:20,reportType:'PREFER_CONSOLIDATED'}],
    ['Close Price > 50 DMA','PRICE_VS_SMA',{comparison:'ABOVE',period:50,persistDays:1}],
    ['Volume > 2','ABSOLUTE_VOLUME',{comparison:'GREATER',value:200000}],
  ])('uses the same published values and missing-data rules for %s',(text,id,parameters)=>{
    const expression=compiled(text);
    if(expression.type!=='condition')throw new Error('Expected leaf');
    const native=leaf(id as string,parameters as Record<string,unknown>);
    for(const row of [stock,{...stock,metadataAsOfDate:'2026-09-30'},
      {...stock,historyAligned:false},{...stock,marketCapCrore:null,peRatio:null,volume:null,metrics:{}}] as SnapshotStock[]) {
      const expected=evaluateSnapshotCondition(row,native,session);
      expect(evaluateSnapshotCondition(row,expression.condition,session)).toBe(expected);
      expect(evaluateHistoryCondition(empty,expression.condition,{stock:row,session})).toBe(expected);
      expect(evaluateHistoryCondition(empty,native,{stock:row,session})).toBe(expected);
    }
  });
  it('does not rescue missing published values using history or negate unavailable values',()=>{
    const missing={...stock,marketCapCrore:null} as unknown as SnapshotStock;
    const expression=compiled('Market Cap > 2000');
    if(expression.type!=='condition')throw new Error('Expected leaf');
    const condition={...expression.condition,isNegated:true};
    expect(evaluateSnapshotCondition(missing,condition,session)).toBe(null);
    expect(evaluateHistoryCondition(empty,condition,{stock:missing,session})).toBe(null);
  });
  it('runs complete nested scalar text locally with coverage and reuses it across pages',async()=>{
    const stale={...stock,symbol:'STALE',metadataAsOfDate:'2026-09-30'};
    const snapshot={revision,asOfDate:session,totalStocks:2,stocks:[stock,stale]};
    const run=createSnapshotEngine(async()=>snapshot);
    const textQuery='Market Cap > 2000 AND (20 DMA > 50 DMA OR Volume > 10)';
    expect(expressionPlan(compiled(textQuery)).browser).toBe(true);
    const result=await run({type:'screen',source:{revision,url:'/stocks.json'},request:{...request,textQuery}});
    expect(result.type==='screen' && result.result?.rows.map(row=>row.symbol)).toEqual(['TEST']);
    expect(result.type==='screen' && result.result?.unavailableDiagnostics).toContainEqual({conditionId:'FIELD_COMPARISON',reason:'required data unavailable',affectedCount:1});
    expect(screenSnapshot(snapshot,{...request,textQuery,page:2})?.matchCount).toBe(1);
  });
  it('keeps a whole expression remote when either operand requires history',()=>{
    expect(expressionPlan(compiled('Market Cap > 2000 OR RSI(14) > 50')).browser).toBe(false);
    expect(expressionPlan(compiled('20 DMA > Return over % 3 years')).browser).toBe(false);
  });
  it.each([
    ['rs_rating',{minRsRating:80},true],['rs_1month',{minRsRating:80},null],
    ['range_52w_proximity',{target:'High',maxDistancePct:5},true],
  ])('normalizes only equivalent published aliases: %s',(id,parameters,expected)=>{
    const condition=leaf(id,parameters);
    expect(expressionPlan({type:'condition',condition}).browser).toBe(true);
    expect(evaluateSnapshotCondition(stock,condition,session)).toBe(expected);
    expect(evaluateHistoryCondition(empty,condition,{stock,session})).toBe(expected);
  });
});
