import { expect, it, vi } from 'vitest';
import { DrawingBook, DRAWING_TOOLS, hitDrawing, indexTime, segments, timeIndex, validDrawing, type DrawingProjection } from '../chart/drawings';
import { toolSpec } from '../chart/drawingTools';
import { DrawingLayer } from '../chart/DrawingLayer';

const projection: DrawingProjection = {
  width:500,top:0,bottom:500,firstTime:0,lastTime:500,
  toPixel:a=>({x:a.time,y:a.price}),toAnchor:p=>({time:p.x,price:p.y}),
};
it('keeps symbol-owned drawing history reversible, rejects invalid edits and clears redo on a new edit',()=>{
  const book=new DrawingBook(), notify=vi.fn(), unsubscribe=book.subscribe(notify);
  const a={time:20,price:40};
  book.add('trendline',a,{time:100,price:80}); a.price=999;
  const id=book.getSnapshot().selectedId!;
  expect(book.getSnapshot().drawings[0].a.price).toBe(40);
  book.update(id,{width:NaN}); expect(book.getSnapshot().drawings[0].width).toBe(1.5);
  book.update(id,{width:3}); book.undo(); expect(book.getSnapshot().drawings[0].width).toBe(1.5);
  book.redo(); expect(book.getSnapshot().drawings[0].width).toBe(3);
  book.select(id); book.deleteSelected(); expect(book.getSnapshot().drawings).toHaveLength(0);
  book.undo(); expect(book.getSnapshot().drawings).toHaveLength(1);
  book.add('text',{time:30,price:50}); expect(book.getSnapshot().canRedo).toBe(false);
  unsubscribe(); notify.mockClear(); book.undo(); expect(notify).not.toHaveBeenCalled();
});
it.each(DRAWING_TOOLS.filter(t=>t.id!=='select'&&toolSpec(t.id).points>0))('creates $label with its required points and permits hit selection',({id})=>{
  const book=new DrawingBook(), layer=new DrawingLayer(book,()=>projection,vi.fn());
  const points=Math.max(1,toolSpec(id).points);
  book.setTool(id);
  for(let index=0;index<points;index++) {
    const at={x:20+index*35,y:40+index*17};
    layer.down(at,index+1); layer.up(at,index+1);
  }
  const drawing=book.getSnapshot().drawings[0];
  expect(drawing.kind).toBe(id);
  expect(validDrawing(drawing)).toBe(true);
  expect(hitDrawing([drawing],projection.toPixel(drawing.a),projection,drawing.id)?.drawing.id).toBe(drawing.id);
  if (id==='fibonacci') expect(segments(drawing,projection)).toHaveLength(7);
  layer.destroy();
});
it.each(['polyline','path','brush','highlighter'] as const)('commits variable-point $0 only after the intended gesture is complete',(id)=>{
  const book=new DrawingBook(), layer=new DrawingLayer(book,()=>projection,vi.fn());
  book.setTool(id);
  if(toolSpec(id).points===-1) {
    layer.down({x:20,y:40},1); layer.move({x:45,y:50},1); layer.move({x:80,y:70},1); layer.up({x:100,y:80},1);
  } else {
    layer.down({x:20,y:40},1); layer.up({x:20,y:40},1);
    layer.down({x:60,y:55},2); layer.up({x:60,y:55},2);
    layer.down({x:100,y:80},3); layer.up({x:100,y:80},3);
    layer.key(new KeyboardEvent('keydown',{key:'Enter'}));
  }
  const drawing=book.getSnapshot().drawings[0];
  expect(drawing.kind).toBe(id);
  expect(drawing.points?.length).toBeGreaterThanOrEqual(2);
  expect(validDrawing(drawing)).toBe(true);
  layer.destroy();
});
it('supports two clicks, handle editing, cancellation and keyboard undo/redo/delete',()=>{
  const book=new DrawingBook(), layer=new DrawingLayer(book,()=>projection,vi.fn());
  book.setTool('trendline'); layer.down({x:20,y:40},1); layer.up({x:20,y:40},1);
  expect(book.getSnapshot().drawings).toHaveLength(0);
  layer.move({x:100,y:80},1); layer.down({x:100,y:80},1); layer.up({x:100,y:80},1);
  const id=book.getSnapshot().selectedId!;
  layer.down({x:20,y:40},1); layer.move({x:30,y:50},1); layer.up({x:30,y:50},1);
  expect(book.getSnapshot().drawings[0].a).toEqual({time:30,price:50});
  layer.down({x:30,y:50},1); layer.move({x:90,y:90},1); layer.cancelPointer();
  expect(book.getSnapshot().drawings[0].a.price).toBe(50);
  layer.key(new KeyboardEvent('keydown',{key:'z',ctrlKey:true}));
  expect(book.getSnapshot().drawings[0].a.price).toBe(40);
  layer.key(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true}));
  expect(book.getSnapshot().drawings[0].a.price).toBe(50);
  book.select(id); layer.key(new KeyboardEvent('keydown',{key:'Delete'}));
  expect(book.getSnapshot().drawings).toHaveLength(0);
  book.setTool('ray'); layer.down({x:20,y:40},1); layer.up({x:20,y:40},1);
  layer.key(new KeyboardEvent('keydown',{key:'Escape'}));
  expect(book.getSnapshot().tool).toBe('select'); expect(book.getSnapshot().drawings).toHaveLength(0);
  layer.destroy();
});
it('anchors drawings to real time across aggregation, not the current pixel scale',()=>{
  const times=[100,200,500];
  expect(timeIndex(times,350)).toBe(1.5); expect(indexTime(times,1.5)).toBe(350);
  expect(indexTime(times,-4)).toBe(100); expect(timeIndex(times,900)).toBe(2);
});
