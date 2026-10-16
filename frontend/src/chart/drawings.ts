import { DRAWING_TOOLS, toolSpec, type DrawingKind, type DrawingTool } from './drawingTools';
import { drawingGeometry } from './drawingGeometry';
export { DRAWING_TOOLS } from './drawingTools';
export type { DrawingKind, DrawingTool } from './drawingTools';
export type LineDash = 'solid'|'dashed'|'dotted';
export interface Anchor { time: number; price: number }
export interface Drawing {
  id: string;
  kind: DrawingKind;
  a: Anchor;
  b: Anchor;
  text: string;
  color: string;
  width: number;
  points?: Anchor[];
  version?: 2;
  locked?: boolean;
  hidden?: boolean;
  dash?: LineDash;
  levels?: number[];
}
export const FIB_LEVELS = [0, .236, .382, .5, .618, .786, 1];
export const singleAnchor = (kind: DrawingKind) => toolSpec(kind).points===1;
export const anchors=(d:Drawing):readonly Anchor[]=>d.points??(singleAnchor(d.kind)?[d.a]:[d.a,d.b]);
const copy = (d: Drawing): Drawing => ({...d, a:{...d.a}, b:{...d.b},...(d.points?{points:d.points.map(a=>({...a}))}:{}),...(d.levels?{levels:[...d.levels]}:{})});
export function validDrawing(value:unknown):value is Drawing {
  if(!value||typeof value!=='object') return false;
  const d=value as Drawing;
  return typeof d.id==='string'&&d.id.length<=100&&DRAWING_TOOLS.some(tool=>tool.id!=='select'&&tool.id===d.kind)
    &&!!d.a&&!!d.b&&[d.a.time,d.a.price,d.b.time,d.b.price,d.width].every(Number.isFinite)
    &&[d.a.time,d.b.time].every(time=>time>=Date.UTC(1900,0,1)&&time<=Date.UTC(2200,0,1))&&d.width>=1&&d.width<=4
    &&typeof d.text==='string'&&d.text.length<=120&&(d.color==='accent'||/^#[0-9a-f]{6}$/i.test(d.color))
    &&(d.version===undefined||d.version===2)&&['locked','hidden'].every(key=>d[key as 'locked'|'hidden']===undefined||typeof d[key as 'locked'|'hidden']==='boolean')
    &&(d.dash===undefined||['solid','dashed','dotted'].includes(d.dash))
    &&(d.levels===undefined||Array.isArray(d.levels)&&d.levels.length>0&&d.levels.length<=24&&d.levels.every(v=>Number.isFinite(v)&&Math.abs(v)<=100))
    &&(d.points===undefined?toolSpec(d.kind).points>=1&&toolSpec(d.kind).points<=2:Array.isArray(d.points)&&d.points.length>=(toolSpec(d.kind).points===1?1:Math.max(2,toolSpec(d.kind).points))&&d.points.length<=512
      &&(toolSpec(d.kind).points<=0||d.points.length===toolSpec(d.kind).points)
      &&d.points.every(a=>a&&Number.isFinite(a.time)&&Number.isFinite(a.price)&&a.time>=Date.UTC(1900,0,1)&&a.time<=Date.UTC(2200,0,1))
      &&d.a.time===d.points[0].time&&d.a.price===d.points[0].price&&d.b.time===(d.points[1]??d.points[0]).time&&d.b.price===(d.points[1]??d.points[0]).price);
}

export interface DrawingSnapshot {
  drawings: readonly Drawing[];
  selectedId: string | null;
  tool: DrawingTool;
  text: string;
  canUndo: boolean;
  canRedo: boolean;
  stayDrawing: boolean;
  magnet: boolean;
  magnetMode?: 'weak' | 'strong';
  cursorMode?: 'cross' | 'dot' | 'arrow' | 'eraser';
  hideAll: boolean;
}

/** Symbol-owned document; previews do not enter history, each completed edit does. */
export class DrawingBook {
  private past: Drawing[][] = [];
  private future: Drawing[][] = [];
  private listeners = new Set<() => void>();
  private state: DrawingSnapshot = {drawings:[],selectedId:null,tool:'select',text:'Note',canUndo:false,canRedo:false,stayDrawing:false,magnet:false,magnetMode:'weak',cursorMode:'cross',hideAll:false};
  constructor(initial:readonly Drawing[]=[],private onCommit?:(drawings:readonly Drawing[])=>void) {
    this.state={...this.state,drawings:initial.map(copy)};
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<DrawingSnapshot>) {
    this.state = {...this.state,...update,canUndo:!!this.past.length,canRedo:!!this.future.length};
    if(update.drawings) this.onCommit?.(this.state.drawings);
    for (const listener of this.listeners) listener();
  }
  setTool(tool: DrawingTool) { this.publish({tool,selectedId:null}); }
  setText(text: string) { this.publish({text:text.slice(0,120)}); }
  options(change:Partial<Pick<DrawingSnapshot,'stayDrawing'|'magnet'|'magnetMode'|'cursorMode'|'hideAll'>>) {this.publish(change);}
  select(id: string | null) { if (id!==this.state.selectedId || (id && this.state.tool!=='select')) this.publish({selectedId:id,...(id?{tool:'select' as const}:{})}); }
  private commit(drawings: readonly Drawing[], selectedId = this.state.selectedId, tool:DrawingTool='select') {
    this.past = [...this.past.slice(-99),this.state.drawings.map(copy)];
    this.future = [];
    this.publish({drawings:drawings.map(copy),selectedId,tool});
  }
  add(kind: DrawingKind, a: Anchor, b = a) {
    this.addPoints(kind,singleAnchor(kind)?[a]:[a,b]);
  }
  addPoints(kind:DrawingKind,points:readonly Anchor[]) {
    if(this.state.drawings.length>=500) return;
    if(!points.length) return;
    const drawing: Drawing = {id:crypto.randomUUID(),version:2,kind,a:{...points[0]},b:{...(points[1]??points[0])},points:points.map(a=>({...a})),text:this.state.text.trim() || 'Note',color:'accent',width:1.5};
    if(!validDrawing(drawing)) return;
    this.commit([...this.state.drawings,drawing],drawing.id,this.state.stayDrawing?kind:'select');
  }
  update(id: string, change: Partial<Pick<Drawing,'a'|'b'|'points'|'text'|'color'|'width'|'locked'|'hidden'|'dash'|'levels'>>) {
    const old = this.state.drawings.find(d => d.id === id);
    if (!old) return;
    if(old.locked&&Object.keys(change).some(key=>key!=='locked'&&key!=='hidden')) return;
    const next = {...old,...change};
    if(change.points) {next.a=change.points[0];next.b=change.points[1]??next.a;}
    else if(old.points) next.points=old.points.map((point,index)=>index===0?(change.a??point):index===1?(change.b??point):point);
    if(next.points) {next.a=next.points[0];next.b=next.points[1]??next.a;}
    next.text = next.text.slice(0,120);
    if(!validDrawing(next)) return;
    if (JSON.stringify(next) !== JSON.stringify(old)) this.commit(this.state.drawings.map(d => d.id === id ? next : d));
  }
  delete(id: string) {
    const target = this.state.drawings.find(d => d.id === id);
    if (target && !target.locked) {
      this.commit(this.state.drawings.filter(d => d.id !== id), this.state.selectedId === id ? null : this.state.selectedId);
    }
  }
  deleteSelected() {
    if (this.state.selectedId&&!this.state.drawings.find(d=>d.id===this.state.selectedId)?.locked) this.delete(this.state.selectedId);
  }
  undo() {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.state.drawings.map(copy));
    this.publish({drawings:previous,selectedId:null,tool:'select'});
  }
  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.drawings.map(copy));
    this.publish({drawings:next,selectedId:null,tool:'select'});
  }
}

export interface Pixel { x: number; y: number }
export interface DrawingProjection {
  width: number;
  top: number;
  bottom: number;
  firstTime: number;
  lastTime: number;
  toPixel(anchor: Anchor): Pixel;
  toAnchor(pixel: Pixel): Anchor;
  bars?: readonly {time:number;open:number;high:number;low:number;close:number;volume:number|null}[];
}
export function timeIndex(times: readonly number[], time: number): number {
  if (time <= times[0]) return 0;
  if (time >= times[times.length-1]) return times.length-1;
  let lo = 0, hi = times.length-1;
  while (hi-lo > 1) { const mid = (lo+hi) >> 1; if (times[mid] <= time) lo=mid; else hi=mid; }
  return lo + (time-times[lo])/(times[hi]-times[lo]);
}
export function indexTime(times: readonly number[], index: number): number {
  const bounded = Math.max(0,Math.min(times.length-1,index)), i = Math.floor(bounded);
  return times[i] + ((times[i+1] ?? times[i])-times[i])*(bounded-i);
}
function distance(point: Pixel, a: Pixel, b: Pixel) {
  const dx=b.x-a.x, dy=b.y-a.y, length=dx*dx+dy*dy;
  const t=length ? Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)) : 0;
  return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
}
export function segments(d: Drawing, p: DrawingProjection): Array<[Pixel,Pixel]> {
  return drawingGeometry(d,p).paths.flatMap(path=>path.slice(1).map((point,index)=>[path[index],point] as [Pixel,Pixel]));
}
export function hitDrawing(drawings: readonly Drawing[], point: Pixel, p: DrawingProjection, selectedId: string | null) {
  // Selected handles take precedence, then reverse paint order for overlapping objects.
  const selected=drawings.find(d=>d.id===selectedId&&!d.hidden&&!d.locked);
  if (selected) {
    for (let index=0;index<anchors(selected).length;index++) {
      const at=p.toPixel(anchors(selected)[index]);
      if (Math.hypot(point.x-at.x,point.y-at.y)<=10) return {drawing:selected,handle:index};
    }
  }
  for (let i=drawings.length-1;i>=0;i--) {
    const d=drawings[i];if(d.hidden||d.locked) continue;
    const geometry=drawingGeometry(d,p);
    const labelHit=geometry.labels.some(label=>point.x>=label.at.x-10&&point.x<=label.at.x+label.text.length*7+10&&Math.abs(point.y-label.at.y)<=15);
    const fillHit=geometry.fills.some(polygon=>{
      let inside=false;for(let a=0,b=polygon.length-1;a<polygon.length;b=a++) {const u=polygon[a],v=polygon[b];if((u.y>point.y)!==(v.y>point.y)&&point.x<(v.x-u.x)*(point.y-u.y)/(v.y-u.y)+u.x) inside=!inside;}return inside;
    });
    if(labelHit||fillHit||geometry.paths.some(path=>path.slice(1).some((b,index)=>distance(point,path[index],b)<=8))) return {drawing:d,handle:null};
  }
  return null;
}
