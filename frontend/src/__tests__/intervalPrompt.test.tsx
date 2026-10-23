import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IntervalPrompt, parseInterval } from '../components/IntervalPrompt';

afterEach(cleanup);

it('reads TradingView interval text', () => {
  expect(['1D', 'd', '1 W', 'W', '1m', 'M'].map(parseInterval)).toEqual(['D', 'D', 'W', 'W', 'M', 'M']);
  expect(['5D', '15', '360ONE', ''].map(parseInterval)).toEqual([null, null, null, null]);
});

it('applies an interval on Enter, and sends anything else to symbol search', () => {
  const onInterval = vi.fn(), onSymbol = vi.fn(), onClose = vi.fn();
  const {unmount} = render(<IntervalPrompt initial="1" onInterval={onInterval} onSymbol={onSymbol} onClose={onClose} />);
  const input = screen.getByLabelText('Interval');
  fireEvent.change(input, {target: {value: '1w'}});
  fireEvent.submit(input.closest('form')!);
  expect(onInterval).toHaveBeenCalledWith('W');
  unmount();
  render(<IntervalPrompt initial="3" onInterval={onInterval} onSymbol={onSymbol} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText('Interval'), {target: {value: '3mindia'}});
  fireEvent.submit(screen.getByLabelText('Interval').closest('form')!);
  expect(onSymbol).toHaveBeenCalledWith('3MINDIA');
  expect(onInterval).toHaveBeenCalledTimes(1);
});
