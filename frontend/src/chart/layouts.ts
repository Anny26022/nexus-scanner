const layout=(id:string,label:string,rows:string[])=>{
  const cells=rows.map(row=>row.split(' ')),columns=cells[0].length;
  const spans=cells.flatMap(row=>row.join('').match(/(.)\1*/g)!.map(span=>span.length));
  const edges=cells.flatMap((row,y)=>row.flatMap((cell,x)=>[
    ...(x&&cell!==row[x-1]?[`M${32*x/columns} ${28*y/cells.length}v${28/cells.length}`]:[]),
    ...(y&&cell!==cells[y-1][x]?[`M${32*x/columns} ${28*y/cells.length}h${32/columns}`]:[]),
  ])).join('');
  return {id,label,rows,count:new Set(cells.flat()).size,columns,minColumnWidth:300/Math.min(...spans),edges};
};
const grid=(id:string,label:string,columns:number,rows:number)=>layout(id,label,Array.from({length:rows},(_,y)=>Array.from({length:columns},(_,x)=>String.fromCharCode(97+y*columns+x)).join(' ')));
export const CHART_LAYOUTS=[
  layout('1','Single chart',['a']),
  layout('2H','Side by side',['a b']),layout('2V','Stacked',['a','b']),
  layout('3H','Three columns',['a b c']),layout('3V','Three rows',['a','b','c']),
  layout('3SL','Large left',['a b','a c']),layout('3SR','Large right',['b a','c a']),layout('3ST','Large top',['a a','b c']),layout('3SB','Large bottom',['b c','a a']),
  layout('4G','Four grid',['a b','c d']),layout('4H','Four columns',['a b c d']),layout('4V','Four rows',['a','b','c','d']),
  layout('4SL','Large left',['a b','a c','a d']),layout('4SR','Large right',['b a','c a','d a']),layout('4ST','Large top',['a a a','b c d']),layout('4SB','Large bottom',['b c d','a a a']),
  layout('4CL','Split left column',['a b c','d b c']),layout('4CR','Split right column',['a b c','a b d']),layout('4RT','Split top row',['a b','c c','d d']),layout('4RB','Split bottom row',['a a','b b','c d']),
  layout('5G','Five grid',['a a b','c d e']),layout('6G','Six grid',['a b c','d e f']),layout('6H','Six columns',['a b c d e f']),layout('6V','Six rows',['a','b','c','d','e','f']),layout('8G','Eight grid',['a b c d','e f g h']),
  grid('5H','Five columns',5,1),grid('5V','Five rows',1,5),
  layout('5SL','Large left',['a b','a c','a d','a e']),layout('5SR','Large right',['b a','c a','d a','e a']),
  layout('5ST','Large top',['a a a a','b c d e']),layout('5SB','Large bottom',['b c d e','a a a a']),
  layout('5S32','Three above two',['a a b b c c','d d d e e e']),
  layout('5CL','Three left, two tall',['a d e','b d e','c d e']),layout('5CR','Two tall, three right',['a b c','a b d','a b e']),
  grid('6G2','Two columns, three rows',2,3),layout('6ST','Two above four',['a a b b','c d e f']),layout('6SB','Four above two',['a b c d','e e f f']),
  layout('7G','Four above three',['a a a b b b c c c d d d','e e e e f f f f g g g g']),grid('7H','Seven columns',7,1),layout('7SL','Large left',['a b','a c','a d','a e','a f','a g']),
  grid('8G2','Two columns, four rows',2,4),grid('8H','Eight columns',8,1),grid('8V','Eight rows',1,8),
  layout('9G','Nine grid',['a b c','d e f','g h i']),
  layout('9S','Five above four',['a a a a b b b b c c c c d d d d e e e e','f f f f f g g g g g h h h h h i i i i i']),grid('9H','Nine columns',9,1),grid('9V','Nine rows',1,9),
  grid('10G','Ten grid',5,2),grid('10H','Ten columns',10,1),grid('10V','Ten rows',1,10),
  layout('12G','Twelve grid',['a b c d','e f g h','i j k l']),
  grid('12G2','Six columns, two rows',6,2),grid('12H','Twelve columns',12,1),grid('14G','Fourteen grid',7,2),grid('16G2','Eight columns, two rows',8,2),
  layout('16G','Sixteen grid',['a b c d','e f g h','i j k l','m n o p']),
].sort((a,b)=>a.count-b.count);
export const MAX_CHARTS=16;
export const chartLayout=(id:string)=>CHART_LAYOUTS.find(layout=>layout.id===id)??CHART_LAYOUTS[0];
export const layoutAreas=(rows:readonly string[])=>rows.map(row=>`"${row}"`).join(' ');
export type SyncOptions={dates:boolean;crosshair:boolean;symbol:boolean;interval:boolean};
