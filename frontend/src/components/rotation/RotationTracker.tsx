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

const LABEL: Record<Quadrant, string> = {leading: 'Leading', weakening: 'Weakening', lagging: 'Lagging', improving: 'Improving'};
const PAGE_SIZE = 50;

/** The item's trail as a tiny rotation chart on the same scale as the main one. */
function Spark({trail, quadrant, half}: {trail: RotationPoint[]; quadrant: Quadrant; half: {x: number; y: number}}) {
  const w = 84, h = 40;
  const x = (value: number) => Math.min(w - 2, Math.max(2, (value - (100 - half.x)) / (2 * half.x) * w));
  const y = (value: number) => Math.min(h - 2, Math.max(2, (1 - (value - (100 - half.y)) / (2 * half.y)) * h));
  const path = trail.map((point, i) => `${i ? 'L' : 'M'}${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`).join('');
  const head = trail.at(-1);
  return <svg className="rot-spark" viewBox={`0 0 ${w} ${h}`} data-quadrant={quadrant} aria-hidden="true">
    <line x1={x(100)} x2={x(100)} y1={0} y2={h} /><line x1={0} x2={w} y1={y(100)} y2={y(100)} />
    <path d={path} />
    {head && <circle cx={x(head.x)} cy={y(head.y)} r={2.8} />}
  </svg>;
}

interface Props {
  rows: TrackerRow[];
  half: {x: number; y: number};
  sort: TrackerSort;
  onSort: (sort: TrackerSort) => void;
  onOpen: (item: RotationItem) => void;
  onShow: (id: string) => void;
}

/** Every item ranked by where it sits and how far it moved, grouped by quadrant. */
export function RotationTracker({rows, half, sort, onSort, onOpen, onShow}: Props) {
  const [pageChoice, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pageChoice, pages - 1), from = page * PAGE_SIZE;
  const visible = rows.slice(from, from + PAGE_SIZE);
  const peak = Math.max(1e-9, ...rows.map(row => row.moved));
  const header = (key: TrackerSort, label: string, className = '') => <button type="button" className={`rot-th ${className}`}
    aria-pressed={sort === key} onClick={() => onSort(key)}>{label}</button>;
  const sections = sort === 'quadrant' ? QUADRANTS.map(quadrant => [quadrant, visible.filter(row => row.quadrant === quadrant)] as const)
    : [[null, visible] as const];
  return <div className="rot-tracker">
    <div className="rot-trow is-head">
      <span>#</span>{header('name', 'Name')}{header('quadrant', 'Quadrant')}<span>Trail</span><span>Heading</span>
      {header('moved', 'Moved', 'is-num')}{header('ratio', 'RS-Ratio', 'is-num')}{header('momentum', 'RS-Mom.', 'is-num')}<span />
    </div>
    {sections.map(([quadrant, list]) => list.length > 0 && <section key={quadrant ?? 'all'} className="rot-tsection">
      {quadrant && <h3 data-quadrant={quadrant}><i />{LABEL[quadrant]}<span>{list.length}</span></h3>}
      {list.map(row => <div key={row.item.id} className="rot-trow" data-quadrant={row.quadrant}>
        <span className="rot-rank">{from + visible.indexOf(row) + 1}</span>
        <button type="button" className="rot-name" onClick={() => onShow(row.item.id)} title="Show on chart">
          <b>{row.item.label}</b><span>{row.item.detail}</span>
        </button>
        <span className="rot-tag"><i />{LABEL[row.quadrant]}</span>
        <Spark trail={row.trail} quadrant={row.quadrant} half={half} />
        <Heading angle={row.angle} />
        <span className="rot-moved"><i style={{width: `${row.moved / peak * 100}%`}} /><b>{(row.moved * 100).toFixed(0)}</b></span>
        <span className="rot-num">{row.point.x.toFixed(2)}</span>
        <span className="rot-num">{row.point.y.toFixed(2)}</span>
        <Button variant="ghost" className="rot-open" onClick={() => onOpen(row.item)}
          aria-label={row.item.kind === 'group' ? `Open ${row.item.label} members` : `Open ${row.item.label} chart`}
          title={row.item.kind === 'group' ? 'Open its stocks' : 'Open in Charts'}>
          {row.item.kind === 'group' ? <ChevronRight size={14} /> : <CandlestickChart size={13} />}
        </Button>
      </div>)}
    </section>)}
    {pages > 1 && <nav className="rot-pagination" aria-label="Tracker pages">
      <Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
      <span role="status">{from + 1}–{Math.min(from + PAGE_SIZE, rows.length)} of {rows.length}</span>
      <Button variant="ghost" disabled={page === pages - 1} onClick={() => setPage(page + 1)}>Next</Button>
    </nav>}
    {!rows.length && <p className="rot-state">Nothing matches.</p>}
  </div>;
}
