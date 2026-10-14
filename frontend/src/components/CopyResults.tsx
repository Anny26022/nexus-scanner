import {useState} from 'react';
import {Copy, Check} from 'lucide-react';
import {screenerApi} from '../api/screenerApi';
import {copyFormats, formatCopyResults, type CopyGroup, type CopyRow} from '../utils/copyResults';

export function CopyResults({loadRows, symbols, revision, disabled = false}: {
  loadRows:()=>Promise<CopyRow[]>; symbols?:string[]; revision?:string; disabled?:boolean;
}) {
  const [busy,setBusy] = useState(false);
  const [copied,setCopied] = useState(false);
  const [error,setError] = useState('');
  const copy = async (group:CopyGroup) => {
    setBusy(true); setError('');
    try {
      const [rows,taxonomy] = await Promise.all([group === 'symbols' && symbols ? symbols.map(symbol=>({symbol})) : loadRows(),
        ['symbols','sector','industry'].includes(group) ? undefined : screenerApi.getThemeClassification(revision)]);
      await navigator.clipboard.writeText(formatCopyResults(rows,group,taxonomy));
      setCopied(true); setTimeout(()=>setCopied(false),2000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not copy results. Please try again.'); }
    finally { setBusy(false); }
  };
  return <div className="copy-results">
    <button type="button" className="button button-secondary results-copy-button" disabled={disabled || busy}
      aria-label={copied ? 'Copied TradingView symbols' : 'Copy TradingView symbols'} title="Copy all results"
      onClick={()=>void copy('symbols')}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button>
    <select aria-label="Copy results grouped by" className="copy-format" value="" disabled={disabled || busy}
      onChange={event=>void copy(event.target.value as CopyGroup)}>
      <option value="" disabled>{busy ? 'Copying…' : 'Copy by…'}</option>
      {copyFormats.slice(1).map(format=><option key={format.value} value={format.value}>{format.label}</option>)}
    </select>
    {copied && <span className="sr-only" role="status">Results copied</span>}
    {error && <span className="copy-error" role="alert">{error}</span>}
  </div>;
}
