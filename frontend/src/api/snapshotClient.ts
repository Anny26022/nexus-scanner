import type { SnapshotResult, SnapshotTask } from './snapshotEngine';
let worker: Worker | undefined;
let sequence = 0;
let workerUnavailable = false;
const timeoutMessage = 'Scanner loading timed out. Please try again.';
const pending = new Map<number,{resolve:(result:SnapshotResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
let fallback: Promise<ReturnType<typeof import('./snapshotEngine')['createSnapshotEngine']>> | undefined;
function stop(message: string) {
  worker?.terminate(); worker = undefined;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
  pending.clear();
}
function runFallback(task: SnapshotTask): Promise<SnapshotResult> {
  const engine = fallback ??= import('./snapshotEngine').then(module => module.createSnapshotEngine());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (fallback === engine) fallback = undefined;
      reject(new Error(timeoutMessage));
    }, 60000);
    engine.then(run => run(task)).then(resolve, error => {
      if (fallback === engine) fallback = undefined;
      reject(error);
    }).finally(() => clearTimeout(timer));
  });
}
export function runSnapshotTask(task: SnapshotTask): Promise<SnapshotResult> {
  if (typeof Worker === 'undefined' || workerUnavailable) return runFallback(task);
  if (!worker) {
    try {
      worker = new Worker(new URL('./snapshot.worker.ts',import.meta.url),{type:'module'});
    } catch {
      workerUnavailable = true;
      return runFallback(task);
    }
    worker.onmessage = (event: MessageEvent<{id:number;result:SnapshotResult;error?:string}>) => {
      const item = pending.get(event.data.id);
      if (!item) return;
      pending.delete(event.data.id);clearTimeout(item.timer);
      if (event.data.error) item.reject(new Error(event.data.error));
      else item.resolve(event.data.result);
    };
    worker.onerror = () => stop('Scanner worker failed. Please try again.');
    worker.onmessageerror = () => stop('Scanner worker returned an invalid response.');
  }
  return new Promise((resolve,reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(timeoutMessage));
    },60000);
    pending.set(id,{resolve,reject,timer});
    try { worker!.postMessage({id,task}); }
    catch { stop('Unable to start scanner processing.'); }
  });
}
