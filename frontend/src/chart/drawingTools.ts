export const TOOL_GROUPS = [
  {category:'Lines',tools:[
    ['trendline','Trend Line',2],['ray','Ray',2],['extended','Extended Line',2],['infoline','Info Line',2],['angle','Trend Angle',2],
    ['horizontal','Horizontal Line',1],['horizontalRay','Horizontal Ray',1],['vertical','Vertical Line',1],['crossline','Cross Line',1],
  ]},
  {category:'Channels',tools:[
    ['channel','Parallel Channel',3],['regression','Regression Channel',2],['flatTopBottom','Flat Top/Bottom',3],['disjointChannel','Disjoint Channel',4],
  ]},
  {category:'Pitchforks',tools:[
    ['pitchfork','Pitchfork',3],['schiffPitchfork','Schiff Pitchfork',3],['modifiedSchiffPitchfork','Modified Schiff Pitchfork',3],['insidePitchfork','Inside Pitchfork',3],
  ]},
  {category:'Fibonacci',tools:[
    ['fibonacci','Fib Retracement',2],['fibExtension','Fib Extension',3],['fibExtensionTwoPoint','Fib Extension (Two Point)',2],['fibChannel','Fib Channel',3],
    ['fibTimeZone','Fib Time Zone',2],['fibFan','Fib Fan',2],['fibSpeedFan','Fib Speed Resistance Fan',2],['fibTime','Trend Fib Time',3],
    ['fibCircles','Fib Circles',2],['fibSpiral','Fib Spiral',2],['fibSpeedArcs','Fib Speed Resistance Arcs',2],['fibWedge','Fib Wedge',3],
  ]},
  {category:'Gann',tools:[
    ['gannBox','Gann Box',2],['gannSquare','Gann Square',2],['gannFan','Gann Fan',2],
  ]},
  {category:'Shapes',tools:[
    ['rectangle','Rectangle',2],['rotatedRectangle','Rotated Rectangle',3],['ellipse','Ellipse',2],['circle','Circle',2],['triangle','Triangle',3],
    ['polyline','Polyline',0],['path','Path',0],['curve','Curve',3],['doubleCurve','Double Curve',3],['arc','Arc',3],
  ]},
  {category:'Patterns',tools:[
    ['xabcd','XABCD Pattern',5],['abcd','ABCD Pattern',4],['headShoulders','Head and Shoulders',7],
    ['gartley','Gartley',5],['bat','Bat',5],['butterfly','Butterfly',5],['crab','Crab',5],['shark','Shark',5],['cypher','Cypher',5],
  ]},
  {category:'Elliott waves',tools:[
    ['impulse','Elliott Impulse',5],['correction','Elliott Correction',3],
  ]},
  {category:'Cycles',tools:[
    ['cyclic','Cyclic Lines',2],['timeCycles','Time Cycles',2],['sine','Sine Line',2],
  ]},
  {category:'Acoustics',tools:[
    ['sonic','Sonic',2],['supersonic','Supersonic',2],['goldenSonic','Golden Sonic',2],['goldenSupersonic','Golden Supersonic',2],['dedekindTessellation','Dedekind Tessellation',2],
  ]},
  {category:'Forecasting',tools:[
    ['long','Long Position',2],['short','Short Position',2],['forecast','Forecast',2],
  ]},
  {category:'Volume',tools:[
    ['anchoredVwap','Anchored VWAP',1],['fixedRangeVolumeProfile','Fixed Range Volume Profile',2,'intraday-volume'],
  ]},
  {category:'Measure',tools:[
    ['measure','Measure',2],['priceRange','Price Range',2],['dateRange','Date Range',2],
  ]},
  {category:'Brushes',tools:[
    ['brush','Brush',-1],['highlighter','Highlighter',-1],
  ]},
  {category:'Arrows',tools:[
    ['arrow','Arrow',2],['arrowUp','Arrow Up',1],['arrowDown','Arrow Down',1],['arrowLeft','Arrow Left',1],['arrowRight','Arrow Right',1],
  ]},
  {category:'Text and notes',tools:[
    ['text','Text',1],['note','Note',1],['priceNote','Price Note',1],['callout','Callout',2],['comment','Comment',1],
    ['priceLabel','Price Label',1],['signpost','Signpost',1],['flag','Flag Mark',1],['balloon','Balloon',1],['table','Table',1],['iconStamp','Icon Stamp',1],
  ]},
] as const;

type ToolTuple = typeof TOOL_GROUPS[number]['tools'][number];
export type DrawingKind = ToolTuple[0];
export type DrawingTool = 'select' | DrawingKind;
export const DRAWING_TOOLS = [
  {id:'select' as const,label:'Select / pan',points:1,category:'Cursor',requires:null},
  ...TOOL_GROUPS.flatMap(group=>group.tools.map(([id,label,points,requires])=>({id,label,points,category:group.category,requires:requires??null})))
];
export const toolSpec=(kind:DrawingTool)=>DRAWING_TOOLS.find(tool=>tool.id===kind)!;
export const annotationTool=(kind:DrawingKind)=>TOOL_GROUPS.find(g=>g.category==='Text and notes')?.tools.some(([id])=>id===kind)??false;
export const waveLabels:Partial<Record<DrawingKind,readonly string[]>>={
  xabcd:['X','A','B','C','D'],cypher:['X','A','B','C','D'],abcd:['A','B','C','D'],
  gartley:['X','A','B','C','D'],bat:['X','A','B','C','D'],butterfly:['X','A','B','C','D'],crab:['X','A','B','C','D'],shark:['X','A','B','C','D'],
  headShoulders:['','LS','','H','','RS',''],
  impulse:['1','2','3','4','5'],correction:['A','B','C'],
};
