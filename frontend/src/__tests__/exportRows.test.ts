import {it, expect, vi, afterEach} from 'vitest';
import {screenerApi} from '../api/screenerApi';
import {realAdapter} from '../api/realAdapter';
import type {ScreenerRunRequest, ScreenerRunResponse, StockRow} from '../types/screener';
const request:ScreenerRunRequest={datasetRevision:'a'.repeat(64),asOfDate:'2026-10-09',universe:'mainboard',
  page:2,pageSize:15,expressionTree:{type:'group',operator:'all',children:[]}};
const rows=(count:number, start=0)=>Array.from({length:count},(_,index)=>({symbol:`S${index+start}`} as StockRow));
const response=(records:StockRow[],count:number)=>({rows:records,matchCount:count,immutableRevision:request.datasetRevision} as ScreenerRunResponse);
afterEach(()=>vi.restoreAllMocks());
it('exports the cached full snapshot set without requesting each page',async()=>{
  const run=vi.spyOn(realAdapter,'runScreen').mockResolvedValue(response(rows(201),201));
  expect(await screenerApi.getExportRows(request)).toHaveLength(201);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith({...request,page:1,pageSize:100},true);
});
it('collects API pages at the same revision and rejects incomplete exports',async()=>{
  const run=vi.spyOn(realAdapter,'runScreen').mockResolvedValueOnce(response(rows(100),101))
    .mockResolvedValueOnce(response(rows(1,100),101));
  expect(await screenerApi.getExportRows(request)).toHaveLength(101);
  expect(run).toHaveBeenLastCalledWith({...request,page:2,pageSize:100});
  run.mockResolvedValueOnce(response(rows(100),101)).mockResolvedValueOnce(response([],101));
  await expect(screenerApi.getExportRows(request)).rejects.toThrow('Results changed');
});
