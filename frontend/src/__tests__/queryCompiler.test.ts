import { describe,expect,it } from 'vitest';
import { compileTextQuery } from '../engine/queryCompiler';

describe('deterministic text compiler',()=>{
  it('preserves AND precedence over OR',()=>{
    const expression=compileTextQuery('Market Cap > 2000 OR P/E < 20 AND EPS > 15');
    expect(expression).toMatchObject({type:'group',operator:'any',children:[{type:'condition'},{type:'group',operator:'all'}]});
  });
  it('supports field labels containing parentheses',()=>{
    expect(compileTextQuery('Price to Earning (P/E) < 25')).toMatchObject({type:'condition',condition:{conditionId:'FIELD_COMPARISON',parameters:{field:'pe_ratio',comparison:'LESS',value:25}}});
    expect(compileTextQuery('Dividend Yield (%) >= 2')).toMatchObject({type:'condition',condition:{conditionId:'FIELD_COMPARISON',parameters:{field:'dividend_yield_percent',comparison:'ABOVE',value:2}}});
  });
  it('preserves nested groups, repeated leaves and field-to-field comparisons',()=>{
    const expression=compileTextQuery('(Close Price > 50 DMA AND Close Price > 50 DMA) OR 20 DMA > 50 DMA');
    expect(expression).toMatchObject({type:'group',operator:'any',children:[
      {type:'group',operator:'all',children:[{type:'condition'},{type:'condition'}]},
      {type:'condition',condition:{conditionId:'FIELD_COMPARISON',parameters:{field:'sma_20',value:{field:'sma_50'}}}},
    ]});
  });
  it('supports the deterministic advanced function syntax',()=>{
    expect(compileTextQuery('Supertrend(10, 3, BULLISH, STATE, 1)')).toMatchObject({type:'condition',condition:{conditionId:'SUPERTREND',parameters:{period:10,multiplier:3,direction:'BULLISH',signal:'STATE',withinDays:1}}});
    expect(compileTextQuery('MA Convergence("9,20,50,200", EMA, 1) <= 1.5')).toMatchObject({type:'condition',condition:{conditionId:'MA_CONVERGENCE',parameters:{periods:'9,20,50,200',maxSpreadPct:1.5}}});
    expect(compileTextQuery('RS Rating > 80')).toMatchObject({type:'condition',condition:{conditionId:'RS_RATING',parameters:{window:'FRONT_WEIGHTED',comparison:'GREATER',value:80}}});
  });
  it('rejects unsupported or partial clauses instead of reducing the query',()=>{
    expect(()=>compileTextQuery('Market Cap > 1000 AND magic stocks')).toThrow('Unsupported query clause');
    expect(()=>compileTextQuery('Unknown Metric > 2')).toThrow('Unsupported query field');
    expect(()=>compileTextQuery('MA Stack(abc, SMA, false)')).toThrow('MA Stack periods must be positive integers');
  });
});
