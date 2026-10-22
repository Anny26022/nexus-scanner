import {it, expect, vi, afterEach} from 'vitest';
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react';
import {CopyResults} from '../components/CopyResults';
import {formatCopyResults} from '../utils/copyResults';
afterEach(()=>{cleanup(); vi.unstubAllGlobals();});

it('exports unique symbols with group counts and preserves result order inside each group',()=>{
  const rows = [{symbol:'B',industry:'Sugar'}, {symbol:'A',industry:'Chemicals'},
    {symbol:'C',industry:'Sugar'}, {symbol:'B',industry:'Sugar'}, {symbol:'D'}];
  expect(formatCopyResults(rows,'industry')).toBe('###Sugar(2),NSE:B,NSE:C,###Chemicals(1),NSE:A,###Unclassified(1),NSE:D');
  expect(formatCopyResults(rows,'symbols')).toBe('NSE:B, NSE:A, NSE:C, NSE:D');
});

it('orders groups descending by number of stocks in tradingview section format', () => {
  const rows = [
    { symbol: 'AUTO1', sector: 'Automobile' },
    { symbol: 'BANK1', sector: 'Banking' },
    { symbol: 'BANK2', sector: 'Banking' },
    { symbol: 'BANK3', sector: 'Banking' },
    { symbol: 'AUTO2', sector: 'Automobile' },
    { symbol: 'IT1', sector: 'Information Technology' },
  ];
  expect(formatCopyResults(rows, 'sector')).toBe(
    '###Banking(3),NSE:BANK1,NSE:BANK2,NSE:BANK3,###Automobile(2),NSE:AUTO1,NSE:AUTO2,###Information Technology(1),NSE:IT1'
  );
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

it('formats CSV results with properly escaped headers and values', async () => {
  const { escapeCsvField, formatCsvResults } = await import('../utils/copyResults');
  expect(escapeCsvField('Simple')).toBe('Simple');
  expect(escapeCsvField('Quotes "Inside"')).toBe('"Quotes ""Inside"""');
  expect(escapeCsvField('Has, comma')).toBe('"Has, comma"');
  expect(escapeCsvField(null)).toBe('');
  expect(escapeCsvField(123.45)).toBe('123.45');

  const rows = [
    { symbol: 'RELIANCE', close: 2950.5, name: 'Reliance Industries, Ltd.' },
    { symbol: 'TCS', close: 3800, name: 'Tata "Consultancy" Services' },
  ];
  const columns = [
    { id: 'symbol', label: 'Symbol' },
    { id: 'name', label: 'Company Name' },
    { id: 'close', label: 'Close Price', getValue: (r: any) => `₹${r.close}` },
  ];

  const csv = formatCsvResults(rows, columns);
  const lines = csv.split('\r\n');
  expect(lines[0]).toBe('Symbol,Company Name,Close Price');
  expect(lines[1]).toBe('RELIANCE,"Reliance Industries, Ltd.",₹2950.5');
  expect(lines[2]).toBe('TCS,"Tata ""Consultancy"" Services",₹3800');
});

