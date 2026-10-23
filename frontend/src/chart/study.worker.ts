/// <reference lib="webworker" />
import type { Candle } from './model';
import { computeStudy, type StudyLines } from './studyCompute';

export type StudyWorkerRequest = {
  id: number; token: number; keys: string[];
  /** Sent once per candle set (token); later requests for the same token reuse it. */
  candles?: Candle[]; benchmark?: [string, number][];
};
/** The worker no longer holds this token's candles; the store resends them. */
export const STALE = 'stale candles';
export type StudyWorkerResponse = {id: number; token: number; results: Record<string, StudyLines>; errors: Record<string, string>};

// One worker serves every chart on the page; it keeps the last few candle sets by token.
const sets = new Map<number, {candles: Candle[]; benchmark?: Map<string, number>}>();

self.onmessage = (event: MessageEvent<StudyWorkerRequest>) => {
  const {id, token, keys, candles, benchmark} = event.data;
  if (candles) {
    sets.delete(token);
    sets.set(token, {candles, benchmark: benchmark ? new Map(benchmark) : undefined});
    if (sets.size > 6) sets.delete(sets.keys().next().value!);
  }
  const set = sets.get(token);
  const results: Record<string, StudyLines> = {}, errors: Record<string, string> = {};
  for (const key of keys) {
    if (!set) { errors[key] = STALE; continue; }
    try { results[key] = computeStudy(key, set.candles, set.benchmark); }
    catch (error) { errors[key] = error instanceof Error ? error.message : String(error); }
  }
  self.postMessage({id, token, results, errors} satisfies StudyWorkerResponse);
};
