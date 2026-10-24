import { useRef } from 'react';
import { QUADRANTS, type Quadrant } from '../../utils/rrg';

interface Props {
  dates: string[];
  closes: Float64Array;
  /** Replay window: the first and last calendar index the cursor can visit. */
  start: number;
  end: number;
  cursor: number;
  tail: number;
  /** Items in each quadrant at every index from start to end. */
  breadth: Record<Quadrant, number>[];
  onScrub: (index: number) => void;
  dateLabel: (index: number) => string;
}

const WIDTH = 1000;
const LINE = 26;
const RIBBON = 4;

/**
 * Benchmark line over the replay range with a ribbon underneath showing how breadth moved between
 * quadrants. The highlighted window is the trail on the chart; drag anywhere to move it.
 */
export function RotationTimeline({dates, closes, start, end, cursor, tail, breadth, onScrub, dateLabel}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const span = Math.max(1, end - start);
  const x = (index: number) => (index - start) / span * WIDTH;
  const values = Array.from({length: end - start + 1}, (_, i) => closes[start + i]).filter(Number.isFinite);
  const low = Math.min(...values), high = Math.max(...values);
  const y = (value: number) => 2 + (1 - (value - low) / Math.max(1e-9, high - low)) * (LINE - 4);
  let path = '';
  let connected = false;
  for (let i = start; i <= end; i++) {
    if (!Number.isFinite(closes[i])) { connected = false; continue; }
    path += `${connected ? 'L' : 'M'}${x(i).toFixed(1)},${y(closes[i]).toFixed(1)}`;
    connected = true;
  }

  // Stacked shares, leading at the top so the ribbon reads like the chart's upper-right corner.
  const order: Quadrant[] = ['leading', 'improving', 'weakening', 'lagging'];
  const bands = order.map((quadrant, layer) => {
    const upper: string[] = [], lower: string[] = [];
    breadth.forEach((counts, i) => {
      const total = QUADRANTS.reduce((sum, q) => sum + counts[q], 0) || 1;
      const before = order.slice(0, layer).reduce((sum, q) => sum + counts[q], 0) / total;
      const after = before + counts[quadrant] / total;
      upper.push(`${x(start + i).toFixed(1)},${(LINE + 3 + before * RIBBON).toFixed(1)}`);
      lower.unshift(`${x(start + i).toFixed(1)},${(LINE + 3 + after * RIBBON).toFixed(1)}`);
    });
    return <polygon key={quadrant} points={[...upper, ...lower].join(' ')} className={`rot-band is-${quadrant}`} />;
  });

  const scrub = (event: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onScrub(Math.round(start + share * span));
  };
  const windowStart = Math.max(start, cursor - tail);
  const ticks = [start, Math.round((start + end) / 2), end];

  return <div className="rot-timeline">
    <svg ref={svg} viewBox={`0 0 ${WIDTH} ${LINE + RIBBON + 3}`} preserveAspectRatio="none" role="slider"
      aria-label="Replay date" aria-valuemin={start} aria-valuemax={end} aria-valuenow={cursor} aria-valuetext={dateLabel(cursor)} tabIndex={0}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); scrub(event); }}
      onPointerMove={event => { if (event.buttons) scrub(event); }}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); onScrub(Math.max(start, cursor - 1)); }
        if (event.key === 'ArrowRight') { event.preventDefault(); onScrub(Math.min(end, cursor + 1)); }
      }}>
      <rect className="rot-window" x={x(windowStart)} width={Math.max(2, x(cursor) - x(windowStart))} y={0} height={LINE + RIBBON + 3} />
      <path className="rot-line" d={path} vectorEffect="non-scaling-stroke" />
      {bands}
      <line className="rot-cursor" x1={x(cursor)} x2={x(cursor)} y1={0} y2={LINE + RIBBON + 3} vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="rot-ticks" aria-hidden="true">{ticks.map(index => <span key={index}>{dates[index] ? dateLabel(index) : ''}</span>)}</div>
  </div>;
}
