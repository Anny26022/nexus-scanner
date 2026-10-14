import {useRef, useState} from 'react';
import {Copy, Check} from 'lucide-react';
import {screenerApi} from '../api/screenerApi';
import {copyFormats, formatCopyResults, type CopyGroup, type CopyRow} from '../utils/copyResults';

export function CopyResults({loadRows, symbols, revision, disabled = false}: {
  loadRows:()=>Promise<CopyRow[]>; symbols?:string[]; revision?:string; disabled?:boolean;
}) {
  const [busy,setBusy] = useState(false);
  const [copied,setCopied] = useState(false);
  const [error,setError] = useState('');
  const [open,setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {setOpen(false); trigger.current?.focus();};
  const copy = async (group:CopyGroup) => {
    close();
    setBusy(true); setError('');
    try {
      const [rows,taxonomy] = await Promise.all([group === 'symbols' && symbols ? symbols.map(symbol=>({symbol})) : loadRows(),
        ['symbols','sector','industry'].includes(group) ? undefined : screenerApi.getThemeClassification(revision)]);
      await navigator.clipboard.writeText(formatCopyResults(rows,group,taxonomy));
      setCopied(true); setTimeout(()=>setCopied(false),2000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not copy results. Please try again.'); }
    finally { setBusy(false); }
  };
  return <div className="copy-results" onBlur={event=>{
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();close();}}}>
    <button ref={trigger} type="button" className="button button-secondary results-copy-button" disabled={disabled || busy}
      aria-label={copied ? 'Results copied' : 'Copy results'} title="Copy results" aria-haspopup="menu" aria-expanded={open}
      onClick={()=>{setError('');setOpen(!open);}}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button>
    {open && <>
      <div className="copy-dismiss" onPointerDown={()=>setOpen(false)} aria-hidden="true"/>
      <div className="copy-menu" role="menu" aria-label="Copy format" onKeyDown={event=>{
        if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index=items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key==='Home' ? 0 : event.key==='End' ? items.length-1 : (index+(event.key==='ArrowDown' ? 1 : -1)+items.length)%items.length]?.focus();
      }}>
        {copyFormats.map((format,index)=><button key={format.value} type="button" role="menuitem" autoFocus={index===0}
          onClick={()=>void copy(format.value)}>{format.label}</button>)}
      </div>
    </>}
    {copied && <span className="sr-only" role="status">Results copied</span>}
    {error && <span className="copy-error" role="alert">{error}</span>}
  </div>;
}
