import { describe,expect,it } from 'vitest';
import { evaluateHistoryCondition,type CandleSeries } from '../engine/historyEngine';
import { evaluateExpression } from '../engine/expression';
import type { ActiveCondition } from '../types/screener';
import type { SnapshotStock } from '../api/snapshotScreen';
import nativeConditions from '../data/nativeConditions.json';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';

const length=320;
const series:CandleSeries={
  dates:Int32Array.from({length},(_,i)=>20000+i),
  open:Float64Array.from({length},(_,i)=>100+i*.25),
  high:Float64Array.from({length},(_,i)=>102+i*.25),
  low:Float64Array.from({length},(_,i)=>98+i*.25),
  close:Float64Array.from({length},(_,i)=>101+i*.25),
  volume:Float64Array.from({length},(_,i)=>100000+i*100),
};
const stock={symbol:'TEST',name:'Test',close:series.close[length-1],metadataAsOfDate:'2026-10-01',asOfDate:'2026-10-01',historyAligned:true,indexMemberships:[],changePct:0.14,metrics:{sma20:178.375,sma50:174.625},presetMatches:{}} as unknown as SnapshotStock;
const context={stock,session:'2026-10-01'};
const leaf=(conditionId:string,parameters:Record<string,unknown>={}):ActiveCondition=>({instanceId:conditionId,conditionId,parameters});

describe('shared history engine',()=>{
  it('uses date-aligned official turnover and never substitutes close times volume',()=>{
    const dates=Array.from(series.dates).reverse();
    const turnover={dates,values:dates.map(day=>(day-20000+1)*1e7 as number|null)};
    for(const days of [20,17]){
      const expected=(320+(321-days))/2;
      const equal=leaf('AVG_TURNOVER',{lookbackDays:days,comparison:'EQUAL',valueCr:expected});
      expect(evaluateHistoryCondition(series,equal,{...context,turnover})).toBe(true);
      expect(evaluateHistoryCondition(series,{...equal,parameters:{...equal.parameters,valueCr:expected+1}}, {...context,turnover})).toBe(false);
      expect(evaluateHistoryCondition(series,equal,context)).toBeNull();
    }
    turnover.values[0]=null;
    expect(evaluateHistoryCondition(series,leaf('AVG_TURNOVER',{lookbackDays:20,comparison:'ABOVE',valueCr:1}),{...context,turnover})).toBeNull();
  });
  it('preserves delivery semantics with compact dated columns including duplicates and missing values',()=>{
    const day=series.dates[length-1],session=new Date(day*86400000).toISOString().slice(0,10);
    const rows=[{date:session,delivery_percent:20},{date:session,delivery_percent:65}];
    const packed={dates:[day,day],percentages:[20,65]};
    for(const condition of [leaf('DELIVERY_PERCENT',{comparison:'ABOVE',value:50}),leaf('DELIVERY_PCT_SPIKE',{minDeliverablePct:50,withinDays:1}),leaf('DELIVERY_PCT_SPIKE',{minDeliverablePct:50,withinDays:0})]){
      expect(evaluateHistoryCondition(series,condition,{...context,session,delivery:packed})).toBe(evaluateHistoryCondition(series,condition,{...context,session,delivery:rows}));
    }
    expect(evaluateHistoryCondition(series,leaf('DELIVERY_PERCENT',{comparison:'ABOVE',value:1}),{...context,session,delivery:{dates:[day],percentages:[null]}})).toBeNull();
  });
  it('keeps strict and inclusive comparisons distinct',()=>{
    expect(evaluateHistoryCondition(series,leaf('INDICATOR_COMPARE',{leftIndicator:'CLOSE',leftPeriod:1,op:'GREATER',rightValue:series.close[length-1],rightIndicator:'',withinDays:1}),context)).toBe(false);
    expect(evaluateHistoryCondition(series,leaf('INDICATOR_COMPARE',{leftIndicator:'CLOSE',leftPeriod:1,op:'ABOVE',rightValue:series.close[length-1],rightIndicator:'',withinDays:1}),context)).toBe(true);
  });
  it('matches the Python indicator authority for smoothing, units, and selectable periods',()=>{
    const above=(leftIndicator:string,leftPeriod:number,rightValue:number)=>leaf('INDICATOR_COMPARE',{leftIndicator,leftPeriod,op:'GREATER',rightValue,rightIndicator:'',withinDays:1});
    expect(evaluateHistoryCondition(series,above('EMA',20,178.37),context)).toBe(true);
    expect(evaluateHistoryCondition(series,above('WMA',20,179.16),context)).toBe(true);
    expect(evaluateHistoryCondition(series,above('MACD',26,1.74),context)).toBe(true);
    expect(evaluateHistoryCondition(series,above('BB_PCTB',20,91.18),context)).toBe(true);
    expect(evaluateHistoryCondition(series,above('ADX',14,99.9),context)).toBe(true);
    expect(evaluateHistoryCondition(series,above('SUPERTREND_DIRECTION',10,0),context)).toBe(true);
  });
  it('rejects look-ahead indicator offsets and returns unavailable when an oscillator never warms up',()=>{
    expect(()=>evaluateHistoryCondition(series,leaf('INDICATOR_COMPARE',{leftIndicator:'CLOSE',leftPeriod:1,leftOffset:-1,rightValue:0,rightIndicator:'',rightPeriod:1,rightOffset:0,op:'ABOVE',withinDays:1}),context)).toThrow('offsets');
    const short={...series,open:series.open.slice(0,10),high:series.high.slice(0,10),low:series.low.slice(0,10),close:series.close.slice(0,10),volume:series.volume.slice(0,10),dates:series.dates.slice(0,10)};
    expect(evaluateHistoryCondition(short,leaf('DIVERGENCE',{oscillator:'RSI',oscPeriod:14,direction:'BULLISH',variant:'REGULAR',pivotLeft:1,pivotRight:1,maxBarDifference:1,lookbackDays:10,withinDays:1}),context)).toBe(null);
  });
  it('keeps a Friday weekly bar in completed-week mode',()=>{
    const days=['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02'];
    const epochDays=Int32Array.from(days.map(day=>Date.parse(`${day}T00:00:00Z`)/86400000));
    const weekly:CandleSeries={dates:epochDays,open:Float64Array.from({length:10},()=>100),high:Float64Array.from([...Array(5).fill(200),...Array(5).fill(190)]),low:Float64Array.from([...Array(5).fill(0),...Array(5).fill(10)]),close:Float64Array.from({length:10},()=>100),volume:Float64Array.from({length:10},()=>100)};
    expect(evaluateHistoryCondition(weekly,leaf('INSIDE_BAR',{timeframe:'WEEKLY',weeklyMode:'COMPLETED',consecutive:1}),context)).toBe(true);
  });
  it('calculates convergence against close and supports negation',()=>{
    const condition=leaf('MA_CONVERGENCE',{periods:'9,20,50',maType:'EMA',maxSpreadPct:10,withinDays:1});
    expect(evaluateHistoryCondition(series,condition,context)).toBe(true);
    expect(evaluateHistoryCondition(series,{...condition,isNegated:true},context)).toBe(false);
  });
  it('returns unavailable for insufficient warmup and preserves three-valued boolean logic',()=>{
    const short={...series,open:series.open.slice(0,5),high:series.high.slice(0,5),low:series.low.slice(0,5),close:series.close.slice(0,5),volume:series.volume.slice(0,5),dates:series.dates.slice(0,5)};
    const unavailable=leaf('ADX',{period:14,comparison:'ABOVE',value:25});
    expect(evaluateHistoryCondition(short,unavailable,context)).toBe(null);
    const expression={type:'group' as const,operator:'all' as const,children:[{type:'condition' as const,condition:unavailable},{type:'condition' as const,condition:leaf('PRICE_CHANGE_PCT',{overDays:1,comparison:'GREATER',pct:100})}]};
    expect(evaluateExpression(expression,c=>evaluateHistoryCondition(short,c as ActiveCondition,context))).toBe(false);
  });
  it('evaluates numeric and field-to-field query operands from the same immutable series',()=>{
    expect(evaluateHistoryCondition(series,leaf('FIELD_COMPARISON',{field:'close',comparison:'GREATER',value:150}),context)).toBe(true);
    expect(evaluateHistoryCondition(series,leaf('FIELD_COMPARISON',{field:'sma_20',comparison:'GREATER',value:{field:'sma_50'}}),context)).toBe(true);
    expect(evaluateHistoryCondition(series,leaf('FIELD_COMPARISON',{field:'return_5y',comparison:'GREATER',value:0}),context)).toBe(null);
  });
  it('applies scalar negation exactly once',()=>{
    const condition=leaf('PRICE_RANGE',{minPrice:1,maxPrice:1000});
    expect(evaluateHistoryCondition(series,condition,context)).toBe(true);
    expect(evaluateHistoryCondition(series,{...condition,isNegated:true},context)).toBe(false);
  });
  it('uses the published delivery and quarterly-ledger shapes',()=>{
    const dates=Array.from(series.dates.slice(-3),day=>new Date(day*86400000).toISOString().slice(0,10));
    const enriched={...context,
      delivery:[{date:dates[0],delivery_percent:20},{date:dates[1],delivery_percent:65}],
      earnings:[
        {quarter_end:'2026-06-30',net_profit:150,eps:7,opm:20},
        {quarter_end:'2026-03-31',net_profit:120,eps:6,opm:19},
        {quarter_end:'2025-12-31',net_profit:110,eps:5,opm:18},
        {quarter_end:'2025-09-30',net_profit:105,eps:4,opm:17},
        {quarter_end:'2025-06-30',net_profit:100,eps:3,opm:15},
      ].map(row=>({...row,filing_date:'2026-09-01',report_type:'CONSOLIDATED'})),
    };
    expect(evaluateHistoryCondition(series,leaf('DELIVERY_PCT_SPIKE',{minDeliverablePct:50,withinDays:3}),enriched)).toBe(true);
    expect(evaluateHistoryCondition(series,leaf('EARNINGS_GROWTH',{metric:'NET_PROFIT',basis:'YOY',comparison:'GREATER',pct:25,reportType:'PREFER_CONSOLIDATED',maxAgeDays:200}),enriched)).toBe(true);
    expect(evaluateHistoryCondition(series,leaf('EARNINGS_GROWTH',{metric:'EPS',basis:'YOY',comparison:'GREATER',pct:100,reportType:'PREFER_CONSOLIDATED',maxAgeDays:200}),enriched)).toBe(true);
  });
  it('routes every native contract condition and Nexus advanced addition through a known evaluator',()=>{
    const definitions=[...nativeConditions,...NEXUS_CONDITION_CATALOG.filter(item=>['INDICATOR_COMPARE','MA_CONVERGENCE','DIVERGENCE','SUPERTREND'].includes(item.id))];
    expect(definitions.length).toBeGreaterThanOrEqual(58);
    for(const definition of definitions){
      const parameters=Object.fromEntries(definition.parameters.map(parameter=>[parameter.id,parameter.defaultValue]));
      expect(()=>evaluateHistoryCondition(series,leaf(definition.id,parameters),context),definition.id).not.toThrow();
    }
    expect(()=>evaluateHistoryCondition(series,leaf('UNKNOWN_CONDITION'),context)).toThrow('Unsupported condition');
  });
});
