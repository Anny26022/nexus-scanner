import {afterEach, expect, it, vi} from 'vitest';

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('loads old release histories in a worker and returns the selected symbol',async()=>{
  const worker={onmessage:null as null|((event:MessageEvent)=>void),onerror:null,postMessage:vi.fn(),terminate:vi.fn()};
  vi.stubGlobal('Worker',vi.fn(class {constructor(){return worker;}}));
  const {legacyFinancialHistory}=await import('../api/financialHistoryClient');
  const result=legacyFinancialHistory('/old.json.gz','TEST');
  const {id}=worker.postMessage.mock.calls[0][0];
  expect(worker.postMessage).toHaveBeenCalledWith({id,url:'/old.json.gz',symbol:'TEST'});
  worker.onmessage!(new MessageEvent('message',{data:{id,value:{observed_on:'2026-10-22'}}}));
  await expect(result).resolves.toMatchObject({observed_on:'2026-10-22'});
});
