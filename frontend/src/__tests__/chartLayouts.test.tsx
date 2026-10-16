import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CHART_LAYOUTS } from '../chart/layouts';
import { ChartLayoutPicker } from '../components/ChartLayoutPicker';
import { loadGrid } from '../chart/storage';

afterEach(cleanup);
it('defines rectangular, gap-free native CSS grid regions for every layout',()=>{
  expect(CHART_LAYOUTS).toHaveLength(56);
  expect([...new Set(CHART_LAYOUTS.map(layout=>layout.count))]).toEqual([1,2,3,4,5,6,7,8,9,10,12,14,16]);
  expect(new Set(CHART_LAYOUTS.map(layout=>layout.id)).size).toBe(CHART_LAYOUTS.length);
  for(const layout of CHART_LAYOUTS) {
    const rows=layout.rows.map(row=>row.split(' '));
    expect(rows.every(row=>row.length===layout.columns)).toBe(true);
    expect(Number.isFinite(layout.minColumnWidth)).toBe(true);
    expect(layout.edges).not.toMatch(/NaN|Infinity/);
    for(let index=0;index<layout.count;index++) {
      const key=String.fromCharCode(97+index),cells=rows.flatMap((row,y)=>row.flatMap((cell,x)=>cell===key?[{x,y}]:[]));
      expect(cells.length).toBeGreaterThan(0);
      const width=Math.max(...cells.map(cell=>cell.x))-Math.min(...cells.map(cell=>cell.x))+1;
      const height=Math.max(...cells.map(cell=>cell.y))-Math.min(...cells.map(cell=>cell.y))+1;
      expect(cells.length).toBe(width*height);
    }
  }
});
it('selects a visual layout, closes the picker and changes sync options independently',()=>{
  const onLayout=vi.fn(),onLinks=vi.fn();
  render(<ChartLayoutPicker value="3SL" links={{dates:true,symbol:false,interval:false,crosshair:false}} onLayout={onLayout} onLinks={onLinks}/>);
  const details=screen.getByLabelText('Chart grid').closest('details')!;
  fireEvent.click(screen.getByLabelText('Chart grid'));expect(details.open).toBe(true);
  expect(screen.getByRole('button',{name:'3 charts · Large left'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(screen.getByRole('switch',{name:'Sync symbol'}));expect(onLinks).toHaveBeenLastCalledWith({dates:true,symbol:true,interval:false,crosshair:false});
  fireEvent.click(screen.getByRole('button',{name:'6 charts · Six grid'}));expect(onLayout).toHaveBeenCalledWith('6G');expect(details.open).toBe(false);
});
it('migrates legacy four-slot grids and the combined link toggle without losing saved symbols',()=>{
  const old={count:4,linked:true,tiles:['RELIANCE','TCS','INFY','HDFCBANK'].map(symbol=>({symbol,interval:'W'}))};
  const restored=loadGrid(old);
  expect(restored).toMatchObject({count:4,layout:'4G',links:{dates:true,crosshair:true,symbol:false,interval:false}});
  expect(restored.tiles.slice(0,4)).toEqual(old.tiles);expect(restored.tiles).toHaveLength(16);
});
it('preserves eight-slot saves and round-trips sixteen-slot grids',()=>{
  const defaults=loadGrid();
  const old={...defaults,layout:'8G',count:8,tiles:defaults.tiles.slice(0,8)};
  expect(loadGrid(old)).toEqual({...old,tiles:defaults.tiles});
  const full={...defaults,layout:'16G',count:16};
  expect(loadGrid(JSON.parse(JSON.stringify(full)))).toEqual(full);
});
