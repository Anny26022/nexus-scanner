import type { FinancialHistory } from '../chart/fundamentals';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, {resolve: (value: FinancialHistory | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
function stop() {
  worker?.terminate(); worker = undefined;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Financial history unavailable')); }
  pending.clear();
}
/** Older releases keep their original asset; decode and retain it off the UI thread. */
export function legacyFinancialHistory(url: string, symbol: string): Promise<FinancialHistory | null> {
  if (!worker) {
    worker = new Worker(new URL('./financialHistory.worker.ts', import.meta.url), {type: 'module'});
    worker.onerror = stop;
    worker.onmessage = ({data}: MessageEvent<{id: number; value: FinancialHistory | null; error?: string}>) => {
      const item = pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(data.id);
      if (data.error) item.reject(new Error(data.error)); else item.resolve(data.value);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, {resolve, reject, timer: setTimeout(stop, 60000)});
    worker!.postMessage({id, url, symbol});
  });
}
