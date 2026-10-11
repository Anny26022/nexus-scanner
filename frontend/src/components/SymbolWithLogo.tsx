import React, { useState } from 'react';
import type { ReactNode } from 'react';

interface SymbolWithLogoProps {
  symbol: string;
  name?: string;
  size?: 'sm' | 'md';
  showText?: boolean;
  className?: string;
  badge?: ReactNode;
}

const logoSources = (sym: string) => [
  `https://images.dhan.co/symbol/${sym}.png`,
  `https://www.stockscans.in/api/company/logos/NSE:${sym}`,
  'https://s3-symbol-logo.tradingview.com/country/IN.svg',
];

/** Nexus Ultimate's compact company mark with Dhan, StockScans, and India fallbacks. */
export const SymbolWithLogo: React.FC<SymbolWithLogoProps> = ({ symbol, name, size = 'sm', showText = true, className = '', badge }) => {
  const cleanSymbol = symbol.trim().toUpperCase();
  const [source, setSource] = useState({symbol: cleanSymbol, index: 0});
  const sourceIdx = source.symbol === cleanSymbol ? source.index : 0;
  const dimension = size === 'md' ? 'h-8 w-8' : 'h-7 w-7';
  const sources = logoSources(encodeURIComponent(cleanSymbol));
  const src = sources[sourceIdx];

  return <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
    {src ? <img src={src} alt="" className={`${dimension} shrink-0 rounded-md border border-slate-200 bg-white p-0.5 object-contain`} loading="lazy" onError={() => setSource({symbol: cleanSymbol, index: sourceIdx + 1})} />
      : <span className={`${dimension} grid place-items-center shrink-0 rounded-md bg-slate-100 text-[11px] font-bold text-slate-500`}>{symbol.slice(0, 1)}</span>}
    {showText && <span className="min-w-0">{badge ? <span className="company-symbol-line"><b className="block truncate text-xs text-slate-900">{symbol}</b>{badge}</span> : <b className="block truncate text-xs text-slate-900">{symbol}</b>}{name && <span className="block truncate text-[11px] text-slate-500">{name}</span>}</span>}
  </span>;
};
