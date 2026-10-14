import {it, expect, vi, afterEach} from 'vitest';
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react';
import {CopyResults} from '../components/CopyResults';
import {formatCopyResults} from '../utils/copyResults';
afterEach(()=>{cleanup(); vi.unstubAllGlobals();});

it('exports unique symbols with group counts and preserves result order inside each group',()=>{
  const rows = [{symbol:'B',industry:'Sugar'}, {symbol:'A',industry:'Chemicals'},
    {symbol:'C',industry:'Sugar'}, {symbol:'B',industry:'Sugar'}, {symbol:'D'}];
  expect(formatCopyResults(rows,'industry')).toBe('###Chemicals(1),NSE:A,###Sugar(2),NSE:B,NSE:C,###Unclassified(1),NSE:D');
  expect(formatCopyResults(rows,'symbols')).toBe('NSE:B, NSE:A, NSE:C, NSE:D');
});

it('joins themes by symbol without treating missing sub-industry as theme',()=>{
  const taxonomy = {schemaVersion:1,version:'v',asOfDate:'2026-10-09',records:{
    A:{theme:'Data Centres',subIndustry:null,block:'Technology',macro:'Innovation'},
  }};
  expect(formatCopyResults([{symbol:'A'},{symbol:'B'}],'theme',taxonomy)).toBe('###Data Centres(1),NSE:A,###Unclassified(1),NSE:B');
  expect(formatCopyResults([{symbol:'A'}],'subIndustry',taxonomy)).toBe('###Unclassified(1),NSE:A');
});

it('copies the full loader output and allows repeating the same group',async()=>{
  const writeText=vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator',{clipboard:{writeText}});
  render(<CopyResults loadRows={async()=>[{symbol:'FIRST',sector:'Tech'},{symbol:'LAST',sector:'Tech'}]}/>);
  fireEvent.click(screen.getByRole('button',{name:'Copy results'}));
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem',{name:'Symbols'}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledWith('NSE:FIRST, NSE:LAST'));
  const trigger=screen.getByRole('button',{name:'Results copied'});
  await waitFor(()=>expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem',{name:'Sector'}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledWith('###Tech(2),NSE:FIRST,NSE:LAST'));
  await waitFor(()=>expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem',{name:'Sector'}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledTimes(3));
});

it('dismisses the format menu with Escape and returns focus to the icon',()=>{
  render(<CopyResults loadRows={async()=>[]}/>);
  const trigger=screen.getByRole('button',{name:'Copy results'});
  fireEvent.click(trigger);
  expect(screen.getByRole('menuitem',{name:'Symbols'})).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('menu'),{key:'ArrowDown'});
  expect(screen.getByRole('menuitem',{name:'Sector'})).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
