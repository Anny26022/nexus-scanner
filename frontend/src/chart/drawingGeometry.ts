import { anchors, FIB_LEVELS, type Drawing, type DrawingProjection, type Pixel } from './drawings';
import { annotationTool, waveLabels } from './drawingTools';

export interface DrawingGeometry {
  paths: Pixel[][];
  fills: Pixel[][];
  labels: {at:Pixel;text:string;box?:boolean}[];
}
const point=(x:number,y:number):Pixel=>({x,y});
const closed=(points:Pixel[])=>[...points,points[0]];
const lerp=(a:Pixel,b:Pixel,t:number)=>point(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t);
const ellipse=(center:Pixel,rx:number,ry:number,start=0,sweep=2*Math.PI)=>Array.from({length:65},(_,i)=>point(center.x+rx*Math.cos(start+sweep*i/64),center.y+ry*Math.sin(start+sweep*i/64)));
const money=(value:number)=>value.toLocaleString('en-IN',{maximumFractionDigits:2});

/** Pure geometry: painting and picking consume the same paths and label bounds. */
export function drawingGeometry(d:Drawing,p:DrawingProjection):DrawingGeometry {
  const g:DrawingGeometry={paths:[],fills:[],labels:[]};
  const points=anchors(d).map(p.toPixel),a=points[0],b=points[1]??a,c=points[2]??b;
  if(!a) return g;
  const path=(...values:Pixel[])=>g.paths.push(values);
  const label=(text:string,at:Pixel=a,box=false)=>g.labels.push({at,text,box});
  const polygon=(values:Pixel[])=>{g.fills.push(values);g.paths.push(closed(values));};
  const box=(u:Pixel,v:Pixel)=>[u,point(v.x,u.y),v,point(u.x,v.y)];
  const arrow=(u:Pixel,v:Pixel)=>{
    path(u,v);const angle=Math.atan2(v.y-u.y,v.x-u.x),size=10;
    path(point(v.x-size*Math.cos(angle-.45),v.y-size*Math.sin(angle-.45)),v,point(v.x-size*Math.cos(angle+.45),v.y-size*Math.sin(angle+.45)));
  };
  const extend=(u:Pixel,v:Pixel,both=false)=>{
    const dx=v.x-u.x,dy=v.y-u.y;
    if(Math.hypot(dx,dy)<.01) {path(u,v);return;}
    const k=4*(p.width+p.bottom+Math.abs(u.x)+Math.abs(u.y)+Math.abs(v.x)+Math.abs(v.y))/Math.hypot(dx,dy);
    path(both?point(u.x-dx*k,u.y-dy*k):u,point(v.x+dx*k,v.y+dy*k));
  };
  const parallel=(u:Pixel,v:Pixel,through:Pixel)=>{
    const dx=v.x-u.x,dy=v.y-u.y;
    return [through,point(through.x+dx,through.y+dy)] as const;
  };
  const fibs=d.levels??FIB_LEVELS;
  const grid=(u:Pixel,v:Pixel,count=8)=>{
    const corners=box(u,v);polygon(corners);
    for(let i=1;i<count;i++) {const t=i/count;path(lerp(corners[0],corners[1],t),lerp(corners[3],corners[2],t));path(lerp(corners[0],corners[3],t),lerp(corners[1],corners[2],t));}
  };
  if(annotationTool(d.kind)) {
    let at=point(a.x+7,a.y),text=d.text;
    if(['priceNote','priceLabel'].includes(d.kind)) text=`${money(d.a.price)} · ${text}`;
    if(d.kind==='callout'||d.kind==='comment') {path(a,b);at=b;}
    if(d.kind==='balloon') {
      polygon([a,point(a.x-6,a.y-14),point(a.x+6,a.y-14)]);
      at=point(a.x-10,a.y-24);
      label(text||'Balloon',at,true);
      return g;
    }
    if(d.kind==='iconStamp') {
      const r=10;
      polygon([point(a.x,a.y-r),point(a.x+r,a.y),point(a.x,a.y+r),point(a.x-r,a.y)]);
      label(d.text||'★',point(a.x-4,a.y+4));
      return g;
    }
    if(d.kind==='signpost'||d.kind==='flag') {path(a,point(a.x,a.y-30));polygon([point(a.x,a.y-30),point(a.x+25,a.y-30),point(a.x+19,a.y-18),point(a.x,a.y-18)]);at=point(a.x+6,a.y-23);}
    if(d.kind==='table') {
      const rows=d.text.split('\n').slice(0,8).map(row=>row.split('|').slice(0,6)),columns=Math.max(1,...rows.map(row=>row.length)),cell=70;
      for(let row=0;row<rows.length;row++) for(let col=0;col<columns;col++) {path(...closed(box(point(a.x+col*cell,a.y+row*25),point(a.x+(col+1)*cell,a.y+(row+1)*25))));label(rows[row][col]?.trim()??'',point(a.x+col*cell+5,a.y+row*25+13));}
      return g;
    }
    label(text,at,!['text','flag','signpost','iconStamp'].includes(d.kind));return g;
  }
  if(waveLabels[d.kind]) {
    g.paths.push(points);points.forEach((at,i)=>label(waveLabels[d.kind]![i]??String(i+1),point(at.x+5,at.y-12)));
    if(d.kind==='xabcd'||d.kind==='cypher'||['gartley','bat','butterfly','crab','shark'].includes(d.kind)) {
      if(points.length>=5) {g.fills.push([points[0],points[1],points[2]]);g.fills.push([points[2],points[3],points[4]]);}
      if(points.length>=5&&d.points) {
        const xa=Math.abs(d.points[1].price-d.points[0].price)||1, ab=Math.abs(d.points[2].price-d.points[1].price);
        const bc=Math.abs(d.points[3].price-d.points[2].price), cd=Math.abs(d.points[4].price-d.points[3].price);
        label(`${money(ab/xa)}`,lerp(points[1],points[2],.5));
        label(`${money(bc/ab||1)}`,lerp(points[2],points[3],.5));
        label(`${money(cd/bc||1)}`,lerp(points[3],points[4],.5));
      }
    }
    return g;
  }
  switch(d.kind) {
    case 'horizontal':path(point(0,a.y),point(p.width,a.y));break;
    case 'horizontalRay':path(a,point(p.width,a.y));break;
    case 'vertical':path(point(a.x,p.top),point(a.x,p.bottom));break;
    case 'crossline':path(point(0,a.y),point(p.width,a.y));path(point(a.x,p.top),point(a.x,p.bottom));break;
    case 'ray':extend(a,b);break;
    case 'extended':extend(a,b,true);break;
    case 'infoline':case 'angle':case 'measure':case 'priceRange':case 'dateRange': {
      const delta=d.b.price-d.a.price,pct=d.a.price?` (${money(delta/d.a.price*100)}%)`:'';
      const bars=p.bars?.filter(bar=>bar.time>=Math.min(d.a.time,d.b.time)&&bar.time<=Math.max(d.a.time,d.b.time)).length;
      const elapsed=`${Math.round(Math.abs(d.b.time-d.a.time)/86400000)}d${bars===undefined?'':` · ${bars} bars`}`;
      if(d.kind==='angle') {path(a,b);label(`${money(-Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI)}° screen`,b);}
      else if(d.kind==='infoline') {path(a,b);label(`${money(delta)}${pct} · ${elapsed}`,b,true);}
      else {
        polygon(box(a,b));
        label(d.kind==='dateRange'?elapsed:d.kind==='priceRange'?`${money(delta)}${pct}`:`${money(delta)}${pct} · ${elapsed}`,point(Math.min(a.x,b.x),Math.min(a.y,b.y)-12),true);
      }
      break;
    }
    case 'arrow':arrow(a,b);break;
    case 'arrowUp':case 'arrowDown':arrow(point(a.x,a.y+(d.kind==='arrowDown'?-22:22)),a);break;
    case 'arrowLeft':arrow(point(a.x+22,a.y),a);break;
    case 'arrowRight':arrow(point(a.x-22,a.y),a);break;
    case 'rectangle':polygon(box(a,b));break;
    case 'rotatedRectangle': {
      const dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy;
      const k=len?((c.x-a.x)*-dy+(c.y-a.y)*dx)/len:0,offset=point(-dy*k,dx*k);
      polygon([a,b,point(b.x+offset.x,b.y+offset.y),point(a.x+offset.x,a.y+offset.y)]);break;
    }
    case 'triangle':polygon(points);break;
    case 'ellipse':case 'circle': {
      const center=d.kind==='circle'?a:lerp(a,b,.5),rx=d.kind==='circle'?Math.hypot(b.x-a.x,b.y-a.y):Math.abs(b.x-a.x)/2,ry=d.kind==='circle'?rx:Math.abs(b.y-a.y)/2;
      const shape=ellipse(center,rx,ry);polygon(shape);break;
    }
    case 'curve':case 'doubleCurve': {
      const shape=Array.from({length:65},(_,i)=>{
        const t=i/64,q=1-t;
        if(d.kind==='curve') return point(q*q*a.x+2*q*t*b.x+t*t*c.x,q*q*a.y+2*q*t*b.y+t*t*c.y);
        const e=points[3]??c;return point(q*q*q*a.x+3*q*q*t*b.x+3*q*t*t*c.x+t*t*t*e.x,q*q*q*a.y+3*q*q*t*b.y+3*q*t*t*c.y+t*t*t*e.y);
      });g.paths.push(shape);break;
    }
    case 'arc': {
      const det=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
      if(Math.abs(det)<1e-6) {g.paths.push(points);break;}
      const sq=(u:Pixel)=>u.x*u.x+u.y*u.y;
      const center=point((sq(a)*(b.y-c.y)+sq(b)*(c.y-a.y)+sq(c)*(a.y-b.y))/det,(sq(a)*(c.x-b.x)+sq(b)*(a.x-c.x)+sq(c)*(b.x-a.x))/det);
      const start=Math.atan2(a.y-center.y,a.x-center.x),mid=Math.atan2(b.y-center.y,b.x-center.x),end=Math.atan2(c.y-center.y,c.x-center.x),tau=2*Math.PI,positive=(v:number)=>(v%tau+tau)%tau;
      let sweep=positive(end-start);if(positive(mid-start)>sweep) sweep-=tau;
      const radius=Math.hypot(a.x-center.x,a.y-center.y);g.paths.push(ellipse(center,radius,radius,start,sweep));break;
    }
    case 'channel': {
      const dx=b.x-a.x,dy=b.y-a.y;
      const offset=Math.abs(dx)>1e-6?c.y-a.y-(c.x-a.x)*dy/dx:c.x-a.x;
      const u=Math.abs(dx)>1e-6?point(a.x,a.y+offset):point(a.x+offset,a.y),v=Math.abs(dx)>1e-6?point(b.x,b.y+offset):point(b.x+offset,b.y);
      path(a,b);path(u,v);path(lerp(a,u,.5),lerp(b,v,.5));g.fills.push([a,b,v,u]);break;
    }
    case 'flatTopBottom': {
      const top=Math.min(a.y,b.y,c.y),bottom=Math.max(a.y,b.y,c.y),left=Math.min(a.x,b.x,c.x),right=Math.max(a.x,b.x,c.x);
      polygon([point(left,top),point(right,top),point(right,bottom),point(left,bottom)]);path(point(left,(top+bottom)/2),point(right,(top+bottom)/2));break;
    }
    case 'disjointChannel': {
      const d=points[3]??c;path(a,b);path(c,d);g.fills.push([a,b,d,c]);break;
    }
    case 'pitchfork':case 'schiffPitchfork':case 'modifiedSchiffPitchfork':case 'insidePitchfork': {
      const midpoint=lerp(b,c,.5),base=d.kind==='schiffPitchfork'?lerp(a,midpoint,.5):d.kind==='modifiedSchiffPitchfork'?lerp(a,midpoint,.25):a;
      const ratio=d.kind==='insidePitchfork'?.5:1,center=lerp(base,midpoint,ratio),[b0,b1]=parallel(base,center,b),[c0,c1]=parallel(base,center,c);
      extend(base,center);extend(b0,b1);extend(c0,c1);
      break;
    }
    case 'fibonacci': {
      for(const level of fibs) {const y=a.y+(b.y-a.y)*level;path(point(Math.min(a.x,b.x),y),point(Math.max(a.x,b.x),y));label(`${money(level*100)}% · ${money(d.a.price+(d.b.price-d.a.price)*level)}`,point(Math.min(a.x,b.x)+4,y-9));}break;
    }
    case 'fibExtension': {
      for(const level of fibs) {const at=point(c.x,c.y+(b.y-a.y)*level);path(point(Math.min(c.x,at.x)-80,at.y),point(Math.max(c.x,at.x)+80,at.y));label(`${money(level*100)}%`,at);}break;
    }
    case 'fibExtensionTwoPoint': {
      const dy=d.b.price-d.a.price;
      for(const level of fibs) {
        const price=d.b.price+dy*level, y=p.toPixel({time:d.b.time,price}).y;
        path(point(Math.min(a.x,b.x),y),point(Math.max(p.width,b.x),y));
        label(`${money(level*100)}% · ${money(price)}`,point(b.x+4,y-4));
      }
      break;
    }
    case 'fibChannel': {
      for(const level of fibs) {const at=lerp(a,c,level),[u,v]=parallel(a,b,at);path(u,v);}break;
    }
    case 'fibTimeZone': {
      const period=Math.max(8,Math.abs(b.x-a.x));for(const level of [0,1,1,2,3,5,8,13,21,34]) {const x=a.x+period*level;path(point(x,p.top),point(x,p.bottom));if(level) label(String(level),point(x+3,p.top+12));}break;
    }
    case 'fibFan':case 'fibSpeedFan': {
      for(const level of [.236,.382,.5,.618,.786,1]) extend(a,point(b.x,a.y+(b.y-a.y)*level));break;
    }
    case 'fibTime': {
      const dx=Math.abs(b.x-a.x),direction=Math.sign(b.x-a.x)||1;for(const level of fibs) {const x=c.x+direction*dx*level;path(point(x,p.top),point(x,p.bottom));label(`${money(level*100)}%`,point(x+3,p.top+12));}break;
    }
    case 'fibCircles': {
      const radius=Math.max(4,Math.hypot(b.x-a.x,b.y-a.y));for(const level of [.236,.382,.5,.618,.786,1]) g.paths.push(ellipse(a,radius*level,radius*level));break;
    }
    case 'fibSpiral': {
      const radius=Math.max(4,Math.hypot(b.x-a.x,b.y-a.y)),angle=Math.atan2(b.y-a.y,b.x-a.x);g.paths.push(Array.from({length:241},(_,i)=>{const t=i/240*4*Math.PI,r=radius*t/(4*Math.PI);return point(a.x+r*Math.cos(angle+t),a.y+r*Math.sin(angle+t));}));break;
    }
    case 'fibSpeedArcs': {
      const radius=Math.max(4,Math.hypot(b.x-a.x,b.y-a.y));for(const level of [.382,.5,.618,1]) g.paths.push(ellipse(a,radius*level,radius*level,Math.atan2(b.y-a.y,b.x-a.x)-Math.PI/2,Math.PI));break;
    }
    case 'fibWedge': {
      path(a,b,c,a);for(const level of [.382,.5,.618]) path(lerp(a,b,level),lerp(a,c,level));break;
    }
    case 'gannBox':case 'gannSquare': {grid(a,b);label('Screen-scale grid',a,true);break;}
    case 'gannFan': {for(const ratio of [1/8,1/4,1/3,1/2,1,2,3,4,8]) extend(a,point(b.x,a.y+(b.y-a.y)*ratio));label('Screen-scale fan',a,true);break;}
    case 'long':case 'short': {
      const entry=d.a.price,target=d.b.price;
      const stop=d.points?.[2]?.price??(d.kind==='long'?entry-Math.abs(target-entry)*0.5:entry+Math.abs(target-entry)*0.5);
      const stopPt=p.toPixel({time:d.b.time,price:stop});
      const correct=d.kind==='long'?target>entry&&stop<entry:target<entry&&stop>entry;
      const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x)+(a.x===b.x?60:0);
      polygon(box(point(left,a.y),point(right,b.y)));polygon(box(point(left,a.y),point(right,stopPt.y)));
      label(correct?`R/R ${money(Math.abs((target-entry)/(entry-stop)))}`:'Invalid R/R',point(left,a.y-13),true);
      label(`Target ${money(target)}`,point(left,b.y-12));label(`Stop ${money(stop)}`,point(left,stopPt.y+12));break;
    }
    case 'forecast': {
      const delta=d.b.price-d.a.price,pct=d.a.price?` (${money(delta/d.a.price*100)}%)`:'';
      extend(a,b);polygon(box(a,b));
      label(`Forecast ${money(d.b.price)}${pct}`,point(Math.min(a.x,b.x),Math.min(a.y,b.y)-12),true);
      break;
    }
    case 'fixedRangeVolumeProfile': {label('Requires intraday volume-at-price data',a,true);break;}
    case 'cyclic':case 'timeCycles':case 'sine': {
      const period=Math.max(8,Math.abs(b.x-a.x)),count=Math.min(256,Math.ceil(p.width/period)+2),start=a.x-Math.ceil(a.x/period)*period;
      if(d.kind==='cyclic') for(let i=0;i<count;i++) {const x=start+i*period;path(point(x,p.top),point(x,p.bottom));}
      else if(d.kind==='timeCycles') for(let i=0;i<count;i++) g.paths.push(ellipse(point(start+i*period+period/2,a.y),period/2,Math.abs(b.y-a.y)||period/2,Math.PI,Math.PI));
      else g.paths.push(Array.from({length:257},(_,i)=>point(p.width*i/256,a.y+Math.abs(b.y-a.y)*Math.sin((p.width*i/256-a.x)*2*Math.PI/period))));break;
    }
    case 'sonic':case 'supersonic':case 'goldenSonic':case 'goldenSupersonic': {
      const isGolden=d.kind==='goldenSonic'||d.kind==='goldenSupersonic';
      const isSuper=d.kind==='supersonic'||d.kind==='goldenSupersonic';
      const mid=lerp(a,b,.5),radius=Math.hypot(b.x-a.x,b.y-a.y)/2;
      if(radius<1) {path(a,b);break;}
      const cos=(b.x-a.x)/(2*radius),sin=(b.y-a.y)/(2*radius),mach=isSuper?2:1;
      const origin=point(mid.x-mach*radius*cos,mid.y-mach*radius*sin);
      const waveRatios=isGolden?[.618,1,1.618,2.618,4.236]:[.5,1,1.5,2,2.5,3];
      let maxR=0;
      for(const r of waveRatios) {
        const curR=radius*r;maxR=Math.max(maxR,curR);
        const center=point(origin.x+mach*curR*cos,origin.y+mach*curR*sin);
        g.paths.push(ellipse(center,curR,curR));
        label(`M${mach} · ${r}λ`,point(center.x+curR*cos+4,center.y+curR*sin));
      }
      const ext=mach*maxR+2*radius;
      if(isSuper) {
        const sinTheta=1/mach,cosTheta=Math.sqrt(1-sinTheta*sinTheta);
        for(const sign of [-1,1]) path(origin,point(origin.x+ext*(cos*cosTheta-sign*sin*sinTheta),origin.y+ext*(sin*cosTheta+sign*cos*sinTheta)));
      } else path(point(origin.x-sin*ext,origin.y+cos*ext),point(origin.x+sin*ext,origin.y-cos*ext));
      break;
    }
    case 'dedekindTessellation': {
      const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
      const h=bottom-top,w=right-left;
      polygon(box(a,b));
      if(h<4||w<4) break;
      const numCircles=Math.min(8,Math.floor(w/h)+1),step=w/numCircles;
      for(let i=0;i<numCircles;i++) {
        const cx=left+(i+.5)*step,r=Math.min(step/2,h/2);
        g.paths.push(ellipse(point(cx,bottom-r),r,r));
        const r2=r/4;
        g.paths.push(ellipse(point(cx-r/2,bottom-r2),r2,r2));
        g.paths.push(ellipse(point(cx+r/2,bottom-r2),r2,r2));
      }
      label('Dedekind tessellation',point(left+4,top+12));
      break;
    }
    case 'regression': {
      const bars=p.bars?.filter(bar=>bar.time>=Math.min(d.a.time,d.b.time)&&bar.time<=Math.max(d.a.time,d.b.time))??[];
      if(bars.length<2) {label('Select at least two published bars',a,true);break;}
      const n=bars.length,meanX=(n-1)/2,meanY=bars.reduce((sum,bar)=>sum+bar.close,0)/n;
      const denom=bars.reduce((sum,_,i)=>sum+(i-meanX)**2,0),slope=bars.reduce((sum,bar,i)=>sum+(i-meanX)*(bar.close-meanY),0)/denom;
      const intercept=meanY-slope*meanX,sigma=Math.sqrt(bars.reduce((sum,bar,i)=>sum+(bar.close-intercept-slope*i)**2,0)/n);
      for(const offset of [-2*sigma,0,2*sigma]) g.paths.push(bars.map((bar,i)=>p.toPixel({time:bar.time,price:intercept+slope*i+offset})));
      label('OLS close · ±2 residual σ',a);break;
    }
    case 'anchoredVwap': {
      let pv=0,volume=0;const line:Pixel[]=[];
      for(const bar of p.bars??[]) {if(bar.time<d.a.time) continue;if(bar.volume===null) break;pv+=(bar.high+bar.low+bar.close)/3*bar.volume;volume+=bar.volume;if(volume>0) line.push(p.toPixel({time:bar.time,price:pv/volume}));}
      g.paths.push(line);label('Anchored VWAP · bar HLC3',a);break;
    }
    default:g.paths.push(points);
  }
  return g;
}
