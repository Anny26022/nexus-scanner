import type { MouseEventParams, IRange, Time } from 'lightweight-charts';
import type { ChartEngine } from './ChartEngine';

/** Link actual calendar dates, never logical indices from unrelated listing histories. */
export class ChartSync {
  private charts=new Set<ChartEngine>();
  private active:ChartEngine|null=null;
  private broadcasting=false;
  enabled=false;
  dates=true;
  crosshairs=true;
  persistenceEpoch=0;
  connect(engine:ChartEngine,host:HTMLElement) {
    this.charts.add(engine);
    const activate=()=>{this.active=engine;};
    const events=new AbortController();
    const root=host.closest<HTMLElement>('.chart-workspace')??host;
    for(const type of ['pointerenter','pointerdown','focusin','wheel']) root.addEventListener(type,activate,{signal:events.signal});
    const range=(value:IRange<Time>|null)=>{
      if(!value||!this.enabled||!this.dates||this.active!==engine||this.broadcasting) return;
      this.broadcasting=true;
      try {for(const target of this.charts) if(target!==engine) target.chart.timeScale().setVisibleRange(value);}
      finally {this.broadcasting=false;}
    };
    const crosshair=(event:MouseEventParams<Time>)=>{
      if(!this.enabled||!this.crosshairs||this.active!==engine||this.broadcasting) return;
      this.broadcasting=true;
      try {for(const target of this.charts) if(target!==engine) target.syncCrosshair(event.time);}
      finally {this.broadcasting=false;}
    };
    engine.chart.timeScale().subscribeVisibleTimeRangeChange(range);
    engine.chart.subscribeCrosshairMove(crosshair);
    return ()=>{
      events.abort();this.charts.delete(engine);if(this.active===engine) this.active=null;
      engine.chart.timeScale().unsubscribeVisibleTimeRangeChange(range);engine.chart.unsubscribeCrosshairMove(crosshair);
    };
  }
}
