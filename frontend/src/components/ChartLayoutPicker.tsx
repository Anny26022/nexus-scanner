import { useCallback, useRef } from 'react';
import { ChevronDown, Grid2X2 } from 'lucide-react';
import { CHART_LAYOUTS, chartLayout, type SyncOptions } from '../chart/layouts';

export function ChartLayoutPicker({value,links,onLayout,onLinks}:{value:string;links:SyncOptions;onLayout:(id:string)=>void;onLinks:(links:SyncOptions)=>void}) {
  const root=useRef<HTMLDetailsElement|null>(null);
  const attach=useCallback((node:HTMLDetailsElement|null)=>{
    root.current=node;if(!node) return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!node.contains(event.target)) node.open=false;};
    document.addEventListener('pointerdown',outside,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);root.current=null;};
  },[]);
  const selected=chartLayout(value);
  return <details className="chart-grid-picker" ref={attach} onKeyDown={event=>{if(event.key==='Escape') {event.preventDefault();event.stopPropagation();if(root.current) {root.current.open=false;root.current.querySelector('summary')?.focus();}}}}>
    <summary aria-label="Chart grid" title="Chart grid"><Grid2X2 size={14}/><span>Grid</span><small>{selected.id}</small><ChevronDown size={12}/></summary>
    <div className="chart-grid-menu" role="group" aria-label="Chart grid options">
      <div className="chart-grid-header">
        <span>Select layout</span>
        <span className="chart-grid-count-badge">{selected.count} {selected.count === 1 ? 'chart' : 'charts'}</span>
      </div>
      <div className="chart-grid-options">{[...new Set(CHART_LAYOUTS.map(layout=>layout.count))].map(count=><div className="chart-layout-row" key={count} role="group" aria-label={`${count} chart layouts`}><span>{count}</span><div>{CHART_LAYOUTS.filter(layout=>layout.count===count).map(layout=><button key={layout.id} type="button" aria-label={`${count} chart${count===1?'':'s'} · ${layout.label}`} aria-pressed={value===layout.id} title={`${count} · ${layout.label}`} onClick={()=>{onLayout(layout.id);if(root.current) root.current.open=false;}}>
        <svg className="chart-layout-preview" aria-hidden="true" viewBox="-1 -1 34 30"><rect x="0" y="0" width="32" height="28" rx="2"/><path d={layout.edges}/></svg>
      </button>)}</div></div>)}</div>
      <div className="chart-grid-links-header">Sync across charts</div>
      <div className="chart-grid-links">{([['symbol','Sync symbol'],['interval','Sync interval'],['crosshair','Sync crosshair'],['dates','Sync dates']] as const).map(([key,label])=><label key={key} className="chart-grid-link-item"><span>{label}</span><input type="checkbox" role="switch" aria-label={label} checked={links[key]} onChange={event=>onLinks({...links,[key]:event.target.checked})}/></label>)}</div>
    </div>
  </details>;
}
