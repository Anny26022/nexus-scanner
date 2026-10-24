import { CandlestickChart, ChevronRight } from 'lucide-react';
import type { RotationItem } from '../../api/rotation';
import type { Quadrant, RotationPoint } from '../../utils/rrg';
import { Button } from '../Button';
import { SymbolWithLogo } from '../SymbolWithLogo';

export interface ListRow {
  item: RotationItem;
  point: RotationPoint;
  quadrant: Quadrant;
  /** Degrees counter-clockwise from the RS-Ratio axis; null with no previous period. */
  angle: number | null;
}

interface Props {
  rows: ListRow[];
  total: number;
  focusId: string | null;
  hoverId: string | null;
  onFocus: (id: string | null) => void;
  onOpen: (item: RotationItem) => void;
}

export function Heading({ angle }: { angle: number | null }) {
  return (
    <span
      className="rot-heading"
      aria-label={angle === null ? 'No heading yet' : `Heading ${Math.round(angle)} degrees`}
    >
      {angle !== null && (
        <svg viewBox="-8 -8 16 16" style={{ transform: `rotate(${-angle}deg)` }}>
          <path d="M-5 0H4M1-3l3 3-3 3" />
        </svg>
      )}
    </span>
  );
}

/** The rail beside the chart: where each item is and which way it is heading. */
export function RotationList({ rows, total, focusId, hoverId, onFocus, onOpen }: Props) {
  return (
    <div className="rot-scroll flex flex-col gap-1.5 px-1 py-1 md:flex-1 md:overflow-y-auto" role="list">
      {rows.map(({ item, point, quadrant, angle }) => {
        const isFocused = focusId === item.id;
        const isHovered = hoverId === item.id;

        return (
          <div
            key={item.id}
            role="listitem"
            data-quadrant={quadrant}
            className={`group flex min-h-[38px] items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 transition ${
              isFocused
                ? 'bg-surface-hover shadow-sm ring-1 ring-line-strong/60'
                : isHovered
                ? 'bg-surface-hover/70'
                : 'hover:bg-surface-hover/40'
            }`}
          >
            {/* Quadrant Indicator Dot */}
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: 'var(--q)' }}
              aria-hidden="true"
            />

            {/* Label and Details button */}
            <button
              type="button"
              onClick={() => onFocus(isFocused ? null : item.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
              title={item.detail}
            >
              {item.kind === 'stock' ? (
                <SymbolWithLogo
                  symbol={item.id}
                  name={item.detail}
                  showText
                  size="sm"
                  className="min-w-0 flex-1 gap-2 [&_.symbol-logo-mark]:!w-[22px] [&_.symbol-logo-mark]:!h-[22px] [&_.symbol-logo-mark]:!rounded-md [&_.symbol-logo-mark]:!p-0.5 [&_.symbol-logo-symbol]:!text-xs [&_.symbol-logo-symbol]:!font-semibold [&_.symbol-logo-name]:!text-[11px] [&_.symbol-logo-name]:!text-muted"
                />
              ) : (
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <span className="truncate text-xs font-semibold text-text group-hover:text-text">
                    {item.label}
                  </span>
                  <span className="truncate text-[11px] text-muted mt-0.5">{item.detail}</span>
                </div>
              )}
            </button>

            {/* Trajectory Vector Arrow */}
            <div className="shrink-0 w-4 flex justify-center">
              <Heading angle={angle} />
            </div>

            {/* Primary Relative Strength Score */}
            <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-text">
              {point.x.toFixed(1)}
            </span>

            {/* Action Icon: View in Chart or Drill Down */}
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(item);
              }}
              aria-label={item.kind === 'group' ? `Open ${item.label} members` : `Open ${item.label} chart`}
              title={item.kind === 'group' ? 'Explore member stocks' : 'Open in Charts'}
              className="!h-6 !w-6 !p-0 opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity rounded-full hover:bg-surface text-muted hover:text-text shrink-0"
            >
              {item.kind === 'group' ? <ChevronRight size={14} /> : <CandlestickChart size={13} />}
            </Button>
          </div>
        );
      })}

      {total > rows.length && (
        <p className="py-2.5 text-center text-[11px] text-muted">
          {(total - rows.length).toLocaleString('en-IN')} more · search to narrow
        </p>
      )}
    </div>
  );
}
