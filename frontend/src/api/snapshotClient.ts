import type { SnapshotResult, SnapshotTask } from './snapshotEngine';

let worker: Worker | undefined;
let sequence = 0;
let workerUnavailable = false;
const timeoutMessage = 'Scanner loading timed out. Please try again.';

interface PendingItem {
  resolve: (result: SnapshotResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const pending = new Map<number, PendingItem>();
let fallback: Promise<ReturnType<typeof import('./snapshotEngine')['createSnapshotEngine']>> | undefined;

function stop(message: string) {
  worker?.terminate();
  worker = undefined;
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
    item.reject(new Error(message));
  }
  pending.clear();
}

function runFallback(task: SnapshotTask, signal?: AbortSignal): Promise<SnapshotResult> {
  const engine = fallback ??= import('./snapshotEngine').then(module => module.createSnapshotEngine());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (fallback === engine) fallback = undefined;
      reject(new Error(timeoutMessage));
    }, 60000);
    engine.then(run => run(task, signal)).then(resolve, error => {
      if (fallback === engine) fallback = undefined;
      reject(error);
    }).finally(() => clearTimeout(timer));
  });
}

export function startSnapshotWorker() {
  if (typeof Worker === 'undefined' || workerUnavailable) return;
  if (!worker) {
    try {
      worker = new Worker(new URL('./snapshot.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      workerUnavailable = true;
      return;
    }
    worker.onmessage = (event: MessageEvent<{ id: number; result?: SnapshotResult; error?: string }>) => {
      const item = pending.get(event.data.id);
      if (!item) return;
      pending.delete(event.data.id);
      clearTimeout(item.timer);
      if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
      if (event.data.error) {
        item.reject(event.data.error === 'Aborted' ? new DOMException('Aborted', 'AbortError') : new Error(event.data.error));
      } else if (event.data.result) {
        item.resolve(event.data.result);
      }
    };
    worker.onerror = () => stop('Scanner worker failed. Please try again.');
    worker.onmessageerror = () => stop('Scanner worker returned an invalid response.');
  }
}

export function runSnapshotTask(task: SnapshotTask, signal?: AbortSignal): Promise<SnapshotResult> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  startSnapshotWorker();
  // Speculative warm-up must never compete with UI startup on the main thread.
  if (!worker) return task.type === 'warm' ? Promise.resolve({ type: 'warm' }) : runFallback(task, signal);

  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(timeoutMessage));
    }, 60000);

    const onAbort = () => {
      clearTimeout(timer);
      pending.delete(id);
      try {
        worker?.postMessage({ type: 'cancel', id });
      } catch {
        // Ignore postMessage error when cancelling
      }
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    pending.set(id, { resolve, reject, timer, signal, onAbort });
    try {
      // NOTE: task MUST be structured-cloneable. Never embed non-cloneable objects (like AbortSignal).
      worker!.postMessage({ id, task });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      stop('Unable to start scanner processing.');
      reject(e instanceof Error ? e : new Error('Unable to start scanner processing.'));
    }
  });
}
