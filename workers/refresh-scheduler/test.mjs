import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshCutoff,existingRefresh,triggerRefresh} from './src/index.mjs';

const time=Date.parse('2026-10-14T10:30:00Z');
const run={id:10,head_branch:'main',created_at:'2026-10-14T10:30:00Z',status:'completed',conclusion:'success'};
test('the daily slot survives a fallback arriving after IST midnight',()=>{
  assert.equal(refreshCutoff(time),'2026-10-14T10:30:00Z');
  assert.equal(refreshCutoff(Date.parse('2026-10-14T20:00:00Z')),'2026-10-14T10:30:00Z');
  assert.equal(refreshCutoff(Date.parse('2026-10-15T10:30:00Z')),'2026-10-15T10:30:00Z');
});
test('suppresses completed, active and queued runs but allows failures and early manual runs',()=>{
  const cutoff=refreshCutoff(time);
  for(const status of ['completed','in_progress','queued','pending']) assert.ok(existingRefresh([{...run,status}],cutoff));
  assert.equal(existingRefresh([{...run,conclusion:'failure'}],cutoff),undefined);
  assert.equal(existingRefresh([{...run,created_at:'2026-10-14T08:00:00Z'}],cutoff),undefined);
  assert.equal(existingRefresh([{...run,head_branch:'feature'}],cutoff),undefined);
  assert.equal(existingRefresh([run],cutoff,10),undefined);
  assert.equal(existingRefresh([run],cutoff,11),run);
});
test('dispatches only when the run lookup is complete and empty',async()=>{
  const calls=[];
  const request=async(url,options)=>{
    calls.push({url,options});
    return calls.length===1 ? Response.json({total_count:0,workflow_runs:[]}) : new Response(null,{status:204});
  };
  assert.equal((await triggerRefresh(time,'test-token',request)).action,'dispatched');
  assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(calls[1].options.body),{ref:'main',inputs:{scheduled_refresh:true}});
  assert.ok(calls[0].url.includes('created=%3E%3D2026-10-14T10%3A30%3A00Z'));
});
test('the second check skips an existing daily refresh',async()=>{
  let calls=0;
  const request=async()=>{calls++;return Response.json({total_count:1,workflow_runs:[run]});};
  assert.equal((await triggerRefresh(time+600000,'test-token',request)).action,'skipped');
  assert.equal(calls,1);
});
test('fails closed on credentials, lookup and dispatch errors',async()=>{
  await assert.rejects(triggerRefresh(time,''),/Worker secret/);
  await assert.rejects(triggerRefresh(time,'token',async()=>new Response(null,{status:403})),/lookup failed/);
  await assert.rejects(triggerRefresh(time,'token',async()=>Response.json({total_count:101,workflow_runs:[]})),/Incomplete/);
  let calls=0;
  await assert.rejects(triggerRefresh(time,'token',async()=>++calls===1
    ? Response.json({total_count:0,workflow_runs:[]}) : new Response(null,{status:422})),/dispatch failed/);
});
