import { anchors, hitDrawing, type Anchor, type Drawing, type DrawingBook, type DrawingProjection, type Pixel } from './drawings';
import { toolSpec, type DrawingKind } from './drawingTools';
import { drawingGeometry } from './drawingGeometry';

interface Gesture {pointer:number;start:Pixel;origin:Anchor;drawing:Drawing|null;handle:number|null}
interface Placement {kind:DrawingKind;points:Anchor[];hover:Anchor}

/** Transient gestures never enter React, persistence or undo until completion. */
export class DrawingLayer {
  private placement:Placement|null=null;
  private preview:Drawing|null=null;
  private gesture:Gesture|null=null;
  private unsubscribe:()=>void;
  constructor(readonly book:DrawingBook,private projection:()=>DrawingProjection|null,private invalidate:()=>void) {this.unsubscribe=book.subscribe(()=>this.cancel());}
  cancel() {this.placement=null;this.preview=null;this.gesture=null;this.invalidate();}
  cancelPointer() {if(this.gesture) this.cancel();}
  destroy() {this.unsubscribe();}
  drawings() {
    if(this.book.getSnapshot().hideAll) return [];
    const list=this.book.getSnapshot().drawings.filter(d=>!d.hidden).map(d=>this.preview?.id===d.id?this.preview:d);
    const draft=this.placement;if(!draft) return list;
    const points=[...draft.points];if(toolSpec(draft.kind).points!==-1) points.push(draft.hover);
    while(points.length<Math.max(2,toolSpec(draft.kind).points)) points.push(draft.hover);
    return [...list,{id:'draft',version:2 as const,kind:draft.kind,a:points[0],b:points[1]??points[0],points,text:this.book.getSnapshot().text,color:'accent',width:1.5}];
  }
  private anchor(point:Pixel,p:DrawingProjection) {
    const anchor=p.toAnchor(point);if(!this.book.getSnapshot().magnet||!p.bars?.length) return anchor;
    const isStrong=this.book.getSnapshot().magnetMode==='strong';
    let nearest:Anchor|undefined,distance=isStrong?1000:14;
    for(const bar of p.bars) {
      const x=p.toPixel({time:bar.time,price:bar.close}).x;if(Math.abs(x-point.x)>(isStrong?30:14)) continue;
      for(const price of [bar.open,bar.high,bar.low,bar.close]) {const candidate={time:bar.time,price},at=p.toPixel(candidate),delta=Math.hypot(at.x-point.x,at.y-point.y);if(delta<distance) {nearest=candidate;distance=delta;}}
    }
    return nearest??anchor;
  }
  finish() {
    const draft=this.placement;if(!draft||toolSpec(draft.kind).points>0||draft.points.length<2) return false;
    this.placement=null;this.gesture=null;this.book.addPoints(draft.kind,draft.points);return true;
  }
  down(point:Pixel,pointer:number) {
    const p=this.projection();if(!p||point.x<0||point.x>p.width||point.y<p.top||point.y>p.bottom) return false;
    const state=this.book.getSnapshot(),anchor=this.anchor(point,p);
    if(state.cursorMode==='eraser') {
      const hit=hitDrawing(state.drawings,point,p,null);
      if(hit&&!hit.drawing.locked) {this.book.delete(hit.drawing.id);return true;}
      return false;
    }
    if(state.tool!=='select') {
      if(state.hideAll) return false;
      const spec=toolSpec(state.tool);if(spec.points===1) {this.book.addPoints(state.tool,[anchor]);return true;}
      if(this.placement&&spec.points!==-1) {
        const last=this.placement.points.at(-1)!;if(last.time!==anchor.time||last.price!==anchor.price) this.placement.points.push(anchor);
        this.placement.hover=anchor;
        if(spec.points>0&&this.placement.points.length===spec.points) {const d=this.placement;this.placement=null;this.book.addPoints(d.kind,d.points);return true;}
      } else this.placement={kind:state.tool,points:[anchor],hover:anchor};
      this.gesture={pointer,start:point,origin:anchor,drawing:null,handle:null};this.invalidate();return true;
    }
    if(state.hideAll) return false;
    const hit=hitDrawing(state.drawings,point,p,state.selectedId);this.book.select(hit?.drawing.id??null);
    if(!hit) return false;this.gesture={pointer,start:point,origin:anchor,drawing:hit.drawing,handle:hit.handle};return true;
  }
  move(point:Pixel,pointer:number) {
    const p=this.projection();if(!p) return false;
    const anchor=this.anchor({x:Math.max(0,Math.min(p.width,point.x)),y:Math.max(p.top,Math.min(p.bottom,point.y))},p);
    if(this.placement) {
      this.placement.hover=anchor;
      if(toolSpec(this.placement.kind).points===-1&&this.gesture?.pointer===pointer&&this.placement.points.length<512) {const last=p.toPixel(this.placement.points.at(-1)!);if(Math.hypot(last.x-point.x,last.y-point.y)>=2) this.placement.points.push(anchor);}
      this.invalidate();return true;
    }
    const drag=this.gesture;if(!drag||drag.pointer!==pointer||!drag.drawing) return false;
    const source=anchors(drag.drawing);let points:Anchor[];
    if(drag.handle!==null) points=source.map((a,index)=>index===drag.handle?anchor:a);
    else {
      // Translate in logical/bar space rather than adding calendar days across weekends.
      const origin=p.toPixel(drag.origin),dx=point.x-origin.x;
      const translated=source.map(a=>p.toAnchor({x:p.toPixel(a).x+dx,y:p.toPixel(a).y}));
      points=source.map((a,i)=>({time:translated[i].time,price:a.price+anchor.price-drag.origin.price}));
    }
    this.preview={...drag.drawing,points,a:points[0],b:points[1]??points[0]};this.invalidate();return true;
  }
  up(point:Pixel,pointer:number) {
    const drag=this.gesture;if(!drag||drag.pointer!==pointer) return;
    this.move(point,pointer);this.gesture=null;
    if(this.placement) {
      const spec=toolSpec(this.placement.kind);
      if(spec.points===-1) {this.finish();if(this.placement) this.cancel();}
      else if(spec.points===2&&Math.hypot(point.x-drag.start.x,point.y-drag.start.y)>=4) {const draft=this.placement;this.placement=null;this.book.addPoints(draft.kind,[draft.points[0],draft.hover]);}
    } else if(this.preview) {const d=this.preview;this.preview=null;this.book.update(d.id,{points:[...anchors(d)]});}
    this.invalidate();
  }
  key(event:KeyboardEvent) {
    const command=event.ctrlKey||event.metaKey;
    if(command&&['z','y'].includes(event.key.toLowerCase())) {event.preventDefault();if(this.placement||this.gesture) this.cancel();else if(event.key.toLowerCase()==='y'||event.shiftKey) this.book.redo();else this.book.undo();return true;}
    if(event.key==='Enter'&&this.finish()) {event.preventDefault();return true;}
    if(event.key==='Escape') {this.cancel();this.book.setTool('select');return true;}
    if(['Delete','Backspace'].includes(event.key)&&this.book.getSnapshot().selectedId) {event.preventDefault();this.book.deleteSelected();return true;}
    return false;
  }
  draw(ctx:CanvasRenderingContext2D,p:DrawingProjection,accent:string) {
    const state=this.book.getSnapshot();ctx.save();ctx.beginPath();ctx.rect(0,p.top,p.width,p.bottom-p.top);ctx.clip();
    for(const d of this.drawings()) {
      const geometry=drawingGeometry(d,p),color=d.color==='accent'?accent:d.color;
      ctx.save();ctx.strokeStyle=ctx.fillStyle=color;ctx.lineWidth=d.kind==='highlighter'?d.width*8:d.width;ctx.lineJoin=ctx.lineCap='round';
      ctx.globalAlpha=d.kind==='highlighter'?.3:1;ctx.setLineDash(d.dash==='dashed'?[7,4]:d.dash==='dotted'?[2,4]:[]);
      geometry.fills.forEach((polygon,index)=>{if(!polygon.length) return;ctx.save();ctx.globalAlpha=.1;ctx.fillStyle=d.kind==='long'||d.kind==='short'?(index===0?'#089981':'#ef5350'):color;ctx.beginPath();ctx.moveTo(polygon[0].x,polygon[0].y);for(const at of polygon.slice(1)) ctx.lineTo(at.x,at.y);ctx.closePath();ctx.fill();ctx.restore();});
      if(d.kind!=='horizontal') for(const path of geometry.paths) {if(!path.length) continue;ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);for(const at of path.slice(1)) ctx.lineTo(at.x,at.y);ctx.stroke();}
      ctx.globalAlpha=1;ctx.setLineDash([]);ctx.font='11px -apple-system, BlinkMacSystemFont, sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
      for(const label of geometry.labels) {ctx.fillStyle=color;if(label.box) {const width=ctx.measureText(label.text).width;ctx.fillRect(label.at.x-4,label.at.y-11,width+8,22);ctx.fillStyle='#ffffff';}ctx.fillText(label.text,label.at.x,label.at.y);}
      if((d.id===state.selectedId&&!d.locked)||d.id==='draft') {ctx.strokeStyle=color;ctx.lineWidth=1;const values=anchors(d);for(const [i,anchor] of values.entries()) if(values.length<=12||i===0||i===values.length-1) {const at=p.toPixel(anchor);ctx.strokeRect(at.x-4,at.y-4,8,8);}}
      ctx.restore();
    }
    ctx.restore();
  }
}
