import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DrawingBook } from '../chart/drawings';
import { DrawingToolbar } from '../components/DrawingToolbar';
import { DRAWING_TOOLS } from '../chart/drawings';

afterEach(cleanup);
it('keeps the complete 87-item OpenAlgo tool inventory while disabling volume profiles without intraday data',()=>{
  expect(DRAWING_TOOLS.filter(tool=>tool.id!=='select')).toHaveLength(87);
  const book=new DrawingBook();
  render(<DrawingToolbar book={book} firstDate="2026-01-01" lastDate="2026-10-14"/>);
  fireEvent.click(screen.getByLabelText('All drawing tools'));
  expect(screen.getByRole('button',{name:'Choose Fixed Range Volume Profile'})).toBeDisabled();
  expect(screen.getAllByText('Needs intraday data')).toHaveLength(1);
});
it('keeps tools labeled and reveals exact edits only for the selected drawing',()=>{
  const book=new DrawingBook();
  render(<DrawingToolbar book={book} firstDate="2026-01-01" lastDate="2026-10-14"/>);
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Text'}));
  fireEvent.change(screen.getByLabelText('New annotation text'),{target:{value:'Support'}});
  expect(book.getSnapshot().text).toBe('Support');
  const a={time:Date.parse('2026-02-01'),price:50};
  // This is the same external-store notification as a completed canvas gesture.
  fireEvent.click(screen.getByRole('button',{name:'Horizontal Line'}));
  act(()=>book.add('horizontal',a));
  const settings=document.querySelector('.drawing-settings') as HTMLDetailsElement;
  expect(settings.open).toBe(false);
  fireEvent.click(settings.querySelector('summary')!);
  expect(settings.open).toBe(true);
  fireEvent.change(screen.getByLabelText('Start price'),{target:{value:'60'}});
  fireEvent.submit(screen.getByRole('form',{name:'Edit selected drawing'}));
  expect(book.getSnapshot().drawings[0].a.price).toBe(60);
  fireEvent.click(screen.getByRole('button',{name:'Delete selected drawing'}));
  expect(book.getSnapshot().drawings).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Undo drawing'}));
  expect(book.getSnapshot().drawings[0].a.price).toBe(60);
});
