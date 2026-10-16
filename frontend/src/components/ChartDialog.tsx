import { useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** A chart-local modal: contained focus, Escape, backdrop dismissal and focus return. */
export function ChartDialog({title,onClose,children,className}:{title:string;onClose:()=>void;children:ReactNode;className?:string}) {
  const attach=useCallback((node:HTMLDivElement|null)=>{
    if (!node) return;
    const previous=document.activeElement;
    node.querySelector<HTMLElement>('button,input,select')?.focus();
    return ()=>{if(previous instanceof HTMLElement && previous.isConnected) previous.focus();};
  },[]);
  return createPortal(<div className="chart-modal-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget) onClose();}}>
    <div ref={attach} className={`chart-modal${className?` ${className}`:''}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event=>{
      if(event.key==='Escape') {event.preventDefault();event.stopPropagation();onClose();}
      if(event.key==='Tab') {
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]')).filter(node=>node.getClientRects().length>0);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey && document.activeElement===first) {event.preventDefault();last?.focus();}
        else if(!event.shiftKey && document.activeElement===last) {event.preventDefault();first?.focus();}
      }
    }}>
      <header className="chart-modal-heading"><h2>{title}</h2><button type="button" className="chart-icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={18}/></button></header>
      {children}
    </div>
  </div>, document.body);
}
