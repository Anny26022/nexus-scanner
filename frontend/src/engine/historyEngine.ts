import type { ActiveCondition } from '../types/screener';
import type { SnapshotStock } from '../api/snapshotScreen';
import { evaluateSnapshotCondition } from '../api/snapshotScreen';
import { compare, negate, type Truth } from './expression';

export interface CandleSeries { dates:Int32Array; open:Float64Array; high:Float64Array; low:Float64Array; close:Float64Array; volume:Float64Array }
export interface AdvancedContext {
  stock: SnapshotStock;
  session: string;
  benchmarks?: Record<string,{dates:number[];closes:number[]}>;
  delivery?: Array<Record<string,unknown>>;
  earnings?: Array<Record<string,unknown>>;
  breadth?: Record<string,Record<string,number|null>>;
}

const n = (value:unknown, fallback=0) => typeof value === 'number' ? value : Number(value ?? fallback);
const str = (value:unknown, fallback='') => String(value ?? fallback);
const last = (values:ArrayLike<number>, offset=0) => values[values.length-1-offset];
const slice = (values:ArrayLike<number>, start:number, end=values.length) => Array.from(values).slice(start,end);
const mean = (values:number[]) => values.length && values.every(Number.isFinite) ? values.reduce((a,b)=>a+b,0)/values.length : NaN;
const max = (values:number[]) => values.length ? Math.max(...values) : NaN;
const min = (values:number[]) => values.length ? Math.min(...values) : NaN;

function sma(values:ArrayLike<number>, period:number) {
  const out=Array(values.length).fill(NaN); let sum=0;
  for(let i=0;i<values.length;i++){ sum+=values[i]; if(i>=period) sum-=values[i-period]; if(i>=period-1) out[i]=sum/period; }
  return out;
}
function ewm(values:ArrayLike<number>, alpha:number, minPeriods:number) {
  const out=Array(values.length).fill(NaN);let value=NaN,observations=0;
  for(let i=0;i<values.length;i++){
    const current=values[i];
    if(!Number.isFinite(current))continue;
    value=Number.isFinite(value)?current*alpha+value*(1-alpha):current;
    observations+=1;
    if(observations>=minPeriods)out[i]=value;
  }
  return out;
}
function ema(values:ArrayLike<number>, period:number) {
  return ewm(values,2/(period+1),period);
}
function wilder(values:number[], period:number) {
  return ewm(values,1/period,period);
}
function wma(values:ArrayLike<number>,period:number){const weight=period*(period+1)/2;return Array.from(values,(_,i)=>i+1<period?NaN:slice(values,i+1-period,i+1).reduce((sum,v,j)=>sum+v*(j+1),0)/weight);}
function moving(series:CandleSeries,type:string,period:number){const kind=type.toUpperCase();return kind==='EMA'?ema(series.close,period):kind==='WMA'?wma(series.close,period):sma(series.close,period);}
function trueRange(s:CandleSeries){return Array.from(s.close,(_,i)=>i===0?s.high[i]-s.low[i]:Math.max(s.high[i]-s.low[i],Math.abs(s.high[i]-s.close[i-1]),Math.abs(s.low[i]-s.close[i-1])));}
function atr(s:CandleSeries,period:number){return wilder(trueRange(s),period);}
function rsi(values:ArrayLike<number>,period:number){
  const gains=Array(values.length).fill(NaN),losses=Array(values.length).fill(NaN);
  for(let i=1;i<values.length;i++){const d=values[i]-values[i-1];gains[i]=Math.max(d,0);losses[i]=Math.max(-d,0);}
  const g=wilder(gains,period),l=wilder(losses,period);return g.map((v,i)=>Number.isFinite(v)?l[i]===0?(v===0?50:100):100-100/(1+v/l[i]):NaN);
}
function adx(s:CandleSeries,period:number){
  const tr=trueRange(s),plus=Array(s.close.length).fill(0),minus=Array(s.close.length).fill(0);
  for(let i=1;i<s.close.length;i++){const up=s.high[i]-s.high[i-1],down=s.low[i-1]-s.low[i];plus[i]=up>down&&up>0?up:0;minus[i]=down>up&&down>0?down:0;}
  const a=wilder(tr,period),p=wilder(plus,period),m=wilder(minus,period);
  const dx=a.map((v,i)=>Number.isFinite(v)&&v!==0?100*Math.abs(p[i]/v-m[i]/v)/(p[i]/v+m[i]/v):NaN);
  return {adx:wilder(dx,period),plus:p.map((v,i)=>100*v/a[i]),minus:m.map((v,i)=>100*v/a[i])};
}
function event(flags:Array<Truth>,within:number):Truth{const recent=flags.slice(-within);return !recent.length?null:recent.includes(true)?true:recent.includes(null)?null:false;}
function comparison(value:number,p:Record<string,unknown>,key='value'):Truth{return compare(value,p.comparison,p[key]);}
function percentChange(current:number,prior:number){return prior>0?(current/prior-1)*100:NaN;}
function isoWeekKey(epochDay:number){const date=new Date(epochDay*86400000),weekday=(date.getUTCDay()+6)%7;date.setUTCDate(date.getUTCDate()+3-weekday);const year=date.getUTCFullYear(),firstThursday=new Date(Date.UTC(year,0,4)),firstWeekday=(firstThursday.getUTCDay()+6)%7;firstThursday.setUTCDate(firstThursday.getUTCDate()+3-firstWeekday);return `${year}-${1+Math.round((date.getTime()-firstThursday.getTime())/604800000)}`;}

function indicator(s:CandleSeries,name:string,period:number,multiplier=3):number[]{
  const id=name.toUpperCase();
  if(id==='CLOSE')return Array.from(s.close);if(id==='OPEN')return Array.from(s.open);if(id==='HIGH')return Array.from(s.high);if(id==='LOW')return Array.from(s.low);if(id==='VOLUME')return Array.from(s.volume);
  if(id==='HL2')return Array.from(s.close,(_,i)=>(s.high[i]+s.low[i])/2);if(id==='HLC3')return Array.from(s.close,(_,i)=>(s.high[i]+s.low[i]+s.close[i])/3);if(id==='OHLC4')return Array.from(s.close,(_,i)=>(s.open[i]+s.high[i]+s.low[i]+s.close[i])/4);
  if(id==='SMA')return sma(s.close,period);if(id==='EMA')return ema(s.close,period);if(id==='VOLUME_SMA')return sma(s.volume,period);if(id==='RSI')return rsi(s.close,period);if(id==='ATR')return atr(s,period);
  const direction=adx(s,period);if(id==='ADX')return direction.adx;if(id==='PLUS_DI')return direction.plus;if(id==='MINUS_DI')return direction.minus;
  if(id==='ROC')return Array.from(s.close,(v,i)=>i>=period?percentChange(v,s.close[i-period]):NaN);
  if(id==='OBV'){let value=0;return Array.from(s.close,(v,i)=>{if(i)value+=v>s.close[i-1]?s.volume[i]:v<s.close[i-1]?-s.volume[i]:0;return value;});}
  if(id.startsWith('DONCHIAN_'))return Array.from(s.close,(_,i)=>i+1>=period?(id.endsWith('UPPER')?max(slice(s.high,i+1-period,i+1)):min(slice(s.low,i+1-period,i+1))):NaN);
  if(id.startsWith('BB_')){const mid=sma(s.close,period),sd=Array(s.close.length).fill(NaN);for(let i=period-1;i<s.close.length;i++){const w=slice(s.close,i+1-period,i+1),m=mid[i];sd[i]=Math.sqrt(mean(w.map(v=>(v-m)**2)));}const upper=mid.map((v,i)=>v+2*sd[i]),lower=mid.map((v,i)=>v-2*sd[i]);if(id==='BB_MIDDLE')return mid;if(id==='BB_UPPER')return upper;if(id==='BB_LOWER')return lower;if(id==='BB_WIDTH')return mid.map((v,i)=>(upper[i]-lower[i])/v*100);return Array.from(s.close,(v,i)=>(v-lower[i])/(upper[i]-lower[i])*100);}
  if(id.startsWith('MACD')){const slowPeriod=Math.max(3,period),fastPeriod=Math.min(Math.max(2,Math.round(slowPeriod*12/26)),slowPeriod-1),signalPeriod=Math.max(2,Math.round(slowPeriod*9/26)),fast=ema(s.close,fastPeriod),slow=ema(s.close,slowPeriod),line=fast.map((v,i)=>v-slow[i]),signal=ema(line,signalPeriod);return id==='MACD'?line:id==='MACD_SIGNAL'?signal:line.map((v,i)=>v-signal[i]);}
  if(id==='WMA')return wma(s.close,period);
  if(id==='WILLIAMS_R'||id.startsWith('STOCH_')){const k=Array.from(s.close,(v,i)=>{if(i+1<period)return NaN;const h=max(slice(s.high,i+1-period,i+1)),l=min(slice(s.low,i+1-period,i+1));return id==='WILLIAMS_R'?-100*(h-v)/(h-l):100*(v-l)/(h-l);});return id==='STOCH_D'?sma(k,3):k;}
  if(id==='CCI'){const tp=Array.from(s.close,(_,i)=>(s.high[i]+s.low[i]+s.close[i])/3),ma=sma(tp,period);return tp.map((v,i)=>{if(i+1<period)return NaN;const dev=mean(tp.slice(i+1-period,i+1).map(x=>Math.abs(x-ma[i])));return (v-ma[i])/(.015*dev);});}
  if(id==='MFI'){const tp=Array.from(s.close,(_,i)=>(s.high[i]+s.low[i]+s.close[i])/3),pos=tp.map((v,i)=>i&&v>tp[i-1]?v*s.volume[i]:0),neg=tp.map((v,i)=>i&&v<tp[i-1]?v*s.volume[i]:0);return tp.map((_,i)=>{if(i+1<period)return NaN;const positive=slice(pos,i+1-period,i+1).reduce((a,b)=>a+b,0),negative=slice(neg,i+1-period,i+1).reduce((a,b)=>a+b,0);return negative===0?(positive===0?50:100):100-100/(1+positive/negative);});}
  if(id==='SUPERTREND')return supertrend(s,period,multiplier).line;
  throw new Error(`Unsupported indicator: ${name}`);
}

function supertrend(s:CandleSeries,period:number,multiplier:number){
  const a=atr(s,period),line=Array(s.close.length).fill(NaN),direction=Array(s.close.length).fill(0),upper=Array(s.close.length).fill(NaN),lower=Array(s.close.length).fill(NaN);
  for(let i=0;i<s.close.length;i++){if(!Number.isFinite(a[i]))continue;const mid=(s.high[i]+s.low[i])/2,bu=mid+multiplier*a[i],bl=mid-multiplier*a[i];upper[i]=i&&Number.isFinite(upper[i-1])&&s.close[i-1]<=upper[i-1]?Math.min(bu,upper[i-1]):bu;lower[i]=i&&Number.isFinite(lower[i-1])&&s.close[i-1]>=lower[i-1]?Math.max(bl,lower[i-1]):bl;if(!i||!direction[i-1])direction[i]=s.close[i]>=mid?1:-1;else if(direction[i-1]===1)direction[i]=s.close[i]<lower[i]?-1:1;else direction[i]=s.close[i]>upper[i]?1:-1;line[i]=direction[i]===1?lower[i]:upper[i];}
  return {line,direction};
}

function persisted(s:CandleSeries,averages:number[],side:string,days:number,mode:string):Truth{
  if(s.close.length<days||!Number.isFinite(last(averages)))return null;const start=s.close.length-days,desired=Array.from({length:days},(_,j)=>side==='above'?s.close[start+j]>averages[start+j]:s.close[start+j]<averages[start+j]);if(desired.every(Boolean))return true;
  if(mode==='every_close')return false;
  if(mode==='extreme_reset'){
    let run=0,anchor:number|null=null;
    for(let i=0;i<s.close.length;i++){
      if(!Number.isFinite(averages[i])){run=0;anchor=null;continue;}
      const onSide=side==='above'?s.close[i]>averages[i]:s.close[i]<averages[i];
      const crossed=anchor!==null&&(side==='above'?s.low[i]<anchor:s.high[i]>anchor);
      if(crossed){run=0;anchor=null;}
      if(run===0){if(onSide)run=1;}
      else {run+=1;if(!onSide&&anchor===null)anchor=side==='above'?s.low[i]:s.high[i];}
    }
    return run>=days;
  }
  const breaches=desired.map((v,i)=>v?-1:i).filter(i=>i>=0);if(breaches.length!==1)return false;const b=start+breaches[0];for(let i=b+1;i<s.close.length;i++){if(side==='above'&&s.high[i]>=s.high[b]&&s.close[i]>averages[i])return true;if(side==='below'&&s.low[i]<=s.low[b]&&s.close[i]<averages[i])return true;}return false;
}
function zigzag(s:CandleSeries,start:number,thresholdPct:number){const out:Array<[number,number,'high'|'low']>=[];let direction=0,extreme=start,price=s.close[start];const threshold=thresholdPct/100;for(let i=start+1;i<s.close.length;i++){const close=s.close[i];if(direction>=0){if(close>=price){extreme=i;price=close;}else if((price-close)/price>=threshold){out.push([extreme,s.high[extreme],'high']);direction=-1;extreme=i;price=close;continue;}}if(direction<=0){if(close<=price){extreme=i;price=close;}else if((close-price)/price>=threshold){out.push([extreme,s.low[extreme],'low']);direction=1;extreme=i;price=close;}}}if(direction>0)out.push([extreme,s.high[extreme],'high']);else if(direction<0)out.push([extreme,s.low[extreme],'low']);return out;}

const stockFieldNames:Record<string,string>={
  market_cap_crore:'marketCapCrore',pe_ratio:'peRatio',debt_to_equity:'debtToEquity',eps_ttm:'epsTtm',
  promoter_holding_percent:'promoterHoldingPct',public_holding_percent:'publicHoldingPct',number_of_shareholders:'numberOfShareholders',
  dividend_yield_percent:'dividendYieldPct',face_value:'faceValue',total_income_in_lakhs:'totalIncomeLakh',
  total_expense_in_lakhs:'totalExpenseLakh',profit_before_tax_in_lakhs:'profitBeforeTaxLakh',
  total_tax_expenses_in_lakhs:'totalTaxExpensesLakh',net_profit_in_lakhs:'netProfitLakh',total_equity_in_lakhs:'totalEquityLakh',
  total_assets_in_lakhs:'totalAssetsLakh',current_assets_in_lakhs:'currentAssetsLakh',non_current_assets_in_lakhs:'nonCurrentAssetsLakh',
  total_liabilities_in_lakhs:'totalLiabilitiesLakh',current_liabilities_in_lakhs:'currentLiabilitiesLakh',
  non_current_liabilities_in_lakhs:'nonCurrentLiabilitiesLakh',total_revenue_in_lakhs:'totalRevenueLakh',
  operating_cash_flow_in_lakhs:'operatingCashFlowLakh',investing_cash_flow_in_lakhs:'investingCashFlowLakh',
  net_cash_flow_in_lakhs:'netCashFlowLakh',interest_coverage:'interestCoverage',vwap:'vwap',
  dividend_per_share_latest:'dividendPerShare',all_time_high:'allTimeHigh',all_time_low:'allTimeLow',
};

function fieldValue(series:CandleSeries,stock:SnapshotStock,field:string):number{
  const periods:Record<string,number>={sma_20:20,sma_50:50,sma_200:200};
  const returns:Record<string,number>={return_1m:21,return_1y:252,return_3y:756,return_5y:1260};
  if(field==='close')return last(series.close);if(field==='open')return last(series.open);if(field==='high')return last(series.high);if(field==='low')return last(series.low);if(field==='volume_lakh')return last(series.volume)/100000;
  if(periods[field])return last(sma(series.close,periods[field]));
  if(field==='high_52w')return max(slice(series.high,-252));if(field==='low_52w')return min(slice(series.low,-252));
  if(returns[field])return series.close.length>returns[field]?percentChange(last(series.close),last(series.close,returns[field])):NaN;
  if(field==='return_ytd'){
    const finalDay=last(series.dates),finalYear=new Date(finalDay*86400000).getUTCFullYear();
    const first=Array.from(series.dates).findIndex(day=>new Date(day*86400000).getUTCFullYear()===finalYear);
    return first>=0&&first<series.close.length-1?percentChange(last(series.close),series.close[first]):NaN;
  }
  if(field==='daily_volatility'||field==='annualized_volatility'){
    if(series.close.length<14)return NaN;
    const value=mean(Array.from({length:14},(_,j)=>{const i=series.close.length-14+j;return (series.high[i]-series.low[i])/series.close[i]*100;}));
    return field==='annualized_volatility'?value*Math.sqrt(250):value;
  }
  const key=stockFieldNames[field]??field;
  return n((stock as unknown as Record<string,unknown>)[key],NaN);
}

const scalarIds=new Set(['PRICE_VS_SMA','PRICE_VS_EMA','PRICE_CHANGE_PCT','GAP_UP','GAP_DOWN','VOLUME_VS_AVG','NEW_HIGH','NEW_LOW','PCT_FROM_52W_HIGH','PCT_FROM_52W_LOW','PCT_FROM_ATH','ATR_PCT','RS_RATING','MARKETCAP','FF_MARKETCAP','PE_RATIO','FUNDAMENTAL_METRIC','EPS_LAST_YEAR_HIGHER','SECTOR','INDUSTRY','PRICE_BAND','CIRCUIT_BAND_MIN','SERIES','INDEX_MEMBERSHIP','FNO_BAN','EXCLUDE_SURVEILLANCE','ABSOLUTE_VOLUME','ABSOLUTE_EPS','DIVIDEND_YIELD','PRICE_RANGE','ADR_PCT','AVG_TURNOVER']);
const historyIds=new Set(['FIELD_COMPARISON','PERSISTENT_MOMENTUM','PRICE_VS_EMA','PRICE_VS_SMA','EMA_SHAKEOUT','ADX','PCT_DAYS_ABOVE_MA','MA_STACK','MA_SLOPE','PRICE_CHANGE_PCT','CONSECUTIVE_UP_DAYS','GAP_UP','GAP_DOWN','VOLUME_VS_AVG','AVG_VOLUME_RATIO','HIGHEST_VOLUME_IN_N_DAYS','DELIVERY_PCT_SPIKE','DELIVERY_PERCENT','NEW_HIGH','NEW_LOW','PCT_FROM_52W_HIGH','PCT_FROM_52W_LOW','CONSOLIDATION_RANGE','ATR_PCT','RANGE_CONTRACTION','INSIDE_BAR','UNFILLED_GAP','VCP_LEGS','HORIZONTAL_RESISTANCE_LINE','MA_CONVERGENCE','SUPERTREND','INDICATOR_COMPARE','DIVERGENCE','RELATIVE_STRENGTH','RS_NEW_HIGH','AVG_TURNOVER','ADR_PCT','DAYS_SINCE_EARNINGS','LISTING_AGE_DAYS','EARNINGS_GROWTH','MARKET_BREADTH']);

export function evaluateHistoryCondition(series:CandleSeries,condition:ActiveCondition,context:AdvancedContext):Truth{
  const special=evaluateLegacySpecial(series,condition,context);
  if(special!==undefined)return condition.isNegated?negate(special):special;
  const legacy=translateLegacy(condition);
  if(legacy!==condition)return evaluateHistoryCondition(series,legacy,context);
  const id=condition.conditionId,p=condition.parameters;
  if(id.startsWith('lib-'))return evaluateSnapshotCondition(context.stock,condition,context.session);
  if(!scalarIds.has(id)&&!historyIds.has(id))throw new Error(`Unsupported condition: ${id}`);
  if(scalarIds.has(id)){const value=evaluateSnapshotCondition(context.stock,{...condition,isNegated:false},context.session);if(value!==null)return condition.isNegated?negate(value):value;}
  let result:Truth=null;
  if(id==='FIELD_COMPARISON'){const left=fieldValue(series,context.stock,str(p.field)),target=typeof p.value==='object'&&p.value!==null?fieldValue(series,context.stock,str((p.value as {field?:unknown}).field)):n(p.value,NaN);result=compare(left,p.comparison,target);}
  else if(id==='PERSISTENT_MOMENTUM'){const tests=[[10,n(p.ema10Days,20)],[20,n(p.ema20Days,30)],[50,n(p.ema50Days,50)]].map(([period,days])=>persisted(series,ema(series.close,period), 'above',days,'reclaim_by_extreme'));result=tests.includes(true)?true:tests.includes(null)?null:false;}
  else if(id==='PRICE_VS_EMA'||id==='PRICE_VS_SMA'){result=persisted(series,moving(series,id.endsWith('EMA')?'EMA':'SMA',n(p.period)),str(p.comparison).toLowerCase(),n(p.persistDays,1),id.endsWith('EMA')?'extreme_reset':'every_close');}
  else if(id==='EMA_SHAKEOUT'){const averages=ema(series.close,n(p.period,21)),within=n(p.withinDays,3),start=Math.max(0,series.close.length-within);result=series.close.length<n(p.period)+within?null:Array.from({length:within},(_,j)=>start+j).some(i=>series.low[i]<averages[i]&&last(series.close)>last(averages));}
  else if(id==='ADX'){result=comparison(last(adx(series,n(p.period,14)).adx),p);}
  else if(id==='PCT_DAYS_ABOVE_MA'){const av=moving(series,str(p.maType,'SMA'),n(p.period,50)),days=n(p.overDays,125);result=series.close.length<days?null:compare(100*Array.from({length:days},(_,j)=>series.close.length-days+j).filter(i=>series.close[i]>av[i]).length/days,p.comparison,p.pct);}
  else if(id==='MA_STACK'){const periods=String(p.periods).split(',').map(Number),values=periods.map(period=>last(moving(series,str(p.maType,'SMA'),period)));result=values.some(v=>!Number.isFinite(v))?null:values.every((v,i)=>!i||values[i-1]>v)&&(!p.priceAbove||last(series.close)>values[0]);}
  else if(id==='MA_SLOPE'){const av=moving(series,str(p.maType,'SMA'),n(p.period)),days=n(p.overDays,21);result=av.length<=days?null:compare(percentChange(last(av),last(av,days)),p.comparison,p.minChangePct);}
  else if(id==='PRICE_CHANGE_PCT'){const days=n(p.overDays);result=series.close.length<=days?null:compare(percentChange(last(series.close),last(series.close,days)),p.comparison,str(p.comparison)==='BELOW'?-Math.abs(n(p.pct)):n(p.pct));}
  else if(id==='CONSECUTIVE_UP_DAYS'){const needed=n(p.minDays),flags=Array.from({length:series.close.length},(_,i)=>i>=needed&&Array.from({length:needed},(_,j)=>series.close[i-j]>series.close[i-j-1]).every(Boolean));result=event(flags,n(p.withinDays,1));}
  else if(id==='GAP_UP'||id==='GAP_DOWN'){const flags=Array.from({length:series.close.length},(_,i)=>i?percentChange(series.open[i],series.close[i-1])*(id==='GAP_UP'?1:-1)>=n(p.minGapPct):null);result=event(flags,n(p.withinDays,1));}
  else if(id==='VOLUME_VS_AVG'){const period=n(p.avgDays,20),flags=Array.from({length:series.volume.length},(_,i)=>i<period?null:series.volume[i]/mean(slice(series.volume,i-period,i))>=n(p.multiple));result=event(flags,n(p.withinDays,1));}
  else if(id==='AVG_VOLUME_RATIO'){const recent=n(p.recentDays),base=n(p.baseDays);result=series.volume.length<Math.max(recent,base)?null:compare(mean(slice(series.volume,-recent))/mean(slice(series.volume,-base)),p.comparison,p.ratio);}
  else if(id==='HIGHEST_VOLUME_IN_N_DAYS'){const look=n(p.lookbackDays),flags=Array.from({length:series.volume.length},(_,i)=>i+1<look?null:series.volume[i]>=max(slice(series.volume,i+1-look,i+1))&&(!p.positiveClose||series.close[i]>series.close[i-1]));result=event(flags,n(p.withinDays,1));}
  else if(id==='DELIVERY_PCT_SPIKE'||id==='DELIVERY_PERCENT'){const item=context.delivery?.find(row=>row.date===context.session),value=n(item?.delivery_percent,NaN);result=Number.isFinite(value)?compare(value,p.comparison??'ABOVE',p.minDeliverablePct??p.value):null;}
  else if(id==='NEW_HIGH'||id==='NEW_LOW'){const look=n(p.lookbackDays),source=id==='NEW_HIGH'?series.high:series.low,flags=Array.from({length:source.length},(_,i)=>i+1<look?null:id==='NEW_HIGH'?source[i]>=max(slice(source,i+1-look,i+1)):source[i]<=min(slice(source,i+1-look,i+1)));result=event(flags,n(p.withinDays,1));}
  else if(id==='PCT_FROM_52W_HIGH'||id==='PCT_FROM_52W_LOW'){const source=id.endsWith('HIGH')?series.high:series.low,extreme=id.endsWith('HIGH')?max(slice(source,-252)):min(slice(source,-252)),distance=id.endsWith('HIGH')?(extreme-last(series.close))/extreme*100:(last(series.close)-extreme)/extreme*100;result=compare(distance,p.comparison,p.pct);}
  else if(id==='CONSOLIDATION_RANGE'){const end=series.close.length-n(p.excludeLatest),start=end-n(p.lookbackDays);result=start<0?null:(max(slice(series.high,start,end))-min(slice(series.low,start,end)))/series.close[end-1]*100<=n(p.maxRangePct);}
  else if(id==='ATR_PCT'){const value=last(atr(series,n(p.period,14)))/last(series.close)*100;result=comparison(value,p,'pct');}
  else if(id==='RANGE_CONTRACTION'){const recent=n(p.recentDays),prior=n(p.priorDays),mode=str(p.priorMode,'NESTED').toUpperCase(),required=mode==='PRIOR'?recent+prior:Math.max(recent,prior);if(series.close.length<required)result=null;else{const rw=max(slice(series.high,-recent))-min(slice(series.low,-recent)),start=mode==='PRIOR'?series.close.length-recent-prior:series.close.length-prior,end=mode==='PRIOR'?series.close.length-recent:series.close.length,pw=max(slice(series.high,start,end))-min(slice(series.low,start,end));result=pw>0?rw/pw<=n(p.maxRatio):null;}}
  else if(id==='INSIDE_BAR'){let highs=Array.from(series.high),lows=Array.from(series.low);if(str(p.timeframe).toUpperCase()==='WEEKLY'){const weeks=new Map<string,{h:number;l:number}>();series.dates.forEach((day,i)=>{const key=isoWeekKey(day),bar=weeks.get(key)??{h:-Infinity,l:Infinity};bar.h=Math.max(bar.h,highs[i]);bar.l=Math.min(bar.l,lows[i]);weeks.set(key,bar);});const bars=[...weeks.values()];if(str(p.weeklyMode,'COMPLETED').toUpperCase()==='COMPLETED')bars.pop();highs=bars.map(x=>x.h);lows=bars.map(x=>x.l);}const count=n(p.consecutive,1);result=highs.length<count+1?null:Array.from({length:count},(_,j)=>{const i=highs.length-count+j;return highs[i]<=highs[i-1]&&lows[i]>=lows[i-1];}).every(Boolean);}
  else if(id==='UNFILLED_GAP'){const within=n(p.withinDays,60),direction=str(p.direction).toUpperCase(),wanted=str(p.state,'UNFILLED').toUpperCase();result=false;for(let i=Math.max(1,series.close.length-within);i<series.close.length;i++){const gap=percentChange(series.open[i],series.close[i-1]),qualifies=direction==='UP'?gap>=n(p.minGapPct):gap<=-n(p.minGapPct);if(!qualifies)continue;const filled=direction==='UP'?slice(series.low,i+1).some(v=>v<=series.close[i-1]):slice(series.high,i+1).some(v=>v>=series.close[i-1]);if((wanted==='FILLED')===filled)result=true;}}
  else if(id==='VCP_LEGS'){const start=Math.max(0,series.close.length-n(p.lookbackDays,120)),pivots=zigzag(series,start,n(p.minSwingPct,1.5)),legs=pivots.slice(1).map((point,i)=>Math.abs(point[1]-pivots[i][1])/pivots[i][1]*100),count=n(p.minLegs,3),latest=legs.slice(-count);result=latest.length<count?null:latest[latest.length-1]<=n(p.maxFinalLegPct,8)&&latest.slice(1).every((v,i)=>v/latest[i]<=n(p.maxLegRatio,.8));}
  else if(id==='HORIZONTAL_RESISTANCE_LINE'){const start=Math.max(0,series.close.length-n(p.lookbackDays,252)),pivots=zigzag(series,start,n(p.minSwingPct,1.5)).filter(x=>x[2]==='high'),candidate=[...pivots].reverse().find(([i,price])=>!slice(series.close,i+1).some(v=>v>price));if(!candidate)result=false;else{const [i,line]=candidate,base=slice(series.low,i),depth=(line-min(base))/line*100,below=(line-last(series.close))/line*100,e20=last(ema(series.close,20)),belowEma=(e20-last(series.close))/e20*100,length=series.close.length-1-i;result=length>=n(p.minBaseLengthDays,15)&&length<=n(p.maxBaseLengthDays,400)&&depth>=n(p.minBaseDepthPct)&&depth<=n(p.maxBaseDepthPct,60)&&below<=n(p.maxPctBelowLine,5)&&belowEma<=n(p.maxPctBelow20Ema,2);}}
  else if(id==='MA_CONVERGENCE'){const periods=str(p.periods).split(',').map(Number),type=str(p.maType,'EMA'),sets=periods.map(period=>moving(series,type,period)),within=n(p.withinDays,1),flags=Array.from({length:series.close.length},(_,i)=>{const values=sets.map(v=>v[i]);return values.every(Number.isFinite)&&series.close[i]>0?compare((max(values)-min(values))/series.close[i]*100,p.comparison??'BELOW',p.maxSpreadPct??1.5):null;});result=event(flags,within);}
  else if(id==='SUPERTREND'){const st=supertrend(series,n(p.period,10),n(p.multiplier,3)),wanted=str(p.direction,'BULLISH').toUpperCase()==='BULLISH'?1:-1,state=st.direction.map(value=>value?value===wanted:null),flags=str(p.signal,'STATE').toUpperCase()==='TURN'?state.map((v,i)=>i?Boolean(v&&!state[i-1]):null):state;result=event(flags,n(p.withinDays,1));}
  else if(id==='INDICATOR_COMPARE'){const left=indicator(series,str(p.leftIndicator,'RSI'),n(p.leftPeriod,14)),right=str(p.rightIndicator)?indicator(series,str(p.rightIndicator),n(p.rightPeriod,20)):Array(series.close.length).fill(n(p.rightValue)),lo=n(p.leftOffset),ro=n(p.rightOffset),op=str(p.op,'ABOVE').toUpperCase(),flags=Array.from({length:series.close.length},(_,i)=>{const a=left[i-lo],b=right[i-ro];if(!Number.isFinite(a)||!Number.isFinite(b))return null;if(op==='CROSSES_ABOVE'||op==='CROSSES_BELOW'){const pa=left[i-lo-1],pb=right[i-ro-1];if(!Number.isFinite(pa)||!Number.isFinite(pb))return null;return op==='CROSSES_ABOVE'?a>b&&pa<=pb:a<b&&pa>=pb;}return compare(a,op,b);});result=event(flags,n(p.withinDays,1));}
  else if(id==='DIVERGENCE'){
    const osc=indicator(series,str(p.oscillator,'RSI'),n(p.oscPeriod,14)),look=n(p.lookbackDays,120),left=n(p.pivotLeft,5),right=n(p.pivotRight,3),maxGap=n(p.maxBarDifference,1),bull=str(p.direction,'BULLISH').toUpperCase()==='BULLISH',hidden=str(p.variant,'REGULAR').toUpperCase()==='HIDDEN',price=bull?series.low:series.high,start=Math.max(0,series.close.length-look-right-left);
    const pivots=(values:ArrayLike<number>)=>{const found:Array<[number,number,number]>=[];for(let i=Math.max(left,start);i<series.close.length-right;i++){const window=slice(values,i-left,i+right+1),value=values[i];if(window.some(v=>!Number.isFinite(v)))continue;const extreme=bull?min(window):max(window);if(value===extreme&&window.filter(v=>v===value).length===1)found.push([i,value,i+right]);}return found;};
    const pricePivots=pivots(price),oscillatorPivots=pivots(osc),used=new Set<number>(),aligned:Array<[number,number,number,number]>=[];
    for(const [priceIndex,priceValue,confirmed] of pricePivots){const options=oscillatorPivots.filter(item=>!used.has(item[0])&&Math.abs(item[0]-priceIndex)<=maxGap).sort((a,b)=>Math.abs(a[0]-priceIndex)-Math.abs(b[0]-priceIndex));if(options.length){const chosen=options[0];used.add(chosen[0]);aligned.push([priceIndex,priceValue,chosen[1],Math.max(confirmed,chosen[2])]);}}
    const flags=Array<Truth>(series.close.length).fill(false);
    for(let j=1;j<aligned.length;j++){const a=aligned[j-1],b=aligned[j],regular=bull?b[1]<a[1]&&b[2]>a[2]:b[1]>a[1]&&b[2]<a[2],hiddenMatch=bull?b[1]>a[1]&&b[2]<a[2]:b[1]<a[1]&&b[2]>a[2];if(!(hidden?hiddenMatch:regular)||b[3]>=flags.length)continue;const broken=p.invalidateOnBreak!==false&&slice(price,b[0]+1,b[3]+1).some(value=>bull?value<b[1]:value>b[1]);if(!broken)flags[b[3]]=true;}
    result=event(flags,n(p.withinDays,8));
  }
  else if(id==='RELATIVE_STRENGTH'||id==='RS_NEW_HIGH'){const benchmark=context.benchmarks?.[str(p.benchmark,'NIFTY_50').toUpperCase()];if(!benchmark)result=null;else{const byDate=new Map(benchmark.dates.map((date,i)=>[date,benchmark.closes[i]])),pairs=Array.from(series.dates,(_,i)=>[series.close[i],byDate.get(series.dates[i])] as const).filter((pair):pair is readonly[number,number]=>pair[1]!=null);const days=n(p.overDays??p.lookbackDays,60);if(pairs.length<=days)result=null;else if(id==='RELATIVE_STRENGTH'){const latest=pairs[pairs.length-1],prior=pairs[pairs.length-1-days],spread=percentChange(latest[0],prior[0])-percentChange(latest[1],prior[1]);result=compare(spread,p.comparison,p.pct??p.value);}else{const rs=pairs.slice(-days).map(pair=>pair[0]/pair[1]),price=slice(series.high,-days),distance=(max(price)-last(series.close))/max(price)*100;result=last(rs)>=max(rs)&&distance>=n(p.minPriceBelowHighPct);}}}
  else if(id==='AVG_TURNOVER'){const days=n(p.lookbackDays,20);result=series.close.length<days?null:compare(mean(Array.from({length:days},(_,j)=>{const i=series.close.length-days+j;return series.close[i]*series.volume[i]/1e7;})),p.comparison,p.valueCr);}
  else if(id==='ADR_PCT'){const days=n(p.lookbackDays,14);result=series.close.length<days?null:compare(mean(Array.from({length:days},(_,j)=>{const i=series.close.length-days+j;return (series.high[i]-series.low[i])/series.close[i]*100;})),p.comparison,p.pct);}
  else if(id==='DAYS_SINCE_EARNINGS'||id==='LISTING_AGE_DAYS'){const marker=id==='DAYS_SINCE_EARNINGS'?context.stock.earningsDate:context.stock.listingDate;if(!marker)result=null;else{const day=Math.floor(Date.parse(marker+'T00:00:00Z')/86400000),sessions=Array.from(series.dates).filter(value=>value>day).length;result=compare(sessions,p.comparison,p.days);}}
  else if(id==='EARNINGS_GROWTH'){const records=[...(context.earnings??[])].sort((a,b)=>String(b.period_end??b.periodEnd??'').localeCompare(String(a.period_end??a.periodEnd??''))),metric=str(p.metric,'NET_PROFIT').toLowerCase(),field:Record<string,string[]>= {net_profit:['net_profit','netProfit'],revenue:['revenue','totalIncome'],pbt:['pbt','profitBeforeTax'],eps:['basic_eps','basicEps'],opm:['opm','operatingMarginPercent']},keys=field[metric]??[metric],pick=(row:Record<string,unknown>)=>{for(const key of keys){const value=n(row[key],NaN);if(Number.isFinite(value))return value;}return NaN;},gap=str(p.basis,'YOY').toUpperCase()==='YOY'?4:1;if(records.length<=gap)result=null;else{const current=pick(records[0]),prior=pick(records[gap]),growth=metric==='opm'?current-prior:prior!==0?(current/prior-1)*100:NaN;result=Number.isFinite(growth)?compare(growth,p.comparison,p.pct):null;}}
  else if(id==='MARKET_BREADTH'){const universe=str(p.universe,'ALL_ACTIVE').toLowerCase().replace('niftymidsmall400','niftymidsmall400').replace('nifty50','nifty50'),metric=str(p.metric).replace(/[A-Z]/g,m=>'_'+m.toLowerCase()),value=context.breadth?.[universe]?.[metric];result=value==null?null:compare(value,p.comparison,p.value);}
  return condition.isNegated?negate(result):result;
}

function evaluateLegacySpecial(series:CandleSeries,condition:ActiveCondition,context:AdvancedContext):Truth|undefined{
  const id=condition.conditionId,p=condition.parameters,stock=context.stock;
  if(id==='mom_rvol'){const period=20,value=series.volume.length>period?last(series.volume)/mean(slice(series.volume,-period-1,-1)):NaN;return Number.isFinite(value)?value>=n(p.minRvol,1.5)&&value<=n(p.maxRvol,20):null;}
  if(id==='mom_return'){const days=Number(str(p.period,'1D').replace('D','')),value=series.close.length>days?percentChange(last(series.close),last(series.close,days)):NaN;return Number.isFinite(value)?value>=n(p.minReturn)&&value<=n(p.maxReturn,100):null;}
  if(id==='fund_pe_ratio'){const value=stock.peRatio;return typeof value==='number'?value>=n(p.minPe)&&value<=n(p.maxPe,Number.MAX_SAFE_INTEGER):null;}
  if(id==='liq_market_cap'){const value=stock.marketCapCrore;return typeof value==='number'?value>=n(p.minMarketCap)&&value<=n(p.maxMarketCap,Number.MAX_SAFE_INTEGER):null;}
  if(id==='fund_roe')return typeof stock.roePct==='number'?stock.roePct>=n(p.minRoe):null;
  if(id==='fund_free_float'){const value=stock.freeFloatPct;return typeof value==='number'?value>=n(p.minFloat)&&value<=n(p.maxFloat,100):null;}
  if(id==='misc_fno_only')return stock.isFno==null?null:stock.isFno===(p.isFno==='true');
  if(id==='misc_exclude_circuit')return stock.circuitLimit?!(p.circuitBands as unknown[]).map(String).includes(stock.circuitLimit.replace('%','')):null;
  if(id==='rs_divergence'){const strength=evaluateHistoryCondition(series,{...condition,conditionId:'RELATIVE_STRENGTH',isNegated:false,parameters:{benchmark:'NIFTY_50',overDays:60,comparison:'ABOVE',pct:n(p.minRsVsNifty,10)}},context),distance=typeof stock.dist52wHighPct==='number'?Math.abs(stock.dist52wHighPct)>=n(p.minBelowHigh,2):null;return strength===false||distance===false?false:strength===null||distance===null?null:true;}
  return undefined;
}

function translateLegacy(condition:ActiveCondition):ActiveCondition{
  const p=condition.parameters,id=condition.conditionId,make=(conditionId:string,parameters:Record<string,unknown>):ActiveCondition=>({...condition,conditionId,parameters});
  if(id==='trend_price_vs_ma')return make(`PRICE_VS_${str(p.maType,'SMA').toUpperCase()}`,{period:n(p.maPeriod,50),comparison:str(p.operator,'above').toUpperCase(),persistDays:1});
  if(id==='trend_ma_stack'){const order=str(p.stackOrder);return make('MA_STACK',{periods:order==='bearish_stack'?'200,50,20':order==='10_above_20_above_50'?'10,20,50':'20,50,200',maType:order==='10_above_20_above_50'?'SMA':'EMA',priceAbove:false});}
  if(id==='trend_ma_slope')return make('MA_SLOPE',{period:n(p.targetMa,50),maType:'SMA',overDays:20,comparison:'ABOVE',minChangePct:n(p.minSlopePct,1.5)});
  if(id==='trend_persistent_momentum')return make('PRICE_VS_EMA',{period:20,comparison:'ABOVE',persistDays:n(p.minDaysAboveEMA,10)});
  if(id==='trend_ema_reclaim')return make('EMA_SHAKEOUT',{period:Number(str(p.reclaimedEma,'EMA 20').split(' ').at(-1)),withinDays:n(p.reclaimedWithin,3)});
  if(id==='trend_pct_days_above_ma')return make('PCT_DAYS_ABOVE_MA',{period:50,maType:'SMA',overDays:50,comparison:'ABOVE',pct:n(p.minPctDays,80)});
  if(id==='mom_consecutive_up')return make('CONSECUTIVE_UP_DAYS',{minDays:n(p.minConsecutiveDays,3),withinDays:1});
  if(id==='mom_rvol')return make('VOLUME_VS_AVG',{avgDays:20,multiple:n(p.minRvol,1.5),withinDays:1});
  if(id==='mom_return')return make('PRICE_CHANGE_PCT',{overDays:Number(str(p.period,'1D').replace('D','')),comparison:'ABOVE',pct:n(p.minReturn)});
  if(id==='mom_gap')return make(str(p.gapType)==='Gap Down'?'GAP_DOWN':'GAP_UP',{minGapPct:n(p.minGapPct,2),withinDays:1});
  if(id==='mom_delivery_vol')return make('DELIVERY_PCT_SPIKE',{minDeliverablePct:n(p.minDeliveryPct,50)});
  if(id==='range_52w_proximity')return make(str(p.target)==='Low'?'PCT_FROM_52W_LOW':'PCT_FROM_52W_HIGH',{comparison:'BELOW',pct:n(p.maxDistancePct,5)});
  if(id==='range_contraction')return make('RANGE_CONTRACTION',{recentDays:n(p.shortPeriod,10),priorDays:60,priorMode:'PRIOR',maxRatio:n(p.maxRatio,.5)});
  if(id==='range_inside_bar')return make('INSIDE_BAR',{timeframe:str(p.timeframe,'DAILY'),consecutive:n(p.consecutive,1)});
  if(id==='rs_rating'||id==='rs_1month'||id==='rs_3month')return make('RS_RATING',{window:id==='rs_rating'?'FRONT_WEIGHTED':id==='rs_1month'?'ONE_MONTH':'THREE_MONTH',comparison:'ABOVE',value:n(p.minRsRating,80)});
  if(id==='rs_divergence')return make('RELATIVE_STRENGTH',{benchmark:'NIFTY_50',overDays:60,comparison:'ABOVE',pct:n(p.minRsVsNifty,10)});
  if(id==='fund_earnings_growth')return make('EARNINGS_GROWTH',{metric:'NET_PROFIT',basis:'YOY',comparison:'ABOVE',pct:n(p.minGrowthPct,20),reportType:'PREFER_CONSOLIDATED',maxAgeDays:200});
  if(id==='fund_pe_ratio')return make('PE_RATIO',{comparison:'ABOVE',value:n(p.minPe),reportType:'PREFER_CONSOLIDATED'});
  if(id==='liq_market_cap')return make('MARKETCAP',{comparison:'ABOVE',valueCr:n(p.minMarketCap),reportType:'PREFER_CONSOLIDATED'});
  if(id==='liq_turnover')return make('AVG_TURNOVER',{comparison:'ABOVE',lookbackDays:50,valueCr:n(p.minTurnoverCr,5)});
  if(id==='fund_stock_price')return make('PRICE_RANGE',{minPrice:n(p.minPrice),maxPrice:Number.MAX_SAFE_INTEGER});
  return condition;
}
