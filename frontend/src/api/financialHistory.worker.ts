import { getIpoJson } from './gzipJson';
import type { FinancialHistory } from '../chart/fundamentals';

const releases = new Map<string, Promise<Record<string, FinancialHistory>>>();
self.onmessage = async ({data}: MessageEvent<{id: number; url: string; symbol: string}>) => {
  const {id, url, symbol} = data;
  try {
    let pending = releases.get(url);
    if (!pending) {
      pending = getIpoJson<Record<string, FinancialHistory>>(url, 'Financial history');
      releases.set(url, pending);
      if (releases.size > 2) releases.delete(releases.keys().next().value!);
      pending.catch(() => releases.delete(url));
    }
    self.postMessage({id, value: (await pending)[symbol] ?? null});
  } catch { self.postMessage({id, error: 'Financial history unavailable'}); }
};
