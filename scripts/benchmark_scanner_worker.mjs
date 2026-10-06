/** Run the real Worker in local workerd against an offline immutable pack.
 * Usage: node scripts/benchmark_scanner_worker.mjs /absolute/path/to/pack
 * Local R2 timings are not deployed Cloudflare edge/R2 timings.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'cloudflare/scanner-worker/package.json'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const {build}=require('esbuild');
const {WebSocket}=require('ws');
const pack=path.resolve(process.argv[2]??'');
const manifest=JSON.parse(await readFile(path.join(pack,'manifest.json'),'utf8'));
if(manifest.symbols<2000&&!process.argv.includes('--smoke'))throw new Error(`Only ${manifest.symbols} stocks: refusing a full-universe performance report. Use --smoke solely to test the harness.`);
const temporary=path.join(pack,'benchmark');await mkdir(temporary,{recursive:true});
const scriptPath=path.join(temporary,'worker.mjs');
await build({entryPoints:[path.join(root,'cloudflare/scanner-worker/src/index.ts')],bundle:true,format:'esm',platform:'browser',outfile:scriptPath});
const release={...manifest,sessionDate:manifest.session};
const mf=new Miniflare(convertV4MiniflareOptions({name:'scanner-performance',modules:true,script:await readFile(scriptPath,'utf8'),compatibilityDate:'2026-09-27',
  inspectorPort:9339,unsafeInspectorProxy:true,r2Buckets:['SCANNER_DATA'],
  bindings:{ALLOWED_ORIGINS:'http://localhost:8080',SCANNER_RELEASE_URL:'https://validation.invalid/current.json'},
  outboundService:async()=>new Response(JSON.stringify(release),{headers:{'content-type':'application/json'}})}));
let ws;
try{
  await mf.ready;
  const bucket=await mf.getR2Bucket('SCANNER_DATA');
  const prefix=`scanner/v1/revisions/${manifest.revision}/`;
  for(const object of manifest.objects){
    if(object.key.startsWith('base-history/')||object.key.startsWith('base-ranks/'))continue;
    await bucket.put(prefix+object.key,await readFile(path.join(pack,object.key)));
  }
  await bucket.put(prefix+'manifest.json',JSON.stringify(manifest));
  const targets=await (await fetch('http://127.0.0.1:9339/json/list')).json();
  const target=targets.find(item=>item.webSocketDebuggerUrl&&String(item.title).includes('scanner-performance'))??targets.find(item=>item.webSocketDebuggerUrl);
  if(!target)throw new Error('workerd inspector target is unavailable');
  ws=new WebSocket(target.webSocketDebuggerUrl,{headers:{Origin:'http://localhost'}});
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let nextId=1;const pending=new Map();
  ws.addEventListener('message',event=>{const value=JSON.parse(event.data);const request=pending.get(value.id);if(request){pending.delete(value.id);value.error?request.reject(new Error(JSON.stringify(value.error))):request.resolve(value.result);}});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`Inspector timeout: ${method}`));},10000);pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});ws.send(JSON.stringify({id,method,params}));});
  await command('Runtime.enable');
  await command('Runtime.runIfWaitingForDebugger');
  await command('Profiler.enable');await command('Profiler.setSamplingInterval',{interval:1000});
  const identity={engineVersion:manifest.engineVersion,conditionContractHash:manifest.conditionContractHash};
  const leaf=(conditionId,parameters={})=>({type:'condition',condition:{instanceId:conditionId,conditionId,parameters}});
  const screens=[
    ['scalar',leaf('FIELD_COMPARISON',{field:'close',comparison:'GREATER',value:100})],
    ['advanced',leaf('MA_CONVERGENCE',{periods:'9,20,50,200',maType:'EMA',comparison:'BELOW',maxSpreadPct:1,withinDays:1})],
    ['base-family',leaf('lib-nexus-multi-year-setup')],
    ['nested',{type:'group',operator:'all',children:[leaf('ADX',{period:14,comparison:'ABOVE',value:25}),leaf('PRICE_VS_EMA',{period:50,comparison:'ABOVE',persistDays:1})]}],
  ];
  const results=[];
  for(const [name,expressionTree] of screens){
    const payload={...identity,datasetRevision:manifest.revision,asOfDate:manifest.session,universe:'mainboard',page:1,pageSize:100,expressionTree};
    const request=()=>mf.dispatchFetch('http://localhost:8080/v1/screens/run',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:8080'},body:JSON.stringify(payload)});
    const measurements=[],samplingErrors=[];
    let polling=false;
    const timer=setInterval(async()=>{if(polling)return;polling=true;try{measurements.push(await command('Runtime.getHeapUsage'));}catch(error){samplingErrors.push(String(error));}finally{polling=false;}},25);
    await command('Profiler.start');const started=performance.now();
    const response=await request();const body=await response.json();
    const coldMs=performance.now()-started;clearInterval(timer);
    const {profile}=await command('Profiler.stop');
    measurements.push(await command('Runtime.getHeapUsage'));
    if(response.status!==200)throw new Error(`${name}: HTTP ${response.status}: ${JSON.stringify(body)}`);
    const frames=new Map(profile.nodes.map(node=>[node.id,node.callFrame.functionName]));
    let activeSampleMicroseconds=0;
    for(let i=0;i<(profile.samples??[]).length;i++)if(!['(idle)','(program)'].includes(frames.get(profile.samples[i])))activeSampleMicroseconds+=profile.timeDeltas[i]??0;
    const cachedStarted=performance.now();const cached=await request();await cached.arrayBuffer();
    const cachedMs=performance.now()-cachedStarted;
    const peakV8Bytes=Math.max(...measurements.map(value=>value.usedSize+(value.backingStorageSize??0)+(value.embedderHeapUsedSize??0)));
    const result={name,coldMs,cachedMs,matchCount:body.matchCount,totalUniverseCount:body.totalUniverseCount,
      unavailableDiagnostics:body.unavailableDiagnostics,profileActiveSampleMs:activeSampleMicroseconds/1000,
      peakV8Bytes,heapSamples:measurements.length,samplingErrors};
    results.push(result);console.log(JSON.stringify(result));
  }
    const report={runtime:'local workerd/Miniflare',revision:manifest.revision,session:manifest.session,stocks:manifest.symbols,
    limits:{coldMs:10000,cachedMs:500,peakV8Bytes:100*1024*1024,profileActiveSampleMs:30000},results,
    smoke:process.argv.includes('--smoke'),
    sampledLocalAcceptance:results.every(result=>result.coldMs<=10000&&result.cachedMs<=500&&result.peakV8Bytes<100*1024*1024&&result.profileActiveSampleMs<30000&&result.samplingErrors.length===0),
    caveats:['R2 and Cache API are local fixtures; deployed edge latency remains unmeasured.',
      'V8 inspector reports sampled heap/backing memory; it is not total Cloudflare isolate memory.',
      'CPU profile active samples are an estimate, not billed Cloudflare CPU time.']};
  await writeFile(path.join(pack,'worker-performance.json'),JSON.stringify(report,null,2));
}finally{ws?.close();await mf.dispose();}
