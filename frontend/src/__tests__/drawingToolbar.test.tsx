import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
it('renders floating slider on chart and immediately updates when tools are bookmarked in the drawer', () => {
  const book = new DrawingBook();
  const onCloseMenu = vi.fn();
  render(
    <DrawingToolbar
      book={book}
      firstDate="2026-01-01"
      lastDate="2026-10-14"
      drawingsOpen={true}
      onCloseMenu={onCloseMenu}
    />
  );

  // Floating slider is present with role toolbar
  const slider = screen.getByRole('toolbar', { name: 'Favorite drawing tools' });
  expect(slider).toBeInTheDocument();
  expect(slider.querySelector('.drawing-slider-drag-handle')).toBeInTheDocument();

  // Clicking Parallel Channel in the floating slider activates it
  const channelBtn = screen.getAllByRole('button', { name: 'Parallel Channel' })[0];
  fireEvent.click(channelBtn);
  expect(book.getSnapshot().tool).toBe('channel');

  // Drawer menu has Cursor (Esc)
  const cursorBtn = screen.getByRole('button', { name: 'Cursor' });
  fireEvent.click(cursorBtn);
  expect(book.getSnapshot().tool).toBe('select');
  expect(onCloseMenu).toHaveBeenCalled();

  // Bookmark Fib Retracement in the drawer
  const fibBookmark = screen.getByLabelText('Favorite Fib Retracement');
  fireEvent.click(fibBookmark);

  // Now Fib Retracement appears in the floating slider
  const sliderFibBtn = screen.getAllByRole('button', { name: 'Fib Retracement' }).find(
    b => b.closest('.drawing-floating-slider')
  );
  expect(sliderFibBtn).toBeInTheDocument();
});

it('auto-shows the floating favorites bar when a tool is bookmarked even if the bar was hidden', () => {
  localStorage.setItem('nexus.chart.drawing-favorites-visible.v1', JSON.stringify(false));
  const book = new DrawingBook();
  render(
    <DrawingToolbar
      book={book}
      firstDate="2026-01-01"
      lastDate="2026-10-14"
      drawingsOpen={true}
    />
  );

  // Floating favorites toolbar is initially hidden because drawing-favorites-visible.v1 is false
  expect(screen.queryByRole('toolbar', { name: 'Favorite drawing tools' })).not.toBeInTheDocument();

  // Bookmark a tool (e.g. Trend Line)
  const trendLineBookmark = screen.getByLabelText('Favorite Trend Line');
  fireEvent.click(trendLineBookmark);

  // The floating toolbar automatically appears!
  const slider = screen.getByRole('toolbar', { name: 'Favorite drawing tools' });
  expect(slider).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Trend Line' }).some(
    b => b.closest('.drawing-floating-slider')
  )).toBe(true);
});
