import { useCallback, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { readStored, subscribeStored, writeStored } from './store';

/** React state backed by one stored key. Every component using the key sees the same value. */
export function useStoredState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const fallbackRef = useRef(fallback);
  const subscribe = useCallback((listener: () => void) => subscribeStored(key, listener), [key]);
  const getSnapshot = useCallback(() => readStored(key, fallbackRef.current), [key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallbackRef.current);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => {
    const current = readStored(key, fallbackRef.current);
    writeStored(key, typeof next === 'function' ? (next as (value: T) => T)(current) : next);
  }, [key]);
  return [value, setValue];
}
