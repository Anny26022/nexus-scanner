import { useMemo, useState } from 'react';
import type { Candle } from '../chart/model';
import {
  SIZING_POSITIONS, SIZING_TEXT_SIZES, formatPercent, positionSizing, positionSizingConfig,
  type PositionSizingConfig, type SizingSide,
} from '../chart/positionSizing';
import { ChartDialog } from './ChartDialog';
import { Button } from './Button';
import { ColorPalette } from './ColorPalette';
import { placed, useOverlayDrag } from './FundamentalsIndicator';

const quantity = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 0});
const price = new Intl.NumberFormat('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const rupees = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 2});

/** The sizing table: one row per stop, quantity for the portfolio risk, and the allocation it needs. */
export function PositionSizingIndicator({symbol, daily, through, config: raw, onMove}: {
  symbol: string; daily: readonly Candle[]; through: string; config: PositionSizingConfig; onMove?: (offset: {x: number; y: number}) => void;
}) {
  const config = useMemo(() => positionSizingConfig(raw), [raw]);
  const sizing = useMemo(() => positionSizing(daily, through, config), [daily, through, config]);
  const drag = useOverlayDrag(onMove);
  if (!sizing) return null;
  return <section className="ps-card pb-card" data-position={config.position} data-size={config.textSize} tabIndex={0}
    aria-label={`${symbol} position sizing`} title="Drag the handle to move; arrow keys nudge when focused"
    style={placed(drag.live ?? config.offset)} {...drag.handlers}>
    <div className="pb-drag-handle" aria-hidden="true">•••</div>
    <table>
      <thead><tr>
        <th scope="col" data-side={sizing.long ? 'long' : 'short'}>{sizing.long ? '▲ Long' : '▼ Short'}</th>
        <th scope="col">Qty</th><th scope="col">SL %</th><th scope="col">SL Price</th><th scope="col" className="ps-alloc">Alloc %</th>
      </tr></thead>
      <tbody>{sizing.rows.map(row => <tr key={row.name}>
        <th scope="row"><span className="ps-swatch" style={{background: row.color}} aria-hidden="true" />{row.name}</th>
        <td>{quantity.format(row.qty)}</td><td>{formatPercent(row.stopPercent)}</td><td>{price.format(row.stopPrice)}</td>
        <td className="ps-alloc">{formatPercent(row.allocationPercent)}</td>
      </tr>)}</tbody>
      <tfoot><tr><td colSpan={5}>PF RISK {formatPercent(config.riskPercent)}{config.showRiskAmount && <> · ₹{rupees.format(sizing.riskAmount)}</>}</td></tr></tfoot>
    </table>
  </section>;
}

export function PositionSizingSettingsDialog({config: raw, onApply, onClose}: {
  config?: PositionSizingConfig; onApply: (next: PositionSizingConfig) => void; onClose: () => void;
}) {
  const [config, setConfig] = useState(() => positionSizingConfig(raw));
  const set = (change: Partial<PositionSizingConfig>) => setConfig(current => ({...current, ...change}));
  const setStop = (index: number, change: Partial<PositionSizingConfig['stops'][number]>) =>
    set({stops: config.stops.map((stop, at) => at === index ? {...stop, ...change} : stop)});
  return <ChartDialog title="Position Sizing Calculator" onClose={onClose} className="pb-settings-dialog">
    <form className="pb-settings ps-settings" noValidate onSubmit={event => { event.preventDefault(); onApply(config); onClose(); }}>
      <h4>Trade direction</h4>
      <label className="pb-setting-row">Trade type
        <select value={config.side} onChange={event => set({side: event.target.value as SizingSide})}>
          <option value="long">Long (low-based stops)</option><option value="short">Short (high-based stops)</option><option value="both">Both (side from the day's change)</option>
        </select></label>
      <h4>Capital and risk</h4>
      <label className="pb-setting-row">Capital (₹)
        <input type="number" className="ps-wide" min={0} step={10000} value={config.capital} onChange={event => set({capital: Number(event.target.value)})} /></label>
      <label className="pb-setting-row">PF risk (%)
        <input type="number" min={0.01} max={2} step={0.05} value={config.riskPercent} onChange={event => set({riskPercent: Number(event.target.value)})} /></label>
      <h4>Stops</h4>
      <div className="pb-setting-row">Day stop (DL / DH)<ColorPalette value={config.dayStopColor} ariaLabel="Day stop color" onChange={dayStopColor => set({dayStopColor})} /></div>
      <div className="pb-setting-row">Previous day stop (PDL / PDH)<ColorPalette value={config.prevStopColor} ariaLabel="Previous day stop color" onChange={prevStopColor => set({prevStopColor})} /></div>
      {config.stops.map((stop, index) => <div className="pb-setting-row ps-stop" key={index}>
        <label className="pb-setting-check"><input type="checkbox" checked={stop.enabled} onChange={event => setStop(index, {enabled: event.target.checked})} /><span>SL {index + 1}</span></label>
        <span className="ps-stop-controls">
          <input type="number" aria-label={`SL ${index + 1} percent`} min={0.25} max={10} step={0.05} value={stop.percent} disabled={!stop.enabled}
            onChange={event => setStop(index, {percent: Number(event.target.value)})} />%
          <ColorPalette value={stop.color} ariaLabel={`SL ${index + 1} color`} disabled={!stop.enabled} onChange={color => setStop(index, {color})} />
        </span>
      </div>)}
      <h4>Table</h4>
      <label className="pb-setting-row">Position
        <select value={config.position} onChange={event => set({position: event.target.value as PositionSizingConfig['position'], offset: null})}>
          {SIZING_POSITIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
      <label className="pb-setting-row">Text size
        <select value={config.textSize} onChange={event => set({textSize: event.target.value as PositionSizingConfig['textSize']})}>
          {SIZING_TEXT_SIZES.map(size => <option key={size} value={size}>{size[0].toUpperCase() + size.slice(1)}</option>)}
        </select></label>
      <label className="pb-setting-check"><input type="checkbox" checked={config.showRiskAmount} onChange={event => set({showRiskAmount: event.target.checked})} /><span>Show PF risk amount</span></label>
      <h4>Stop lines</h4>
      <label className="pb-setting-check"><input type="checkbox" checked={config.showLines} onChange={event => set({showLines: event.target.checked})} /><span>Show SL lines</span></label>
      <label className="pb-setting-row">Offset (bars)
        <input type="number" min={0} max={50} value={config.lineOffset} disabled={!config.showLines} onChange={event => set({lineOffset: Number(event.target.value)})} /></label>
      <label className="pb-setting-row">Line length (bars)
        <input type="number" min={1} max={20} value={config.lineLength} disabled={!config.showLines} onChange={event => set({lineLength: Number(event.target.value)})} /></label>
      <p className="pb-settings-note">Sized from the latest published daily bar (end of day), or the replayed bar in replay. Quantity = capital × risk ÷ stop distance, rounded down. Capital is saved only in this browser.</p>
      <footer>
        <Button variant="ghost" onClick={() => setConfig(positionSizingConfig({enabled: config.enabled}))}>Reset</Button>
        <div className="flex gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Apply</Button></div>
      </footer>
    </form>
  </ChartDialog>;
}
