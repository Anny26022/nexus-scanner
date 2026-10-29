import { CandlestickChart, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { RotationItem } from '../../api/rotation';
import { QUADRANTS, type Quadrant, type RotationPoint } from '../../utils/rrg';
import { Button } from '../Button';
import { Heading } from './RotationList';

export interface TrackerRow {
  item: RotationItem;
  point: RotationPoint;
  quadrant: Quadrant;
  angle: number | null;
  /** Distance travelled over the trail, each axis scaled by its spread. */
  moved: number;
  trail: RotationPoint[];
}
export type TrackerSort = 'quadrant' | 'moved' | 'ratio' | 'momentum' | 'name';

const LABEL: Record<Quadrant, string> = {
  leading: 'Leading',
  weakening: 'Weakening',
  lagging: 'Lagging',
  improving: 'Improving',
};
const PAGE_SIZE = 50;

/** The item's trail as a tiny rotation chart on the same scale as the main one. */
function Spark({
  trail,
  quadrant,
  half,
}: {
  trail: RotationPoint[];
  quadrant: Quadrant;
  half: { x: number; y: number };
}) {
  const w = 76,
    h = 32;
  const x = (value: number) => Math.min(w - 2, Math.max(2, ((value - (100 - half.x)) / (2 * half.x)) * w));
  const y = (value: number) => Math.min(h - 2, Math.max(2, (1 - (value - (100 - half.y)) / (2 * half.y)) * h));
  const path = trail.map((point, i) => `${i ? 'L' : 'M'}${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`).join('');
  const head = trail.at(-1);

  return (
    <svg className="rot-spark shrink-0" viewBox={`0 0 ${w} ${h}`} data-quadrant={quadrant} aria-hidden="true">
      <line x1={x(100)} x2={x(100)} y1={0} y2={h} />
      <line x1={0} x2={w} y1={y(100)} y2={y(100)} />
      <path d={path} />
      {head && <circle cx={x(head.x)} cy={y(head.y)} r={2.5} />}
    </svg>
  );
}

interface Props {
  rows: TrackerRow[];
  half: { x: number; y: number };
  sort: TrackerSort;
  onSort: (sort: TrackerSort) => void;
  onOpen: (item: RotationItem) => void;
  onShow: (id: string) => void;
}

/** Every item ranked by where it sits and how far it moved, grouped by quadrant. */
export function RotationTracker({ rows, half, sort, onSort, onOpen, onShow }: Props) {
  const [pageChoice, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pageChoice, pages - 1),
    from = page * PAGE_SIZE;
  const visible = rows.slice(from, from + PAGE_SIZE);
  const peak = Math.max(1e-9, ...rows.map((row) => row.moved));

  const header = (key: TrackerSort, label: string, className = '') => (
    <button
      type="button"
      className={`text-left text-xs font-semibold cursor-pointer transition hover:text-text ${
        sort === key ? 'text-text font-bold' : 'text-muted'
      } ${className}`}
      aria-pressed={sort === key}
      onClick={() => onSort(key)}
    >
      {label}
    </button>
  );

  const sections =
    sort === 'quadrant'
      ? (QUADRANTS.map((quadrant) => [quadrant, visible.filter((row) => row.quadrant === quadrant)] as const) as readonly [
          Quadrant | null,
          TrackerRow[]
        ][])
      : ([[null, visible] as const] as readonly [Quadrant | null, TrackerRow[]][]);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-4 py-2 max-md:overflow-visible max-md:px-2">
      <div className="rot-trow is-head sticky top-0 z-10 border-b border-line bg-surface py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <span>#</span>
        {header('name', 'Name')}
        {header('quadrant', 'Quadrant')}
        <span>Trail</span>
        <span>Heading</span>
        {header('moved', 'Moved', 'text-right')}
        {header('ratio', 'RS-Ratio', 'text-right')}
        {header('momentum', 'RS-Mom.', 'text-right')}
        <span />
      </div>

      {sections.map(([quadrant, list]) =>
        list.length > 0 ? (
          <section key={quadrant ?? 'all'} className="flex flex-col py-2">
            {quadrant && (
              <div
                data-quadrant={quadrant}
                className="flex items-center gap-2 py-2 text-xs font-bold uppercase tracking-wider text-muted"
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--q)' }} />
                <span className="text-text">{LABEL[quadrant]}</span>
                <span className="text-[11px] font-medium text-muted">({list.length})</span>
              </div>
            )}
            {list.map((row) => (
              <div
                key={row.item.id}
                className="rot-trow group min-h-[44px] rounded-lg px-2 py-1.5 transition hover:bg-surface-hover"
                data-quadrant={row.quadrant}
              >
                <span className="text-xs font-medium tabular-nums text-muted">{from + visible.indexOf(row) + 1}</span>

                <button
                  type="button"
                  className="flex min-w-0 flex-col text-left cursor-pointer"
                  onClick={() => onShow(row.item.id)}
                  title="Spotlight on chart"
                >
                  <b className="truncate text-xs font-semibold text-text hover:text-accent">
                    {row.item.label}
                  </b>
                  <span className="truncate text-[10.5px] text-muted">{row.item.detail}</span>
                </button>

                <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--q)' }} />
                  <span>{LABEL[row.quadrant]}</span>
                </div>

                <Spark trail={row.trail} quadrant={row.quadrant} half={half} />

                <div className="flex justify-center">
                  <Heading angle={row.angle} />
                </div>

                <div className="relative flex h-5 items-center justify-end">
                  <i
                    className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
                    style={{
                      width: `${(row.moved / peak) * 100}%`,
                      backgroundColor: 'color-mix(in srgb, var(--q) 35%, transparent)',
                    }}
                  />
                  <b className="relative text-xs font-semibold tabular-nums text-text">
                    {(row.moved * 100).toFixed(0)}
                  </b>
                </div>

                <span className="text-right text-xs font-semibold tabular-nums text-text">
                  {row.point.x.toFixed(2)}
                </span>

                <span className="text-right text-xs font-medium tabular-nums text-muted">
                  {row.point.y.toFixed(2)}
                </span>

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onOpen(row.item)}
                  aria-label={row.item.kind === 'group' ? `Open ${row.item.label} members` : `Open ${row.item.label} chart`}
                  title={row.item.kind === 'group' ? 'Open member stocks' : 'Open in Charts'}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 rounded-full text-muted hover:text-text hover:bg-surface-subtle"
                >
                  {row.item.kind === 'group' ? <ChevronRight size={14} /> : <CandlestickChart size={13} />}
                </Button>
              </div>
            ))}
          </section>
        ) : null
      )}

      {pages > 1 && (
        <nav className="flex items-center justify-center gap-3 py-4 text-xs text-muted" aria-label="Tracker pages">
          <Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span role="status">
            {from + 1}–{Math.min(from + PAGE_SIZE, rows.length)} of {rows.length}
          </span>
          <Button variant="ghost" disabled={page === pages - 1} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </nav>
      )}

      {!rows.length && (
        <div className="flex flex-1 items-center justify-center py-16 text-xs text-muted">
          No matching stocks or groups found.
        </div>
      )}
    </div>
  );
}
