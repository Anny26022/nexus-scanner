import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { chartQuery } from '../chart/chartQuery';
import { aggregate, type Candle, type Interval } from '../chart/model';

export function ChartComparison({symbol,revision,sessionDate,interval,separate,onData}:{symbol:string;revision:string;sessionDate?:string;interval:Interval;separate:boolean;onData:(symbol:string,candles:readonly Candle[],separate:boolean)=>void}) {
  const query=useQuery(chartQuery(revision, symbol, sessionDate));
  const attach=useCallback((node:HTMLOutputElement|null)=>{
    if(!node) return;
    onData(symbol,aggregate(query.data?.candles??[],interval),separate);
    return ()=>onData('',[],false);
  },[symbol,query.data,interval,separate,onData]);
  return <output ref={attach} className="chart-comparison-status" role="status">{query.isError?`${symbol}: ${query.error.message}`:query.isPending?`Loading ${symbol}…`:!query.data.candles.length?`No published candles for ${symbol}`:`${symbol}${separate?' · pane':' · % scale'}`}</output>;
}
