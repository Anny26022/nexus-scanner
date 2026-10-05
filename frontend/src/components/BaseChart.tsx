import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import type { ChartSnapshot } from '../api/realAdapter';
import type { BaseRecord } from '../engine/baseConditions';

function finite(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)?value:null;}
function facts(record:BaseRecord|undefined):BaseRecord{return record?.base&&typeof record.base==='object'?record.base as BaseRecord:{};}
export function chartGeometry(chart:ChartSnapshot,record?:BaseRecord){
  const base=facts(record),start=String(base.startDate??'');
  const from=chart.candles.findIndex(c=>c.date>=start);
  const candles=chart.candles.slice(start&&from>=0?Math.max(0,from-20):-252);
  if(!candles.length)return null;
  const pivot=finite(record?.pivot),floor=finite(base.floor);
  const high=Math.max(...candles.map(c=>c.high),pivot??-Infinity),low=Math.min(...candles.map(c=>c.low),floor??Infinity);
  const width=800,left=55,right=785,top=20,bottom=270;
  const x=(index:number)=>left+(index+.5)*(right-left)/candles.length;
  const y=(price:number)=>bottom-(price-low)/(high-low||1)*(bottom-top);
  const volumeMax=Math.max(...candles.map(c=>c.volume),1);
  const startIndex=candles.findIndex(c=>c.date>=start),endIndex=candles.reduce((last,c,i)=>c.date<=String(base.endDate??'')?i:last,-1);
  const breakout=record?.breakout as BaseRecord|undefined,breakoutIndex=candles.findIndex(c=>c.date===breakout?.date);
  return {candles,width,left,right,top,bottom,x,y,volumeMax,pivot,floor,startIndex,endIndex,breakoutIndex,barWidth:Math.max(.5,(right-left)/candles.length*.65)};
}
const display=(value:unknown,suffix='')=>finite(value)===null?'—':`${(value as number).toFixed(2)}${suffix}`;
export function BaseChartPlot({chart,record}:{chart:ChartSnapshot;record?:BaseRecord}){
  const geometry=chartGeometry(chart,record);
  if(!geometry)return <p className="p-8 text-center text-sm text-slate-500">No candle history available.</p>;
  const g=geometry,base=facts(record);
  return <>
    <svg viewBox="0 0 800 360" role="img" aria-label={`${chart.symbol} daily candles with detected base and pivot`} className="w-full">
      {[0,.25,.5,.75,1].map(t=>{const price=g.candles.reduce((m,c)=>Math.max(m,c.high),g.pivot??0);return <g key={t}><line x1={g.left} x2={g.right} y1={g.top+t*(g.bottom-g.top)} y2={g.top+t*(g.bottom-g.top)} stroke="#e2e8f0"/><text x={5} y={g.top+t*(g.bottom-g.top)+4} fontSize={10} fill="#64748b">{(price-t*(price-Math.min(...g.candles.map(c=>c.low),g.floor??Infinity))).toFixed(0)}</text></g>;})}
      {g.pivot!==null&&g.floor!==null&&g.startIndex>=0&&g.endIndex>=g.startIndex&&<rect data-testid="base-range" x={g.x(g.startIndex)-g.barWidth} y={g.y(g.pivot)} width={Math.max(1,g.x(g.endIndex)-g.x(g.startIndex)+g.barWidth*2)} height={Math.max(1,g.y(g.floor)-g.y(g.pivot))} fill="#0d9488" fillOpacity={.08} stroke="#0d9488" strokeDasharray="4 3"/>}
      {g.candles.map((c,i)=>{const color=c.close>=c.open?'#059669':'#e11d48';return <g key={c.date}><title>{`${c.date}: O ${c.open}, H ${c.high}, L ${c.low}, C ${c.close}, V ${c.volume}`}</title><line x1={g.x(i)} x2={g.x(i)} y1={g.y(c.high)} y2={g.y(c.low)} stroke={color}/><rect x={g.x(i)-g.barWidth/2} y={Math.min(g.y(c.open),g.y(c.close))} width={g.barWidth} height={Math.max(1,Math.abs(g.y(c.open)-g.y(c.close)))} fill={color}/><rect x={g.x(i)-g.barWidth/2} y={330-c.volume/g.volumeMax*45} width={g.barWidth} height={c.volume/g.volumeMax*45} fill={color} opacity={.4}/></g>;})}
      {g.pivot!==null&&<g><line data-testid="base-pivot" x1={g.left} x2={g.right} y1={g.y(g.pivot)} y2={g.y(g.pivot)} stroke="#0d9488" strokeDasharray="5 3"/><text x={g.right} y={g.y(g.pivot)-5} textAnchor="end" fontSize={10} fill="#0f766e">Pivot ₹{g.pivot.toFixed(2)}</text></g>}
      {g.breakoutIndex>=0&&<g><line data-testid="base-breakout" x1={g.x(g.breakoutIndex)} x2={g.x(g.breakoutIndex)} y1={g.top} y2={g.bottom} stroke="#6366f1" strokeDasharray="3 3"/><text x={g.x(g.breakoutIndex)} y={12} fontSize={10} fill="#4f46e5">Breakout</text></g>}
      <text x={g.left} y={350} fontSize={10} fill="#64748b">{g.candles[0].date}</text><text x={g.right} y={350} textAnchor="end" fontSize={10} fill="#64748b">{g.candles.at(-1)?.date}</text>
    </svg>
    {record&&<p className="border-t border-slate-100 pt-3 text-xs text-slate-600">Depth {display(base.depthPct,'%')} · ATR contraction {display(base.atrContraction,'×')} · Volume dry-up {display(base.volumeDryUp,'×')} · Base RS {display(base.rsAverage)} · Pivot distance {display(record.distanceFromPivotPct,'%')}</p>}
  </>;
}
export function BaseChartDialog({symbol,revision,onClose}:{symbol:string;revision:string;onClose:()=>void}){
  const [stage,setStage]=useState<string|null>(null);
  const query=useQuery({queryKey:['chart',revision,symbol],queryFn:()=>screenerApi.getChart(symbol,revision),staleTime:Infinity,retry:1});
  const stages=['FRESH_BREAKOUT','HOLDING','FORMING','PLAYED_OUT'].filter(key=>query.data?.bases?.[key as keyof NonNullable<ChartSnapshot['bases']>]);
  const selected=stage&&stages.includes(stage)?stage:stages[0];
  const record=query.data?.bases?.[selected as keyof NonNullable<ChartSnapshot['bases']>];
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="base-chart-title" className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-xl bg-white p-5 shadow-xl" onClick={event=>event.stopPropagation()} onKeyDown={event=>{
      if(event.key==='Escape')onClose();
      if(event.key==='Tab'){
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,select,[tabindex="0"]'));
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
      <header className="mb-3 flex items-center justify-between gap-3"><h2 id="base-chart-title" className="font-semibold">{symbol} · Daily chart</h2><div className="flex items-center gap-3">{stages.length>0&&<select aria-label="Base stage" value={selected} onChange={event=>setStage(event.target.value)} className="rounded border border-slate-200 px-2 py-1 text-xs">{stages.map(key=><option key={key} value={key}>{key.replaceAll('_',' ').toLowerCase()}</option>)}</select>}<button autoFocus onClick={onClose} aria-label="Close chart" className="rounded px-2 py-1 text-slate-500">✕</button></div></header>
      {query.isPending?<p className="py-12 text-center text-sm text-slate-500">Loading chart…</p>:query.isError?<p role="alert" className="py-12 text-center text-sm text-rose-700">{query.error.message}</p>:<BaseChartPlot chart={query.data} record={record}/>}
    </section>
  </div>;
}
