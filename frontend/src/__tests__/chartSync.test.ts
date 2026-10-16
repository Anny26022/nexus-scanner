import { expect, it, vi } from 'vitest';
import { ChartSync } from '../chart/ChartSync';
import type { ChartEngine } from '../chart/ChartEngine';
import type { IRange, MouseEventParams, Time } from 'lightweight-charts';

function fake() {
  let range:((value:IRange<Time>|null)=>void)|undefined,crosshair:((event:MouseEventParams<Time>)=>void)|undefined;
  const scale={subscribeVisibleTimeRangeChange:vi.fn(callback=>{range=callback;}),unsubscribeVisibleTimeRangeChange:vi.fn(),setVisibleRange:vi.fn()};
  const engine={chart:{timeScale:()=>scale,subscribeCrosshairMove:vi.fn(callback=>{crosshair=callback;}),unsubscribeCrosshairMove:vi.fn()},syncCrosshair:vi.fn()};
  const root=document.createElement('section');root.className='chart-workspace';const host=document.createElement('div');root.append(host);
  return {engine,host,root,scale,emitRange:(value:IRange<Time>)=>range?.(value),emitCrosshair:(time?:Time)=>crosshair?.({time} as MouseEventParams<Time>)};
}
it('links dates and crosshairs only from the active chart and cleans up all subscriptions',()=>{
  const group=new ChartSync(),a=fake(),b=fake();
  const unA=group.connect(a.engine as unknown as ChartEngine,a.host),unB=group.connect(b.engine as unknown as ChartEngine,b.host);
  a.root.dispatchEvent(new Event('pointerdown'));const range={from:'2026-01-01',to:'2026-02-01'};
  a.emitRange(range);expect(b.scale.setVisibleRange).not.toHaveBeenCalled();
  group.enabled=true;a.emitRange(range);expect(b.scale.setVisibleRange).toHaveBeenCalledWith(range);
  // A programmatic target callback cannot echo back, even after the guard has cleared.
  b.emitRange(range);expect(a.scale.setVisibleRange).not.toHaveBeenCalled();
  a.emitCrosshair('2026-01-21');expect(b.engine.syncCrosshair).toHaveBeenLastCalledWith('2026-01-21');
  a.emitCrosshair();expect(b.engine.syncCrosshair).toHaveBeenLastCalledWith(undefined);
  b.root.dispatchEvent(new Event('focusin'));b.emitRange(range);expect(a.scale.setVisibleRange).toHaveBeenCalledWith(range);
  unB();a.root.dispatchEvent(new Event('pointerdown'));b.scale.setVisibleRange.mockClear();a.emitRange(range);expect(b.scale.setVisibleRange).not.toHaveBeenCalled();
  unA();expect(a.scale.unsubscribeVisibleTimeRangeChange).toHaveBeenCalledOnce();expect(b.engine.chart.unsubscribeCrosshairMove).toHaveBeenCalledOnce();
});
