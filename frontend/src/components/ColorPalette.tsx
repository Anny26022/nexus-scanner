import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Plus } from 'lucide-react';

/** TradingView's swatch grid: greys, then the main hues, then six tint rows light → dark. */
const GREYS = ['#ffffff', '#d1d4dc', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000'];
const MAIN = ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'];
const TINTS = [
  ['#fccbcd', '#ffe0b2', '#fff9c4', '#c8e6c9', '#ace5dc', '#b2ebf2', '#bbd9fb', '#d1c4e9', '#e1bee7', '#f8bbd0'],
  ['#faa1a4', '#ffcc80', '#fff59d', '#a5d6a7', '#70ccbd', '#80deea', '#90bff9', '#b39ddb', '#ce93d8', '#f48fb1'],
  ['#f77c80', '#ffb74d', '#fff176', '#81c784', '#42bda8', '#4dd0e1', '#5b9cf6', '#9575cd', '#ba68c8', '#f06292'],
  ['#f7525f', '#ffa726', '#ffee58', '#66bb6a', '#22ab94', '#26c6da', '#3179f5', '#7e57c2', '#ab47bc', '#ec407a'],
  ['#b22833', '#f57c00', '#fbc02d', '#388e3c', '#056656', '#0097a7', '#1848cc', '#512da8', '#7b1fa2', '#c2185b'],
  ['#801922', '#e65100', '#f57f17', '#1b5e20', '#00332a', '#006064', '#0c3299', '#311b92', '#4a148c', '#880e4f'],
];
const CUSTOM_KEY = 'nexus.chart.custom-colors.v1';

/** Splits #rrggbb / #rrggbbaa into the base colour and 0–100 opacity. */
export function splitColor(value: string): {base: string; opacity: number} {
  const hex = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value.toLowerCase() : '#000000';
  return {base: hex.slice(0, 7), opacity: hex.length === 9 ? Math.round(Number.parseInt(hex.slice(7), 16) / 255 * 100) : 100};
}
/** #rrggbb at 100%, otherwise #rrggbbaa. */
export function joinColor(base: string, opacity: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(opacity)));
  return clamped >= 100 ? base : `${base}${Math.round(clamped / 100 * 255).toString(16).padStart(2, '0')}`;
}

function readCustom(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string' && /^#[0-9a-f]{6}$/i.test(item)).slice(0, 10) : [];
  } catch { return []; }
}

/** Colour well that opens the palette; `value` and `onChange` use #rrggbb or #rrggbbaa. */
export function ColorPalette({value, onChange, ariaLabel, disabled = false}: {value: string; onChange: (value: string) => void; ariaLabel: string; disabled?: boolean}) {
  const {base, opacity} = splitColor(value);
  const [custom, setCustom] = useState(readCustom);
  const pick = (next: string) => onChange(joinColor(next, opacity));
  const addCustom = (next: string) => {
    const list = [next, ...custom.filter(item => item !== next)].slice(0, 10);
    setCustom(list);
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* per-viewer convenience only */ }
    pick(next);
  };
  const swatch = (color: string) => <button key={color} type="button" role="option" aria-selected={color === base}
    aria-label={color} title={color} className="cp-swatch" style={{background: color}} onClick={() => pick(color)} />;

  return <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className="cs-swatch" aria-label={ariaLabel} title={ariaLabel} disabled={disabled}>
        <span style={{backgroundColor: value}} />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="cp-panel" side="bottom" align="start" sideOffset={6} collisionPadding={12} aria-label={`${ariaLabel} palette`}>
        <div className="cp-grid" role="listbox" aria-label="Colours">{GREYS.map(swatch)}{MAIN.map(swatch)}</div>
        <div className="cp-grid cp-tints" role="listbox" aria-label="Tints">{TINTS.flat().map(swatch)}</div>
        <div className="cp-divider" />
        <div className="cp-custom">
          {custom.map(swatch)}
          <label className="cp-add" title="Custom colour">
            <Plus size={16} aria-hidden="true" />
            <input type="color" aria-label={`${ariaLabel} custom`} value={base} onChange={event => addCustom(event.target.value)} />
          </label>
        </div>
        <div className="cp-opacity-label">Opacity</div>
        <div className="cp-opacity">
          <input type="range" min={0} max={100} value={opacity} aria-label={`${ariaLabel} opacity`} style={{'--cp-color': base} as React.CSSProperties}
            onChange={event => onChange(joinColor(base, Number(event.target.value)))} />
          <label className="cp-percent">
            <input type="number" min={0} max={100} value={opacity} aria-label={`${ariaLabel} opacity percent`}
              onChange={event => onChange(joinColor(base, Number(event.target.value)))} />%
          </label>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
