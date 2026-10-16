import { afterEach, expect, it, vi } from 'vitest';
import { ReplayClock } from '../chart/ReplayClock';

afterEach(()=>vi.useRealTimers());
it('plays only forward, changes speed, pauses and stops at the final bar',()=>{
  vi.useFakeTimers();
  const clock=new ReplayClock(5), unsubscribe=clock.subscribe(vi.fn());
  clock.seek(0); clock.toggle(); vi.advanceTimersByTime(1000);
  expect(clock.getSnapshot()).toMatchObject({index:1,playing:true});
  clock.speed(4); vi.advanceTimersByTime(250);
  expect(clock.getSnapshot().index).toBe(2);
  clock.toggle(); vi.advanceTimersByTime(2000); expect(clock.getSnapshot().index).toBe(2);
  clock.step(); clock.toggle(); vi.advanceTimersByTime(1000);
  expect(clock.getSnapshot()).toMatchObject({index:4,playing:false});
  clock.toggle(); expect(clock.getSnapshot().playing).toBe(false);
  clock.exit(); expect(clock.getSnapshot().index).toBeNull();
  expect(vi.getTimerCount()).toBe(0); unsubscribe();
});
it('cancels playback resources when the workspace unmounts and bounds invalid starts',()=>{
  vi.useFakeTimers();
  const clock=new ReplayClock(10), unsubscribe=clock.subscribe(vi.fn());
  clock.seek(-10); expect(clock.getSnapshot().index).toBe(0);
  clock.seek(NaN); expect(clock.getSnapshot().index).toBe(0);
  clock.toggle(); expect(vi.getTimerCount()).toBe(1);
  unsubscribe(); expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000); expect(clock.getSnapshot().index).toBe(0);
  clock.seek(100); expect(clock.getSnapshot().index).toBe(9);
});
