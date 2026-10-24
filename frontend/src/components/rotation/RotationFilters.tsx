import * as Popover from '@radix-ui/react-popover';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '../Button';

/** The screener's liquidity terms: market cap, average 30-session turnover and price band. */
export interface LiquidityFilters {
  minCap: number | null;
  minTurnover: number | null;
  bands: readonly string[];
}

export const NO_FILTERS: LiquidityFilters = { minCap: null, minTurnover: null, bands: [] };
const BANDS = ['2', '5', '10', '20', 'No Band'];

export const activeFilters = (filters: LiquidityFilters) =>
  Number(filters.minCap !== null) + Number(filters.minTurnover !== null) + Number(filters.bands.length > 0);

export function passes(filters: LiquidityFilters, item: { cap?: number; turnover?: number; band?: string }) {
  return (
    (filters.minCap === null || (item.cap ?? -1) >= filters.minCap) &&
    (filters.minTurnover === null || (item.turnover ?? -1) >= filters.minTurnover) &&
    (!filters.bands.length || (item.band !== undefined && filters.bands.includes(item.band)))
  );
}

function AmountField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-muted">{label}</span>
      <div className="rot-field flex h-8 items-center gap-2 rounded-lg border border-line bg-field px-2.5 transition focus-within:border-accent focus-within:ring-2 focus-within:ring-line">
        <input
          type="number"
          min={0}
          inputMode="decimal"
          placeholder="Any"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
          className="w-full min-w-0 border-0 bg-transparent text-xs font-semibold text-text outline-none placeholder:text-muted"
        />
        <span className="shrink-0 text-[11px] font-medium text-muted">₹ Cr</span>
      </div>
    </label>
  );
}

export function RotationFilters({
  filters,
  onChange,
  disabled,
}: {
  filters: LiquidityFilters;
  onChange: (next: LiquidityFilters) => void;
  disabled?: boolean;
}) {
  const count = activeFilters(filters);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={disabled ? 'Liquidity filters apply to stocks' : 'Liquidity filters'}
          className={`inline-flex h-[30px] items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
            count > 0
              ? 'border-accent bg-accent-soft text-text font-semibold'
              : 'border-line bg-surface text-secondary hover:bg-surface-hover hover:border-line-strong'
          } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <SlidersHorizontal size={13} className={count > 0 ? 'text-accent' : 'text-muted'} />
          <span>Filters</span>
          {count > 0 && (
            <span className="grid h-4 min-w-[16px] place-items-center rounded-full bg-text px-1 text-[10px] font-bold text-surface">
              {count}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 flex w-[280px] flex-col gap-4 rounded-2xl border border-line bg-surface p-4 text-text shadow-(--shadow-pop) animate-in fade-in-0 zoom-in-95"
        >
          <div className="flex items-center justify-between border-b border-line pb-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Liquidity Filters</h3>
            {count > 0 && (
              <span className="text-[11px] font-medium text-accent">{count} active</span>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <AmountField
              label="Minimum Market Cap"
              value={filters.minCap}
              onChange={(minCap) => onChange({ ...filters, minCap })}
            />
            <AmountField
              label="30-Day Avg Turnover"
              value={filters.minTurnover}
              onChange={(minTurnover) => onChange({ ...filters, minTurnover })}
            />

            <div className="flex flex-col gap-1.5 text-xs">
              <span className="font-medium text-muted">Price Band</span>
              <div className="flex flex-wrap gap-1.5">
                {BANDS.map((band) => {
                  const on = filters.bands.includes(band);
                  return (
                    <button
                      key={band}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        onChange({
                          ...filters,
                          bands: on ? filters.bands.filter((item) => item !== band) : [...filters.bands, band],
                        })
                      }
                      className={`h-6 rounded-md px-2 text-[11px] font-semibold transition ${
                        on
                          ? 'bg-text text-surface'
                          : 'bg-field text-secondary hover:bg-surface-hover hover:text-text'
                      }`}
                    >
                      {band === 'No Band' ? 'None' : `${band}%`}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-line pt-3">
            <button
              type="button"
              disabled={!count}
              onClick={() => onChange(NO_FILTERS)}
              className="text-xs font-medium text-muted hover:text-text disabled:opacity-30 disabled:hover:text-muted cursor-pointer"
            >
              Reset
            </button>
            <Popover.Close asChild>
              <Button variant="primary" size="compact">
                Done
              </Button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
