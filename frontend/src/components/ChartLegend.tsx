import type { CSSProperties, Ref } from 'react';
import { marketOpen } from '../chart/marketHours';
import { SymbolWithLogo } from './SymbolWithLogo';
import type { Candle } from '../chart/model';
import type { StockRow } from '../types/screener';

const price=new Intl.NumberFormat('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const metric=new Intl.NumberFormat('en-IN',{maximumFractionDigits:2});
const date=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
export function candleValues(bar:Candle,previous?:Candle) {
  const change=previous && previous.close!==0?(bar.close/previous.close-1)*100:null;
  const volume=bar.volume;
  const compact=volume===null?'-':volume>=1e7?`${metric.format(volume/1e7)}Cr`:volume>=1e5?`${metric.format(volume/1e5)}L`:volume>=1e3?`${metric.format(volume/1e3)}K`:metric.format(volume);
  return {date:date.format(new Date(`${bar.date}T00:00:00Z`)),open:price.format(bar.open),high:price.format(bar.high),low:price.format(bar.low),close:price.format(bar.close),
    change:change===null?'-':`${change>=0?'+':''}${change.toFixed(2)}%`,volume:compact,tone:change===null||change===0?'flat':change>0?'up':'down'};
}
/** Keep pointer-driven quote updates out of React's render loop. */
export function updateCandleValues(output:HTMLOutputElement,bar:Candle,previous?:Candle) {
  const values=candleValues(bar,previous);
  for (const field of output.querySelectorAll<HTMLElement>('[data-quote]')) {
    const key=field.dataset.quote as keyof typeof values;
    field.textContent=values[key];
    if (key==='change') field.dataset.tone=values.tone;
  }
}
export type ChartMetrics=Pick<StockRow,'marketCapCrore'|'freeFloatPct'|'circuitLimit'>&Partial<Pick<StockRow,'name'|'sector'|'industry'|'nicheTags'|'isFno'|'surveillanceAvailable'|'surveillanceAsOfDate'|'isAsm'|'asmStage'|'isGsm'|'gsmStage'|'listingDate'>>;
/** What the status line shows; each maps to a Chart settings → Status line option. */
export interface StatusLineOptions {
  logo:boolean;title:boolean;titleMode:'symbol'|'description'|'ticker';marketStatus:boolean;ohlc:boolean;change:boolean;volume:boolean;
  interval?:string;name?:string;background?:{color?:string;opacity:number};
}
const DEFAULT_STATUS:StatusLineOptions={logo:true,title:true,titleMode:'symbol',marketStatus:true,ohlc:true,change:true,volume:true};
export function ChartLegend({symbol,bar,previous,metrics,sessionDate,quoteRef,status=DEFAULT_STATUS}:{symbol:string;bar:Candle;previous?:Candle;metrics?:ChartMetrics;sessionDate?:string;quoteRef?:Ref<HTMLOutputElement>;status?:StatusLineOptions}) {
  const values=candleValues(bar,previous);
  const cap=metrics?.marketCapCrore;
  const float=metrics?.freeFloatPct;
  const validCap=typeof cap==='number' && Number.isFinite(cap) && cap>0;
  const floatCap=validCap && typeof float==='number' && Number.isFinite(float) && float>=0 && float<=100?cap*float/100:null;
  const circuit=typeof metrics?.circuitLimit==='string' && /^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(metrics.circuitLimit)?Number.parseFloat(metrics.circuitLimit):null;
  const noBand=typeof metrics?.circuitLimit==='string' && metrics.circuitLimit.trim().toLowerCase()==='no band';
  const hasMetrics=validCap || floatCap!==null || (circuit!==null && circuit>0 && circuit<=100) || noBand;
  const title=status.titleMode==='description'?(status.name||metrics?.name||symbol):status.titleMode==='ticker'?`NSE:${symbol}`:symbol;
  const open=marketOpen();
  // No chosen colour follows the theme surface, so the plate stays readable in light and dark.
  const opacity=Math.round(Math.max(0,Math.min(1,status.background?.opacity??.8))*100);
  const plate:CSSProperties|undefined=status.background?{background:`color-mix(in srgb, ${status.background.color?.slice(0,7)??'var(--surface)'} ${opacity}%, transparent)`}:undefined;
  return <div className={`chart-legend${plate?' has-plate':''}`} style={plate}>
    <output className="chart-readout" ref={quoteRef} aria-label={`${symbol} candle values`}>
      {(status.logo||status.title||status.marketStatus)&&<span className="chart-status-title">
        {status.logo&&<SymbolWithLogo symbol={symbol} showText={false} className="chart-status-logo" />}
        {status.title&&<b>{title}</b>}
        {status.title&&status.interval&&<span className="chart-status-interval">· {status.interval}</span>}
        {status.marketStatus&&<span className="chart-status-market" data-open={open} title={open?'NSE market open':'NSE market closed'} aria-label={open?'Market open':'Market closed'} />}
      </span>}
      {status.ohlc&&(['open','high','low','close'] as const).map((key,index)=><span className="chart-quote-price" key={key}><span>{['O','H','L','C'][index]}</span><b data-quote={key}>{values[key]}</b></span>)}
      {status.change&&<b className="chart-quote-change" data-quote="change" data-tone={values.tone}>{values.change}</b>}
      {status.volume&&<span className="chart-quote-volume"><span>Vol</span><span data-quote="volume">{values.volume}</span></span>}
      <span className="chart-quote-date" data-quote="date">{values.date}</span>
    </output>
    {hasMetrics && <div className="chart-symbol-strip" role="group" tabIndex={0} aria-label={`${symbol} snapshot metrics`} title={sessionDate?`Published snapshot: ${sessionDate}. Metrics are not historical.`:undefined}>
      {validCap && <span className="chart-pill-metric"><span className="chart-metric-label">MCap</span><b>₹{metric.format(cap)} Cr</b></span>}
      {floatCap!==null && <span className="chart-pill-metric"><span className="chart-metric-label">Free float</span><b>₹{metric.format(floatCap)} Cr</b></span>}
      {circuit!==null && circuit>0 && circuit<=100 && <span className="chart-pill-metric" title="Price circuit band (%)"><span className="chart-metric-label">Circuit</span><b data-tight={circuit<=5}>{metric.format(circuit)}%</b></span>}
      {noBand && <span className="chart-pill-metric"><span className="chart-metric-label">Circuit</span><b>No band</b></span>}
    </div>}
  </div>;
}
