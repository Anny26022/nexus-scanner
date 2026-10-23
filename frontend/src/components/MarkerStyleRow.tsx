import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import { MARKER_SHAPES, drawMarkerShape, type MarkerShape, type MarkerStyle } from '../chart/markerShapes';
import { ColorPalette } from './ColorPalette';

/** A tiny canvas preview of a shape, drawn with the same code as the chart. */
function ShapeIcon({shape, color = 'currentColor'}: {shape: MarkerShape; color?: string}) {
  return <canvas width={32} height={32} className="ms-icon" aria-hidden="true" ref={canvas => {
    const context = canvas?.getContext?.('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, 32, 32);
    const stroke = color === 'currentColor' ? getComputedStyle(canvas).color : color;
    drawMarkerShape(context, shape, 16, 16, 18, stroke);
  }} />;
}

/** TradingView's shape dropdown: Arrow Down … X Cross. */
export function ShapePicker({value, onChange, ariaLabel}: {value: MarkerShape; onChange: (shape: MarkerShape) => void; ariaLabel: string}) {
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" className="ms-trigger" aria-label={ariaLabel} title={MARKER_SHAPES.find(([id]) => id === value)?.[1]}>
        <ShapeIcon shape={value} /><ChevronDown size={12} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="ms-menu" side="bottom" align="start" sideOffset={4} collisionPadding={12} role="listbox" aria-label={`${ariaLabel} options`}>
        {MARKER_SHAPES.map(([id, label]) => <button key={id} type="button" role="option" aria-selected={id === value} className="ms-option"
          onClick={() => { onChange(id); setOpen(false); }}>
          <ShapeIcon shape={id} /><span>{label}</span>
        </button>)}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

/** Checkbox, colour and shape for one kind of chart marker. */
export function MarkerStyleRow({label, style, onChange, shapes = true}: {
  label: string; style: Required<MarkerStyle>; onChange: (next: Required<MarkerStyle>) => void; shapes?: boolean;
}) {
  return <div className="ms-row">
    <label className="ms-check">
      <input type="checkbox" aria-label={`Show ${label}`} checked={style.visible} onChange={event => onChange({...style, visible: event.target.checked})} />
      <span>{label}</span>
    </label>
    <div className="ms-controls">
      <ColorPalette value={style.color} ariaLabel={`${label} color`} onChange={color => onChange({...style, color})} disabled={!style.visible} />
      {shapes && <ShapePicker value={style.shape} ariaLabel={`${label} shape`} onChange={shape => onChange({...style, shape})} />}
    </div>
  </div>;
}
