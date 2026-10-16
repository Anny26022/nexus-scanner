/** A local closed-bar replay. Only the revealed prefix is passed to the renderer. */
export class ReplayClock {
  private state: {index:number|null;playing:boolean;speed:number} = {index:null,playing:false,speed:1};
  private listeners=new Set<()=>void>();
  private timer: ReturnType<typeof setTimeout>|null=null;
  constructor(private length:number) {}
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{
    this.listeners.add(listener); this.schedule();
    return ()=>{ this.listeners.delete(listener); if (!this.listeners.size) this.clear(); };
  };
  private clear() { if (this.timer!==null) clearTimeout(this.timer); this.timer=null; }
  private schedule() {
    this.clear();
    if (this.listeners.size && this.state.playing) this.timer=setTimeout(()=>this.step(),1000/this.state.speed);
  }
  private publish(update:Partial<typeof this.state>) {
    this.state={...this.state,...update};
    for (const listener of this.listeners) listener();
    this.schedule();
  }
  seek(index:number) {
    if (Number.isInteger(index) && this.length>0) this.publish({index:Math.max(0,Math.min(this.length-1,index)),playing:false});
  }
  exit() { this.publish({index:null,playing:false}); }
  toggle() {
    if (this.state.index!==null && this.state.index<this.length-1) this.publish({playing:!this.state.playing});
  }
  speed(speed:number) { if ([.5,1,2,4].includes(speed)) this.publish({speed}); }
  step(direction=1) {
    if (this.state.index===null) return;
    const index=Math.max(0,Math.min(this.length-1,this.state.index+direction));
    this.publish({index,playing:direction>0 && this.state.playing && index<this.length-1});
  }
}
