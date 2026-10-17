import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultEmaLines, validEmaLine } from '../chart/model';
import { EmaSettings, EMA_PREFS_KEY, loadEmaLines } from '../components/EmaSettings';

afterEach(()=>{cleanup();localStorage.removeItem(EMA_PREFS_KEY);});
it('uses the verified colors/defaults, validates saved preferences and permits no EMAs',()=>{
  expect(defaultEmaLines().map(({period,color,enabled})=>({period,color,enabled}))).toEqual([
    {period:9,color:'#f59e0b',enabled:true},{period:20,color:'#8b5cf6',enabled:true},{period:50,color:'#22d3ee',enabled:false},
  ]);
  localStorage.setItem(EMA_PREFS_KEY,'not json'); expect(loadEmaLines()).toEqual(defaultEmaLines());
  localStorage.setItem(EMA_PREFS_KEY,JSON.stringify([{...defaultEmaLines()[0],period:0}])); expect(loadEmaLines()).toEqual(defaultEmaLines());
  localStorage.setItem(EMA_PREFS_KEY,'[]'); expect(loadEmaLines()).toEqual([]);
  expect(validEmaLine({...defaultEmaLines()[0],opacity:NaN})).toBe(false);
});
it('edits periods, colors and styles without applying incomplete drafts, and adds/removes lines',()=>{
  const apply=vi.fn(); render(<EmaSettings lines={defaultEmaLines()} onApply={apply}/>);
  fireEvent.change(screen.getByLabelText('EMA 1 period'),{target:{value:'21'}});
  fireEvent.change(screen.getByLabelText('EMA 1 color'),{target:{value:'#d8870c'}});
  fireEvent.change(screen.getByLabelText('EMA 1 style'),{target:{value:'dashed'}});
  fireEvent.change(screen.getByLabelText('EMA 1 width'),{target:{value:'3'}});
  fireEvent.change(screen.getByLabelText('EMA 1 opacity'),{target:{value:'0.5'}});
  expect(apply).not.toHaveBeenCalled(); fireEvent.submit(screen.getByRole('form',{name:'EMA settings'}));
  expect(apply.mock.lastCall![0][0]).toMatchObject({period:21,color:'#d8870c',style:'dashed',width:3,opacity:.5});
  fireEvent.click(screen.getByRole('button',{name:'Add EMA'})); fireEvent.click(screen.getByRole('button',{name:'Add EMA'}));
  expect(screen.getByRole('button',{name:'Add EMA'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Remove EMA 5'})); expect(screen.getByRole('button',{name:'Add EMA'})).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText('EMA 1 period'),{target:{value:'0'}});
  fireEvent.submit(screen.getByRole('form',{name:'EMA settings'}));
  expect(screen.getByRole('alert')).toBeInTheDocument(); expect(apply).toHaveBeenCalledOnce();
});
