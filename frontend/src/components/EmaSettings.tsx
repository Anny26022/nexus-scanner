import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { defaultEmaLines, validEmaLine, type EmaLine } from '../chart/model';

export const EMA_PREFS_KEY='nexus.chart.ema.v1';
export function loadEmaLines():EmaLine[] {
  try {
    const value:unknown=JSON.parse(localStorage.getItem(EMA_PREFS_KEY)??'null');
    if (Array.isArray(value) && value.length<=5 && value.every(validEmaLine)
      && new Set(value.map(line=>line.id)).size===value.length) return value;
  } catch { /* Preference storage is optional; chart data is not. */ }
  return defaultEmaLines();
}

export function EmaSettings({lines,onApply}:{lines:readonly EmaLine[];onApply:(lines:EmaLine[])=>void}) {
  const [draft,setDraft]=useState(()=>lines.map(line=>({...line})));
  const [error,setError]=useState('');
  const update=(id:string,change:Partial<EmaLine>)=>setDraft(current=>current.map(line=>line.id===id?{...line,...change}:line));
  return <form className="ema-settings" aria-label="EMA settings" onSubmit={event=>{
    event.preventDefault();
    if (!draft.every(validEmaLine)) { setError('Use periods 1–500 and valid line settings.'); return; }
    setError(''); onApply(draft);
  }}>
    {draft.map((line,index)=><fieldset key={line.id} className="ema-setting-row">
      <legend>EMA {index+1}</legend>
      <div className="ema-setting-main">
        <label className="ema-enable"><input type="checkbox" aria-label={`Enable EMA ${index+1}`} checked={line.enabled} onChange={event=>update(line.id,{enabled:event.target.checked})}/>EMA</label>
        <input type="number" aria-label={`EMA ${index+1} period`} value={Number.isFinite(line.period)?line.period:''} min={1} max={500} step={1} required onChange={event=>update(line.id,{period:event.target.valueAsNumber})}/>
        <input type="color" aria-label={`EMA ${index+1} color`} value={line.color} onChange={event=>update(line.id,{color:event.target.value})}/>
        <button type="button" aria-label={`Remove EMA ${index+1}`} onClick={()=>setDraft(current=>current.filter(item=>item.id!==line.id))}><X size={14}/></button>
      </div>
      <div className="ema-setting-style">
        <label>Width<select aria-label={`EMA ${index+1} width`} value={line.width} onChange={event=>update(line.id,{width:Number(event.target.value)})}>{[1,2,3,4].map(width=><option key={width} value={width}>{width}px</option>)}</select></label>
        <label>Line<select aria-label={`EMA ${index+1} style`} value={line.style} onChange={event=>update(line.id,{style:event.target.value as EmaLine['style']})}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label>
        <label>Opacity<select aria-label={`EMA ${index+1} opacity`} value={line.opacity} onChange={event=>update(line.id,{opacity:Number(event.target.value)})}>{[1,.75,.5,.25,.1].map(opacity=><option key={opacity} value={opacity}>{Math.round(opacity*100)}%</option>)}</select></label>
      </div>
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    <div className="ema-setting-actions">
      <button type="button" disabled={draft.length>=5} onClick={()=>setDraft(current=>[...current,{id:crypto.randomUUID(),period:200,color:'#ec4899',enabled:true,width:2,style:'solid',opacity:1}])}><Plus size={14}/>Add EMA</button>
      <button type="button" onClick={()=>setDraft(defaultEmaLines())}>Reset</button>
      <button type="submit">Apply</button>
    </div>
  </form>;
}
