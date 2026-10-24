import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RotationTracker, type TrackerRow } from '../components/rotation/RotationTracker';

it('bounds rendered rows and keeps all stocks reachable through pagination', () => {
  const rows: TrackerRow[] = Array.from({length: 125}, (_, i) => ({
    item: {id: `S${i}`, label: `S${i}`, detail: '', kind: 'stock', shard: 'core'},
    point: {x: 101, y: 101}, quadrant: 'leading', angle: 0, moved: 1, trail: [],
  }));
  const props = {half: {x: 2, y: 1}, sort: 'quadrant' as const, onSort: vi.fn(), onOpen: vi.fn(), onShow: vi.fn()};
  const {container, rerender} = render(<RotationTracker rows={rows} {...props} />);
  expect(container.querySelectorAll('.rot-trow:not(.is-head)')).toHaveLength(50);
  expect(screen.getByRole('button', {name: 'Previous'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  expect(container.querySelectorAll('.rot-trow:not(.is-head)')).toHaveLength(25);
  expect(screen.getByText('S124')).toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Next'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button', {name: 'Open S124 chart'}));
  expect(props.onOpen).toHaveBeenCalledWith(rows[124].item);
  rerender(<RotationTracker rows={rows.slice(0, 3)} {...props} />);
  expect(container.querySelectorAll('.rot-trow:not(.is-head)')).toHaveLength(3);
  expect(screen.queryByRole('navigation', {name: 'Tracker pages'})).not.toBeInTheDocument();
});
