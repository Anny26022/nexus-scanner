import * as Popover from '@radix-ui/react-popover';
import { SlidersHorizontal } from 'lucide-react';

/** The screener's liquidity terms: market cap, average 30-session turnover and price band. */
export interface LiquidityFilters { minCap: number | null; minTurnover: number | null; bands: readonly string[] }
export const NO_FILTERS: LiquidityFilters = {minCap: null, minTurnover: null, bands: []};
const BANDS = ['2', '5', '10', '20', 'No Band'];

export const activeFilters = (filters: LiquidityFilters) =>
  Number(filters.minCap !== null) + Number(filters.minTurnover !== null) + Number(filters.bands.length > 0);

export function passes(filters: LiquidityFilters, item: {cap?: number; turnover?: number; band?: string}) {
  return (filters.minCap === null || (item.cap ?? -1) >= filters.minCap)
    && (filters.minTurnover === null || (item.turnover ?? -1) >= filters.minTurnover)
    && (!filters.bands.length || (item.band !== undefined && filters.bands.includes(item.band)));
}

function Amount({label, value, onChange}: {label: string; value: number | null; onChange: (value: number | null) => void}) {
  return <label className="rot-field"><span>{label}</span>
    <span className="rot-field-input"><input type="number" min={0} inputMode="decimal" placeholder="Any" value={value ?? ''}
      onChange={event => onChange(event.target.value === '' ? null : Math.max(0, Number(event.target.value)))} /><small>₹ Cr</small></span>
  </label>;
}

export function RotationFilters({filters, onChange, disabled}: {filters: LiquidityFilters; onChange: (next: LiquidityFilters) => void; disabled?: boolean}) {
  const count = activeFilters(filters);
  return <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className="rot-pill" data-active={count > 0 || undefined} disabled={disabled}
        title={disabled ? 'Liquidity filters apply to stocks' : 'Liquidity filters'}>
        <SlidersHorizontal size={13} aria-hidden="true" />Filters{count > 0 && <b>{count}</b>}
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="rot-popover" align="end" sideOffset={8}>
        <Amount label="Market cap at least" value={filters.minCap} onChange={minCap => onChange({...filters, minCap})} />
        <Amount label="30-day avg turnover at least" value={filters.minTurnover} onChange={minTurnover => onChange({...filters, minTurnover})} />
        <div className="rot-field"><span>Price band</span>
          <div className="rot-bands">{BANDS.map(band => {
            const on = filters.bands.includes(band);
            return <button key={band} type="button" aria-pressed={on}
              onClick={() => onChange({...filters, bands: on ? filters.bands.filter(item => item !== band) : [...filters.bands, band]})}>
              {band === 'No Band' ? 'None' : `${band}%`}</button>;
          })}</div>
        </div>
        <div className="rot-popover-foot">
          <button type="button" onClick={() => onChange(NO_FILTERS)} disabled={!count}>Clear</button>
          <Popover.Close className="rot-done">Done</Popover.Close>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
