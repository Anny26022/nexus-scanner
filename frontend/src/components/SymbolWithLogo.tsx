import React, { useState } from 'react';

interface SymbolWithLogoProps {
  symbol: string;
  name?: string;
  size?: 'sm' | 'md';
  showText?: boolean;
  className?: string;
}

const logoSources = (sym: string) => [
  `https://images.dhan.co/symbol/${sym}.png`,
  `https://www.stockscans.in/api/company/logos/NSE:${sym}`,
  'https://s3-symbol-logo.tradingview.com/country/IN.svg',
];

/** Nexus Ultimate's compact company mark with Dhan, StockScans, and India fallbacks. */
export const SymbolWithLogo: React.FC<SymbolWithLogoProps> = ({ symbol, name, size = 'sm', showText = true, className = '' }) => {
  const [sourceIdx, setSourceIdx] = useState(0);
  const dimension = size === 'md' ? 'h-6 w-6' : 'h-4 w-4';
  const cleanSymbol = symbol.trim().toUpperCase();
  const sources = logoSources(encodeURIComponent(cleanSymbol));
  const src = sources[sourceIdx];

  return <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
    {src ? <img src={src} alt="" className={`${dimension} shrink-0 rounded object-contain`} loading="lazy" onError={() => setSourceIdx(i => i + 1)} />
      : <span className={`${dimension} shrink-0 rounded bg-slate-100 text-center text-[9px] font-bold leading-4 text-slate-500`}>{symbol.slice(0, 1)}</span>}
    {showText && <span className="min-w-0"><b className="block truncate text-xs text-slate-900">{symbol}</b>{name && <span className="block truncate text-[11px] text-slate-500">{name}</span>}</span>}
  </span>;
};
