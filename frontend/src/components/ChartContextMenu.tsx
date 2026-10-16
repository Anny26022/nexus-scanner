import { useCallback, type ReactNode } from 'react';

export function ChartContextMenu({x,y,onClose,children}:{x:number;y:number;onClose:()=>void;children:ReactNode}) {
  const attach=useCallback((node:HTMLDivElement|null)=>{
    if(!node) return;
    const previous=document.activeElement;
    const rect=node.getBoundingClientRect();
    node.style.left=`${Math.max(8,Math.min(x,window.innerWidth-rect.width-8))}px`;
    node.style.top=`${Math.max(8,Math.min(y,window.innerHeight-rect.height-8))}px`;
    node.querySelector<HTMLElement>('button')?.focus();
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node && !node.contains(event.target)) onClose();};
    document.addEventListener('pointerdown',outside,true);
    return ()=>{
      document.removeEventListener('pointerdown',outside,true);
      if(node.contains(document.activeElement) && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  },[onClose,x,y]);
  return <div ref={attach} className="chart-context-menu" role="menu" aria-label="Chart actions" style={{left:x,top:y}} onKeyDown={event=>{
    if(event.key==='Escape' || event.key==='Tab') {event.stopPropagation();onClose();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }}>{children}</div>;
}
