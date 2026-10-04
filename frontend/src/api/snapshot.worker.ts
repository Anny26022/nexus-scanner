import { createSnapshotEngine, type SnapshotTask } from './snapshotEngine';
const run = createSnapshotEngine();
self.onmessage = async (event: MessageEvent<{id:number;task:SnapshotTask}>) => {
  const {id,task} = event.data;
  try { self.postMessage({id,result:await run(task)}); }
  catch (error) { self.postMessage({id,error:error instanceof Error ? error.message : 'Snapshot processing failed'}); }
};
