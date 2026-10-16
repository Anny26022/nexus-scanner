import { afterEach, expect, it, vi } from 'vitest';
import { DrawingBook } from '../chart/drawings';
import { loadGrid, loadScene, readChartStorage, savedDrawingBook, writeChartStorage, loadNamedLayouts, saveNamedLayouts, exportWorkspaceDocumentJson, importWorkspaceDocumentJson } from '../chart/storage';

afterEach(()=>{localStorage.clear();vi.restoreAllMocks();});
it('validates stored grid and scene versions instead of trusting browser JSON',()=>{
  localStorage.setItem('nexus.chart.grid.v1','{"count":99}');expect(loadGrid().count).toBe(1);
  writeChartStorage('scene.0.v1',{style:'bad',range:-100,emaLines:[{period:0}],studies:{rsi:true,malicious:true},view:{from:'2026-02-30',to:'2026-03-01'},paneWeights:[-1]});
  expect(loadScene('0')).toEqual({studies:{rsi:true,macd:false,sma:false,bollinger:false,vwap:false,atr:false,stochastic:false,supertrend:false}});
  localStorage.setItem('nexus.chart.scene.1.v1','{');expect(loadScene('1')).toEqual({});
});
it('loads a saved chart style without crashing during scene initialization',()=>{
  writeChartStorage('scene.2.v1',{style:'candles',range:6});
  expect(loadScene('2')).toEqual({style:'candles',range:6});
});
it('persists completed drawing edits, undo, redo and deletion but not selection',()=>{
  const book=savedDrawingBook('PERSIST_TEST');
  const write=vi.spyOn(Storage.prototype,'setItem');
  book.add('horizontal',{time:Date.parse('2026-01-01'),price:10});
  const drawing=book.getSnapshot().drawings[0];
  expect(readChartStorage('drawings.PERSIST_TEST.v2')).toEqual({version:2,drawings:[drawing]});
  write.mockClear();book.select(null);expect(write).not.toHaveBeenCalled();
  book.update(drawing.id,{a:{...drawing.a,price:20}});
  book.undo();expect(readChartStorage('drawings.PERSIST_TEST.v2')).toEqual({version:2,drawings:[drawing]});
  book.redo();expect((readChartStorage('drawings.PERSIST_TEST.v2') as {drawings:typeof drawing[]}).drawings[0].a.price).toBe(20);
  book.select(drawing.id);book.deleteSelected();expect(readChartStorage('drawings.PERSIST_TEST.v2')).toEqual({version:2,drawings:[]});
});
it('loads a validated symbol-owned drawing document without persisting replay books',()=>{
  const source=new DrawingBook();source.add('text',{time:Date.parse('2026-01-01'),price:10});
  writeChartStorage('drawings.RESTORE_TEST.v2',{version:2,drawings:source.getSnapshot().drawings});
  expect(savedDrawingBook('RESTORE_TEST').getSnapshot().drawings).toEqual(source.getSnapshot().drawings);
  expect(savedDrawingBook('RESTORE_TEST')).toBe(savedDrawingBook('RESTORE_TEST'));
  const write=vi.spyOn(Storage.prototype,'setItem');write.mockClear();
  const replay=new DrawingBook();replay.add('horizontal',{time:Date.parse('2026-01-02'),price:20});expect(write).not.toHaveBeenCalled();
  writeChartStorage('drawings.CORRUPT_TEST.v2',{version:2,drawings:[{...source.getSnapshot().drawings[0],color:'url(evil)',a:null}]});
  expect(savedDrawingBook('CORRUPT_TEST').getSnapshot().drawings).toEqual([]);
});
it('saves and loads OpenAlgo workspace documents with export and import',()=>{
  const sampleLayout = {
    id: 'test-ws-1',
    name: 'Two charts',
    grid: { ...loadGrid(), layout: '2H', count: 2 },
    scenes: [{ style: 'area' as const }, { style: 'line' as const }, ...Array.from({ length: 14 }, () => ({}))],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
  expect(saveNamedLayouts([sampleLayout])).toBe(true);
  const loaded = loadNamedLayouts();
  expect(loaded[0]).toMatchObject({ name: 'Two charts', grid: { count: 2, layout: '2H' } });
  expect(loaded[0].scenes[0]).toMatchObject({ style: 'area' });
  expect(loaded[0].scenes[1]).toMatchObject({ style: 'line' });

  const json = exportWorkspaceDocumentJson(loaded[0]);
  const imported = importWorkspaceDocumentJson(json);
  expect(imported?.name).toBe('Two charts');
  expect(imported?.grid.layout).toBe('2H');

  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  expect(writeChartStorage('grid.v1', loadGrid())).toBe(false);
});
