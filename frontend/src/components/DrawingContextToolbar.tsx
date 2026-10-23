import { useSyncExternalStore } from 'react';
import { Lock, Unlock, Trash2, X } from 'lucide-react';
import { type DrawingBook, type LineDash } from '../chart/drawings';
import { ColorPalette } from './ColorPalette';

const PALETTE = ['#187669', '#089981', '#ef5350', '#f59e0b', '#8b5cf6', '#06b6d4', '#ffffff', '#787b86'];
const WIDTHS: readonly { value: number; label: string }[] = [
  { value: 1, label: '1px' },
  { value: 1.5, label: '1.5px' },
  { value: 2, label: '2px' },
  { value: 3, label: '3px' },
  { value: 4, label: '4px' },
];
const DASHES: readonly { value: LineDash; label: string; icon: string }[] = [
  { value: 'solid', label: 'Solid', icon: '—' },
  { value: 'dashed', label: 'Dashed', icon: '---' },
  { value: 'dotted', label: 'Dotted', icon: '···' },
];

export function DrawingContextToolbar({ book }: { book: DrawingBook }) {
  const snapshot = useSyncExternalStore(book.subscribe, book.getSnapshot, book.getSnapshot);
  const selectedId = snapshot.selectedId;
  const drawing = selectedId ? snapshot.drawings.find((d) => d.id === selectedId) : null;

  if (!drawing) return null;

  const currentColor = drawing.color === 'accent' ? '#187669' : drawing.color;
  const currentWidth = drawing.width;
  const currentDash: LineDash = drawing.dash ?? 'solid';
  const isLocked = !!drawing.locked;

  return (
    <div
      className="drawing-context-toolbar"
      role="toolbar"
      aria-label="Drawing properties"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ColorPalette value={currentColor} onChange={(color) => book.update(drawing.id, { color })} ariaLabel="Drawing color" />

      <div className="drawing-context-palette">
        {PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            className="drawing-context-color-btn"
            style={{ backgroundColor: color }}
            aria-label={`Color ${color}`}
            onClick={() => book.update(drawing.id, { color })}
          />
        ))}
      </div>

      <div className="drawing-context-divider" aria-hidden="true" />

      <select
        className="drawing-context-select"
        aria-label="Line width"
        value={currentWidth}
        onChange={(e) => book.update(drawing.id, { width: Number(e.target.value) })}
      >
        {WIDTHS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <select
        className="drawing-context-select"
        aria-label="Line style"
        value={currentDash}
        onChange={(e) => book.update(drawing.id, { dash: e.target.value as LineDash })}
      >
        {DASHES.map(({ value, label, icon }) => (
          <option key={value} value={value}>
            {icon} {label}
          </option>
        ))}
      </select>

      <div className="drawing-context-divider" aria-hidden="true" />

      <button
        type="button"
        className="drawing-context-btn"
        aria-label={isLocked ? 'Unlock drawing' : 'Lock drawing'}
        title={isLocked ? 'Unlock' : 'Lock'}
        onClick={() => book.update(drawing.id, { locked: !isLocked })}
      >
        {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>

      <button
        type="button"
        className="drawing-context-btn drawing-context-delete"
        aria-label="Delete drawing"
        title="Delete (Del)"
        onClick={() => book.deleteSelected()}
      >
        <Trash2 size={14} />
      </button>

      <button
        type="button"
        className="drawing-context-btn"
        aria-label="Deselect drawing"
        title="Deselect"
        onClick={() => book.select(null)}
      >
        <X size={14} />
      </button>
    </div>
  );
}
