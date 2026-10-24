import { CandlestickChart, Check, ChevronRight } from 'lucide-react';
import type { RotationItem } from '../../api/rotation';
import type { Quadrant, RotationPoint } from '../../utils/rrg';

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
  spotlight: ReadonlySet<string>;
  onFocus: (id: string | null) => void;
  onSpotlight: (id: string) => void;
  onOpen: (item: RotationItem) => void;
}

export function Heading({angle}: {angle: number | null}) {
  return <span className="rot-heading" aria-label={angle === null ? 'No heading yet' : `Heading ${Math.round(angle)} degrees`}>
    {angle !== null && <svg viewBox="-8 -8 16 16" style={{transform: `rotate(${-angle}deg)`}}><path d="M-5 0H4M1-3l3 3-3 3" /></svg>}
  </span>;
}

/** The rail beside the chart: tick an item to give it a trail, click it to focus. */
export function RotationList({rows, total, focusId, hoverId, spotlight, onFocus, onSpotlight, onOpen}: Props) {
  return <div className="rot-list" role="list">
    {rows.map(({item, point, quadrant, angle}) => {
      const lit = spotlight.has(item.id);
      return <div key={item.id} role="listitem" className="rot-row" data-quadrant={quadrant}
        data-focus={focusId === item.id || undefined} data-hover={hoverId === item.id || undefined}>
        <button type="button" className="rot-check" role="checkbox" aria-checked={lit}
          aria-label={lit ? `Hide ${item.label} trail` : `Show ${item.label} trail`} onClick={() => onSpotlight(item.id)}>
          {lit && <Check size={11} strokeWidth={3} />}
        </button>
        <button type="button" className="rot-name" onClick={() => onFocus(focusId === item.id ? null : item.id)} title={item.detail}>
          <b>{item.label}</b><span>{item.detail}</span>
        </button>
        <Heading angle={angle} />
        <span className="rot-num">{point.x.toFixed(1)}<small>{point.y.toFixed(1)}</small></span>
        <button type="button" className="rot-open" onClick={() => onOpen(item)}
          aria-label={item.kind === 'group' ? `Open ${item.label} members` : `Open ${item.label} chart`}
          title={item.kind === 'group' ? 'Open its stocks' : 'Open in Charts'}>
          {item.kind === 'group' ? <ChevronRight size={14} /> : <CandlestickChart size={13} />}
        </button>
      </div>;
    })}
    {total > rows.length && <p className="rot-more">{(total - rows.length).toLocaleString('en-IN')} more · search to narrow</p>}
  </div>;
}
