import {expect,it} from 'vitest';
import {tableLayout} from '../utils/tableLayout';

it('preserves desktop table order and percentage sizing', () => {
  const columns = [{id:'company',width:'24%'},{id:'sector',width:'17%'},{id:'close',width:'12%'}];
  const layout = tableLayout(columns,'screener',false,false);
  expect(layout.columns).toBe(columns);
  expect(layout.style).toEqual({width:'100%',minWidth:'1120px'});
  expect(layout.columns.map(layout.columnWidth)).toEqual(['24%','17%','12%']);
});

it('prioritizes phone quotes without mutating input or the remaining column order', () => {
  const columns = [{id:'company'},{id:'sector'},{id:'rvol'},{id:'close'},{id:'changePct'}];
  const layout = tableLayout(columns,'screener',true,false);
  expect(layout.columns.map(column=>column.id)).toEqual(['company','close','changePct','sector','rvol']);
  expect(columns.map(column=>column.id)).toEqual(['company','sector','rvol','close','changePct']);
  expect(layout.columns.map(layout.columnWidth)).toEqual(['176px','100px','88px','180px','150px']);
  expect(layout.style).toEqual({width:'100%',minWidth:'694px'});
});

it('uses the same widths for custom table totals, rendered columns and windowing', () => {
  const columns = [{id:'company'},{id:'sectorIndustry'}, ...Array.from({length:10},(_,id)=>({id:String(id)}))];
  const layout = tableLayout(columns,'ipo',false,true);
  const total = columns.reduce((sum,column)=>sum+layout.widthOf(column),0);
  expect(layout.widthOf(columns[1])).toBe(190);
  expect(total).toBe(2130);
  expect(layout.style).toEqual({width:'2130px',minWidth:'2130px'});
  expect(columns.reduce((sum,column)=>sum+parseInt(layout.columnWidth(column)!),0)).toBe(total);
});

it('preserves IPO defaults and only changes order and sizing on phones', () => {
  const columns = [{id:'company'},{id:'sectorIndustry'},{id:'listingDate'},{id:'currentPrice'},{id:'deliveryPct'}];
  const desktop = tableLayout(columns,'ipo',false,false);
  expect(desktop.style).toEqual({width:'100%',minWidth:'1080px'});
  expect(columns.map(desktop.columnWidth)).toEqual(['26%','17%','12%','12%','9%']);
  const phone = tableLayout(columns,'ipo',true,false);
  expect(phone.columns.map(column=>column.id)).toEqual(['company','currentPrice','listingDate','sectorIndustry','deliveryPct']);
  expect(phone.columns.map(phone.columnWidth)).toEqual(['176px','110px','150px','150px','150px']);
});

it('lets short column selections fill the phone and respects the desktop custom minimum', () => {
  for (const kind of ['ipo','screener'] as const) {
    expect(tableLayout([{id:'company'}],kind,true,true).style).toEqual({width:'100%',minWidth:'176px'});
    expect(tableLayout([{id:'company'}],kind,false,true).style).toEqual({width:'1120px',minWidth:'1120px'});
  }
});
