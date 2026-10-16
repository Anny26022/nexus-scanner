import { ema, type Candle } from './model';
import type { PriceSource } from './studyConfigs';

export function getPriceSource(bar: Candle, source: PriceSource = 'close'): number {
  switch (source) {
    case 'open': return bar.open;
    case 'high': return bar.high;
    case 'low': return bar.low;
    case 'hl2': return (bar.high + bar.low) / 2;
    case 'hlc3': return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4': return (bar.open + bar.high + bar.low + bar.close) / 4;
    case 'close':
    default:
      return bar.close;
  }
}

export const defaultStudies=()=>({rsi:false,macd:false,sma:false,bollinger:false,vwap:false,atr:false,stochastic:false,supertrend:false});
export type ChartStudies=ReturnType<typeof defaultStudies>;
export function sma(values:readonly (number|null)[],period:number):(number|null)[] {
  let sum=0,count=0;
  return values.map((value,index)=>{
    if(value!==null) {sum+=value;count++;}
    const expired=values[index-period];if(index>=period&&expired!==null) {sum-=expired;count--;}
    return index>=period-1&&count===period?sum/period:null;
  });
}
export function bollinger(candles:readonly Candle[],period=20,multiplier=2,source:PriceSource='close') {
  const middle=sma(candles.map(bar=>getPriceSource(bar,source)),period);
  const deviation=middle.map((mean,index)=>mean===null?null:Math.sqrt(candles.slice(index-period+1,index+1).reduce((sum,bar)=>sum+(getPriceSource(bar,source)-mean)**2,0)/period));
  return {middle,upper:middle.map((mean,index)=>mean===null?null:mean+multiplier*deviation[index]!),lower:middle.map((mean,index)=>mean===null?null:mean-multiplier*deviation[index]!)};
}
export function atr(candles:readonly Candle[],period=14):(number|null)[] {
  let value=0;
  return candles.map((bar,index)=>{
    const previous=candles[index-1]?.close??bar.close;
    const range=Math.max(bar.high-bar.low,Math.abs(bar.high-previous),Math.abs(bar.low-previous));
    if(index<period) {value+=range;if(index<period-1) return null;value/=period;}
    else value=(value*(period-1)+range)/period;
    return value;
  });
}
export function stochastic(candles:readonly Candle[],period=14,dPeriod=3) {
  const k=candles.map((bar,index)=>{
    if(index<period-1) return null;
    const window=candles.slice(index-period+1,index+1),high=Math.max(...window.map(bar=>bar.high)),low=Math.min(...window.map(bar=>bar.low));
    return high===low?50:100*(bar.close-low)/(high-low);
  });
  return {k,d:sma(k,dPeriod)};
}
/** Daily/aggregate candles cannot provide true intraday session VWAP. Reset on calendar month. */
export function monthlyVwap(candles:readonly Candle[]):(number|null)[] {
  let month='',weighted=0,volume=0,missing=false;
  return candles.map(bar=>{
    if(bar.date.slice(0,7)!==month) {month=bar.date.slice(0,7);weighted=0;volume=0;missing=false;}
    if(bar.volume===null) missing=true;
    else {weighted+=(bar.high+bar.low+bar.close)/3*bar.volume;volume+=bar.volume;}
    return missing||volume===0?null:weighted/volume;
  });
}

// Calculations remain Nexus-owned; Lightweight Charts renders the resulting series.
export function rsi(candles:readonly Candle[],period=14,source:PriceSource='close'):(number|null)[] {
  let gain=0,loss=0;
  return candles.map((bar,index)=>{
    if(!index) return null;
    const price=getPriceSource(bar,source),prevPrice=getPriceSource(candles[index-1],source);
    const change=price-prevPrice,up=Math.max(0,change),down=Math.max(0,-change);
    if(index<=period) {gain+=up;loss+=down;}
    else {gain=gain*(period-1)/period+up/period;loss=loss*(period-1)/period+down/period;}
    if(index<period) return null;
    if(index===period) {gain/=period;loss/=period;}
    return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
  });
}
export function macd(candles:readonly Candle[],fastPeriod=12,slowPeriod=26,signalPeriod=9,source:PriceSource='close') {
  const sourceCandles=source==='close'?candles:candles.map(b=>({...b,close:getPriceSource(b,source)}));
  const fast=ema(sourceCandles,fastPeriod),slow=ema(sourceCandles,slowPeriod);
  const line=slow.map((value,index)=>value===null?null:fast[index]!-value);
  const offset=slowPeriod-1;
  const populated=candles.slice(offset).map((bar,index)=>({...bar,close:line[index+offset]!}));
  const signal=[...Array<null>(Math.min(offset,candles.length)).fill(null),...ema(populated,signalPeriod)];
  return {line,signal,histogram:line.map((value,index)=>value===null||signal[index]===null?null:value-signal[index]!)};
}

export function supertrend(candles:readonly Candle[],period=10,multiplier=3) {
  if(!candles.length) return {values:[],directions:[]};
  const trValues=candles.map((bar,index)=>{
    if(index===0) return bar.high-bar.low;
    const prev=candles[index-1];
    return Math.max(bar.high-bar.low,Math.abs(bar.high-prev.close),Math.abs(bar.low-prev.close));
  });
  const atrValues:(number|null)[]=[];
  let sum=0;
  for(let i=0;i<candles.length;i++) {
    if(i<period) {
      sum+=trValues[i];
      if(i===period-1) atrValues.push(sum/period);
      else atrValues.push(null);
    } else {
      const prevAtr=atrValues[i-1]!;
      atrValues.push((prevAtr*(period-1)+trValues[i])/period);
    }
  }

  const supertrendValues:(number|null)[]=[];
  const directions:(1|-1)[]=[];
  let prevFinalUpper=0;
  let prevFinalLower=0;
  let currentTrend:1|-1=1;

  for(let i=0;i<candles.length;i++) {
    const atr=atrValues[i];
    if(atr===null) {
      supertrendValues.push(null);
      directions.push(1);
      continue;
    }
    const bar=candles[i];
    const prevBar=candles[i-1];
    const hl2=(bar.high+bar.low)/2;
    const basicUpper=hl2+multiplier*atr;
    const basicLower=hl2-multiplier*atr;

    let finalUpper=basicUpper;
    let finalLower=basicLower;

    if(i>0&&atrValues[i-1]!==null) {
      finalUpper=(basicUpper<prevFinalUpper||prevBar.close>prevFinalUpper)?basicUpper:prevFinalUpper;
      finalLower=(basicLower>prevFinalLower||prevBar.close<prevFinalLower)?basicLower:prevFinalLower;
    }

    if(currentTrend===1) {
      if(bar.close<finalLower) {
        currentTrend=-1;
        supertrendValues.push(finalUpper);
      } else {
        supertrendValues.push(finalLower);
      }
    } else {
      if(bar.close>finalUpper) {
        currentTrend=1;
        supertrendValues.push(finalLower);
      } else {
        supertrendValues.push(finalUpper);
      }
    }
    prevFinalUpper=finalUpper;
    prevFinalLower=finalLower;
    directions.push(currentTrend);
  }
  return {values:supertrendValues,directions};
}
