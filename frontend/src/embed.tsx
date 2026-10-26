import React from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { ScannerShell, createScannerQueryClient, type ScannerShellOptions } from './App';
import { configureOrigins } from './api/origins';
import { setStorageNamespace } from './storage/store';
import { EMBED_ROOT_CLASS, setEmbedRoots } from './embedding';
import './index.css';

export type { AppTab } from './components/Navbar';
export type { ScannerShellOptions } from './App';

export interface ScannerAppProps {
  /**
   * The component always renders embedded mode: no scanner sidebar or theme toggle, its tabs as a sub-navigation.
   * The standalone site is `main.tsx`, not this component.
   */
  embedded?: true;
  /** Origin serving `/data/current.json` and relative release files, e.g. https://nexus-scanner.aniketmahato26.workers.dev. */
  dataOrigin?: string;
  /** Origin of the AI Worker (`/api/screener/ai-compile`). Usually the same as `dataOrigin`. */
  apiOrigin?: string;
  theme?: 'light' | 'dark';
  /** Return true when the host opened the symbol itself; otherwise the scanner opens its Charts tab. */
  onOpenSymbol?: ScannerShellOptions['onOpenSymbol'];
  /** Called with `/<tab>` before each tab switch; return true when the host navigated instead. */
  onNavigateExternal?: ScannerShellOptions['onNavigateExternal'];
  /** Prefix for every browser-storage key, so embedded preferences never clash with the host's. Default `nexus-scanner-embed`. */
  storageNamespace?: string;
  /** Optional query client. By default the scanner creates its own, so it never shares a cache with the host. */
  queryClient?: QueryClient;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The scanner as a component for a host React app. Origins and the storage namespace are read once, when it
 * mounts (re-key the component to change them), and only one instance may be mounted at a time.
 */
export function ScannerApp({
  dataOrigin, apiOrigin, theme = 'light', onOpenSymbol, onNavigateExternal,
  storageNamespace = 'nexus-scanner-embed', queryClient, className, style,
}: ScannerAppProps) {
  // Module-level configuration must be in place before any child reads storage or fetches data.
  const [client] = React.useState(() => {
    configureOrigins({dataOrigin: dataOrigin ?? '', apiOrigin: apiOrigin ?? dataOrigin ?? ''});
    setStorageNamespace(storageNamespace);
    return queryClient ?? createScannerQueryClient();
  });
  const root = React.useRef<HTMLDivElement>(null);
  const [portal] = React.useState(() => typeof document === 'undefined' ? null : document.createElement('div'));
  const [ready, setReady] = React.useState(false);

  React.useLayoutEffect(() => {
    if (!root.current || !portal) return;
    portal.className = `${EMBED_ROOT_CLASS} nexus-scanner-portal`;
    document.body.appendChild(portal);
    setEmbedRoots({theme: root.current, portal});
    setReady(true);
    return () => { setEmbedRoots(null); portal.remove(); };
  }, [portal]);
  React.useLayoutEffect(() => { if (portal) portal.dataset.theme = theme; }, [portal, theme]);

  // Latest callbacks without re-rendering the whole app when the host passes new closures.
  const callbacks = React.useRef({onOpenSymbol, onNavigateExternal});
  callbacks.current = {onOpenSymbol, onNavigateExternal};
  const embed = React.useMemo<ScannerShellOptions>(() => ({
    theme,
    onOpenSymbol: symbol => callbacks.current.onOpenSymbol?.(symbol),
    onNavigateExternal: path => callbacks.current.onNavigateExternal?.(path),
  }), [theme]);

  return <div ref={root} className={`${EMBED_ROOT_CLASS}${className ? ` ${className}` : ''}`} data-theme={theme} style={style}>
    {ready && <ScannerShell client={client} embed={embed} />}
  </div>;
}

export default ScannerApp;
