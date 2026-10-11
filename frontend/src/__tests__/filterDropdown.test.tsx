import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenerModal } from '../components/ScreenerModal';

afterEach(cleanup);

it('announces selected bands and consumes Escape without closing the filter dialog', () => {
  const close = vi.fn();
  render(<ScreenerModal isOpen onClose={close} matchMode="all" activeConditionsMap={{}} onApply={vi.fn()} />);
  const trigger = screen.getByRole('button', {name: 'Band limit to exclude: 2 selected'});
  fireEvent.click(trigger);
  const option = screen.getByRole('checkbox', {name: '20% Circuit Limit'});
  fireEvent.click(option);
  expect(trigger).toHaveAccessibleName('Band limit to exclude: 3 selected');
  option.focus();
  expect(fireEvent.keyDown(option, {key: 'Escape'})).toBe(false);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
});
