import type { Candle } from './model';
import { computeStudy, usesBenchmark, type StudyLines } from './studyCompute';
import type { StudyWorkerRequest, StudyWorkerResponse } from './study.worker';

// Kept in step with study.worker.ts; importing the worker module itself would run it on this thread.
const STALE = 'stale candles';
/**
 * Main-thread time a burst of reads may spend computing before the rest goes to the worker. All of today's
 * indicators fit (about 5-20ms for 22 on 6,000 bars), so they draw with the price, without popping in; only a
 * much larger set spills into the worker and keeps the page responsive.
 */
const SYNC_BUDGET_MS = 12;
const BURST_MS = 100;

type Pending = {resolve: (response: StudyWorkerResponse) => void};
let worker: Worker | null | undefined;
let nextId = 1, nextToken = 1;
const pending = new Map<number, Pending>();

/** One background worker for every chart; null where workers are unavailable (tests, old browsers). */
function studyWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === 'undefined' ? null : new Worker(new URL('./study.worker.ts', import.meta.url), {type: 'module'});
    worker?.addEventListener('message', (event: MessageEvent<StudyWorkerResponse>) => {
      pending.get(event.data.id)?.resolve(event.data);
      pending.delete(event.data.id);
    });
    worker?.addEventListener('error', () => {
      // A broken worker falls back to computing on the main thread.
      worker = null;
      for (const entry of pending.values()) entry.resolve({id: 0, token: 0, results: {}, errors: {'*': 'worker failed'}});
      pending.clear();
    });
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * Indicator results for one chart's candles, computed once per key and shared by the chart and its legend.
 * Missing keys are computed in the background worker; `subscribe` reports when they arrive.
 */
export class StudyStore {
  private candles: readonly Candle[] = [];
  private benchmark?: ReadonlyMap<string, number>;
  private token = nextToken++;
  private sentToken = 0;
  private values = new Map<string, StudyLines>();
  private inFlight = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private burstStart = -Infinity;
  private burstUsed = 0;

  constructor(private readonly background = true) {}

  /** The full candle history. A new array discards every result; a new benchmark only relative strength. */
  setInputs(candles: readonly Candle[], benchmark?: ReadonlyMap<string, number>) {
    if (candles !== this.candles) {
      this.candles = candles; this.benchmark = benchmark;
      this.token = nextToken++; this.values.clear(); this.inFlight.clear();
    } else if (benchmark !== this.benchmark) {
      this.benchmark = benchmark; this.token = nextToken++;
      for (const key of [...this.values.keys()]) if (usesBenchmark(key)) this.values.delete(key);
      this.inFlight.clear();
    }
  }
  /** The result for `key`, or undefined while it is still being computed. Never blocks. */
  get(key: string): StudyLines | undefined { return this.values.get(key); }
  /**
   * The result now when it is ready or fits this burst's main-thread budget; otherwise undefined, and the
   * caller requests it from the worker.
   */
  take(key: string): StudyLines | undefined {
    const ready = this.values.get(key);
    if (ready || this.inFlight.has(key)) return ready;
    if (!this.background) return this.getNow(key);
    const now = performance.now();
    if (now - this.burstStart > BURST_MS) { this.burstStart = now; this.burstUsed = 0; }
    if (this.burstUsed >= SYNC_BUDGET_MS) return undefined;
    const lines = computeStudy(key, this.candles, this.benchmark);
    this.values.set(key, lines);
    this.burstUsed += performance.now() - now;
    return lines;
  }
  /** Starts computing any missing keys. Without a worker they are computed right away. */
  request(keys: readonly string[]) {
    const missing = [...new Set(keys)].filter(key => !this.values.has(key) && !this.inFlight.has(key));
    if (!missing.length) return;
    const target = this.background ? studyWorker() : null;
    if (!target) {
      for (const key of missing) this.values.set(key, computeStudy(key, this.candles, this.benchmark));
      this.bump();
      return;
    }
    for (const key of missing) this.inFlight.add(key);
    void this.send(target, missing, this.token);
  }
  /** Computes `key` on this thread if it is not ready: for callers that cannot wait (tests, engines without a store). */
  getNow(key: string): StudyLines {
    let lines = this.values.get(key);
    if (!lines) { lines = computeStudy(key, this.candles, this.benchmark); this.values.set(key, lines); }
    return lines;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;

  private async send(target: Worker, keys: string[], token: number, resend = false) {
    const id = nextId++;
    const response = await new Promise<StudyWorkerResponse>(resolve => {
      pending.set(id, {resolve});
      const message: StudyWorkerRequest = {id, token, keys};
      if (resend || this.sentToken !== token) {
        message.candles = this.candles as Candle[];
        if (this.benchmark) message.benchmark = [...this.benchmark];
        this.sentToken = token;
      }
      target.postMessage(message);
    });
    if (token !== this.token) return; // candles changed while this was computing
    const stale = keys.filter(key => response.errors[key] === STALE);
    if (stale.length && !resend) { void this.send(target, stale, token, true); }
    for (const key of keys) {
      if (stale.includes(key) && !resend) continue;
      this.inFlight.delete(key);
      // A failed worker request is computed here so the chart still shows it.
      this.values.set(key, response.results[key] ?? computeStudy(key, this.candles, this.benchmark));
    }
    this.bump();
  }
  private bump() { this.version++; for (const listener of this.listeners) listener(); }
}
