import { expect, it } from 'vitest';
import { rsi, macd, sma, bollinger, atr, stochastic, monthlyVwap } from '../chart/studies';
import { chartEvents, revealedThrough } from '../chart/events';
import type { Candle } from '../chart/model';
import { formatIndicatorValue, updateLiveIndicatorDom, type IndicatorSnapshot } from '../chart/indicatorValues';
import { defaultStudyConfigs } from '../chart/studyConfigs';

const candles:Candle[]=Array.from({length:50},(_,index)=>({date:new Date(Date.UTC(2026,0,index+1)).toISOString().slice(0,10),open:index+10,high:index+11,low:index+9,close:index+10,volume:100}));
it('uses Wilder RSI warmup, handles flat and rising prices without inventing early values',()=>{
  expect(rsi(candles).slice(0,14)).toEqual(Array(14).fill(null));
  expect(rsi(candles).slice(14)).toEqual(Array(36).fill(100));
  expect(rsi(candles.map(bar=>({...bar,close:10}))).at(-1)).toBe(50);
  expect(rsi(candles.map((bar,index)=>({...bar,close:100-index}))).at(-1)).toBe(0);
});
it('seeds MACD and its signal independently and calculates only from the revealed prefix',()=>{
  const result=macd(candles);
  expect(result.line.slice(0,25)).toEqual(Array(25).fill(null));
  expect(result.line[25]).toBeCloseTo(7);
  expect(result.signal.slice(0,33)).toEqual(Array(33).fill(null));
  expect(result.signal[33]).toBeCloseTo(7);
  expect(result.histogram[33]).toBeCloseTo(0);
  for(const length of [1,20,26,33,40]) {
    const partial=macd(candles.slice(0,length));
    expect(partial.line).toEqual(result.line.slice(0,length));
    expect(partial.signal).toEqual(result.signal.slice(0,length));
    expect(partial.histogram).toEqual(result.histogram.slice(0,length));
  }
});
it('reads published event dates, deduplicates quarterly filing rows and rejects invalid dates',()=>{
  const result=chartEvents({earnings:[{filing_date:'2026-01-12 16:30:00'},{filing_date:'2026-01-12 16:30:00'},{filing_date:'2026-01-21',filing_caption:'Closure of Trading Window'}],corporateActions:[{ex_date:'2026-02-30',source_details:'Bad'},{ex_date:'2026-01-15',source_details:'Split 1:2'}],marketNews:[{date:'2026-01-20',headline:'Company update'}]});
  expect(result.map(({date,kind,title})=>({date,kind,title}))).toEqual([
    {date:'2026-01-12',kind:'earnings',title:'Earnings filing'},
    {date:'2026-01-15',kind:'action',title:'Split 1:2'},
    {date:'2026-01-20',kind:'news',title:'Company update'},
    {date:'2026-01-21',kind:'news',title:'Closure of Trading Window'},
  ]);
});
it('uses closed aggregate cutoffs for weekly replay without leaking the next bar events',()=>{
  const weekly=[candles[4],candles[11],candles[18]];
  expect(revealedThrough(weekly,0,'2026-01-22')).toBe('2026-01-11');
  expect(revealedThrough(weekly,2,'2026-01-22')).toBe('2026-01-22');
  expect(revealedThrough(weekly,null,'2026-01-22')).toBe('2026-01-22');
});
it('calculates SMA, population-deviation bands, Wilder ATR and stochastic with honest warmups',()=>{
  expect(sma([1,null,3,4,5],3)).toEqual([null,null,null,null,4]);
  const flat=candles.map(bar=>({...bar,open:10,high:11,low:9,close:10}));
  expect(bollinger(flat).upper.slice(0,19)).toEqual(Array(19).fill(null));
  expect(bollinger(flat).upper[19]).toBe(10);
  expect(bollinger(flat).lower[19]).toBe(10);
  expect(atr(flat)[12]).toBeNull();expect(atr(flat)[13]).toBe(2);expect(atr(flat).at(-1)).toBe(2);
  expect(stochastic(flat).k[12]).toBeNull();expect(stochastic(flat).k[13]).toBe(50);
  expect(stochastic(flat).d[14]).toBeNull();expect(stochastic(flat).d[15]).toBe(50);
  const full={bands:bollinger(candles),atr:atr(candles),stoch:stochastic(candles)};
  expect(bollinger(candles.slice(0,30)).upper).toEqual(full.bands.upper.slice(0,30));
  expect(atr(candles.slice(0,30))).toEqual(full.atr.slice(0,30));
  expect(stochastic(candles.slice(0,30)).d).toEqual(full.stoch.d.slice(0,30));
});
it('resets bar-based monthly VWAP on a new month and does not ignore missing volume',()=>{
  const bars=[{...candles[0],date:'2026-01-29',high:12,low:9,close:9,volume:100},{...candles[1],date:'2026-01-30',high:24,low:18,close:18,volume:300},{...candles[2],date:'2026-02-02',volume:null},{...candles[3],date:'2026-02-03'},{...candles[4],date:'2026-03-02',high:18,low:12,close:15}];
  expect(monthlyVwap(bars)).toEqual([10,17.5,null,null,15]);
});
it('uses configured precision for live study values and safely formats malformed precision',()=>{
  expect(formatIndicatorValue(12.3456, 3)).toBe('12.346');
  expect(formatIndicatorValue(12.3456, 200)).toBe('12.3456000000');
  expect(formatIndicatorValue(Number.NaN)).toBe('-');
  const host=document.createElement('div');
  host.innerHTML='<span data-ind-val="rsi"></span><span data-ind-val="macd-line"></span>';
  const config=defaultStudyConfigs();
  config.rsi={...config.rsi!,precision:0};
  config.macd={...config.macd!,precision:3};
  updateLiveIndicatorDom(host,{rsi:52.4,macd:{line:1.2345,signal:null,histogram:null}} as IndicatorSnapshot,config);
  expect(host.querySelector('[data-ind-val="rsi"]')?.textContent).toBe('52');
  expect(host.querySelector('[data-ind-val="macd-line"]')?.textContent).toBe('1.234');
});
it('keeps news summaries, filing bodies and web document links on chart events',()=>{
  const [filing,news]=chartEvents({earnings:[],corporateActions:[],marketNews:[{date:'2026-10-22',headline:'Fire at unit',summary:'₹2 crore loss.',source:'companies',url:'javascript:alert(1)'}],
    regulatoryAnnouncements:[{date:'2026-10-21',headline:'Reg 30 update',body:'Fire incident at subsidiary.',url:'https://www.bseindia.com/a.pdf'}]});
  expect(filing).toMatchObject({detail:'Fire incident at subsidiary.',url:'https://www.bseindia.com/a.pdf'});
  expect(news).toMatchObject({detail:'₹2 crore loss.',source:'companies'}); expect(news.url).toBeUndefined();
});
