import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ScanHistoryPoint } from '../api/scanHistoryEngine';

const W = 1000, H = 220, PAD_TOP = 14, PAD_BOTTOM = 8;

const shortDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'});
const longDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'});

/** Round ticks that just enclose the data, so small day-to-day changes stay visible. */
function ticks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || min === max) return [Math.max(0, max)];
  const raw = (max - min) / 3, step = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map(n => n * step).find(n => n >= raw) ?? raw;
  const out: number[] = [];
  for (let level = Math.floor(min / nice) * nice; ; level += nice) { out.push(level); if (level >= max) break; }
  return out;
}

/** Matches per session as a line chart: crosshair on hover, click or arrow keys to pick a session. */
export function ScanHistoryChart({points, selected, onSelect}: {
  points: ScanHistoryPoint[];
  selected: string | null;
  onSelect: (point: ScanHistoryPoint) => void;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const geometry = useMemo(() => {
    const ok = points.filter(point => point.status === 'success').map(point => point.count);
    const levels = ticks(Math.min(...ok, Infinity), Math.max(...ok, 0));
    const low = Math.min(levels[0], ...ok), high = Math.max(levels.at(-1)!, ...ok);
    const span = high - low || 1;
    const x = (i: number) => points.length < 2 ? W / 2 : i / (points.length - 1) * W;
    const y = (count: number) => PAD_TOP + (1 - (count - low) / span) * (H - PAD_TOP - PAD_BOTTOM);
    // Unavailable sessions break the line rather than dipping it to zero.
    const runs: string[] = [];
    let run = '';
    points.forEach((point, i) => {
      if (point.status !== 'success') { if (run) runs.push(run); run = ''; return; }
      run += `${run ? 'L' : 'M'}${x(i).toFixed(1)},${y(point.count).toFixed(1)}`;
    });
    if (run) runs.push(run);
    const area = runs.map(path => {
      const xs = [...path.matchAll(/[ML]([\d.]+),/g)].map(match => match[1]);
      return `${path}L${xs.at(-1)},${H}L${xs[0]},${H}Z`;
    });
    return {levels, x, y, low, span, runs, area};
  }, [points]);

  const selectedIndex = Math.max(0, points.findIndex(point => point.date === selected));
  const active = hover ?? selectedIndex;
  const activePoint = points[active];
  const pct = (i: number) => geometry.x(i) / W * 100;
  const indexAt = (event: {clientX: number}) => {
    const box = plot.current!.getBoundingClientRect();
    return Math.min(points.length - 1, Math.max(0, Math.round((event.clientX - box.left) / box.width * (points.length - 1))));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = points[Math.min(points.length - 1, Math.max(0, selectedIndex + step))];
    if (next) onSelect(next);
  };
  // Distinct positions only: while a run streams in, few points would repeat an index.
  const dateLabels = [...new Set([0, .33, .66, 1].map(f => Math.round((points.length - 1) * f)))];

  return <div className="history-chart">
    <div className="history-chart-plot" ref={plot} tabIndex={0} role="slider"
      aria-label="Matches by session" aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={selectedIndex}
      aria-valuetext={activePoint ? `${longDate(activePoint.date)}: ${activePoint.count.toLocaleString('en-IN')} matches` : undefined}
      onPointerMove={event => setHover(indexAt(event))} onPointerLeave={() => setHover(null)}
      onClick={event => onSelect(points[indexAt(event)])} onKeyDown={onKey}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="history-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity=".16" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {geometry.levels.map(level => <line key={level} className="history-grid" x1="0" x2={W} y1={geometry.y(level)} y2={geometry.y(level)} />)}
        {geometry.area.map(path => <path key={path} d={path} fill="url(#history-fill)" />)}
        {geometry.runs.map(path => <path key={path} d={path} className="history-line" />)}
        {points.map((point, i) => point.status !== 'success' &&
          <line key={point.date} className="history-gap" x1={geometry.x(i)} x2={geometry.x(i)} y1={H - 10} y2={H} />)}
      </svg>
      {activePoint && <>
        <span className="history-crosshair" style={{left: `${pct(active)}%`}} />
        {activePoint.status === 'success' && <span className="history-dot" style={{left: `${pct(active)}%`, top: `${geometry.y(activePoint.count) / H * 100}%`}} />}
        <span className="history-tip" style={{left: `clamp(56px, ${pct(active)}%, calc(100% - 56px))`}}>
          <strong>{activePoint.status === 'success' ? activePoint.count.toLocaleString('en-IN') : 'n/a'}</strong>{shortDate(activePoint.date)}
        </span>
      </>}
      <div className="history-axis-y" aria-hidden="true">{geometry.levels.map(level =>
        <span key={level} style={{top: `${geometry.y(level) / H * 100}%`}}>{level.toLocaleString('en-IN')}</span>)}</div>
    </div>
    <div className="history-axis-x" aria-hidden="true">{dateLabels.map(i =>
      <span key={i} style={{left: `${pct(i)}%`}}>{shortDate(points[i].date)}</span>)}</div>
  </div>;
}
