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
  const mark = `symbol-logo-mark${size === 'md' ? ' symbol-logo-mark--md' : ''}`;
  const sources = logoSources(encodeURIComponent(cleanSymbol));
  const src = sources[sourceIdx];

  return <span className={`symbol-logo ${className}`}>
    {src ? <img src={src} alt="" className={mark} loading="lazy" onError={() => setSource({symbol: cleanSymbol, index: sourceIdx + 1})} />
      : <span className={mark}>{symbol.slice(0, 1)}</span>}
    {showText && <span className="symbol-logo-text">{badge ? <span className="company-symbol-line"><b className="symbol-logo-symbol">{symbol}</b>{badge}</span> : <b className="symbol-logo-symbol">{symbol}</b>}{name && <span className="symbol-logo-name">{name}</span>}</span>}
  </span>;
};
