import { useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, Minus, Pause, Play, Plus, Search, SkipBack, SkipForward, X } from 'lucide-react';
import {
  DEFAULT_RANGE, DEFAULT_TAIL, FRAME_LABEL, LEVELS, LEVEL_LABEL, RANGES, benchmarkCloses, displayLabel, itemsFor, rangeLength, tracks, travel,
  type Benchmark, type BenchmarkCode, type Frame, type RotationItem, type RotationShardName, type Track, type Universe,
} from '../api/rotation';
import { screenerApi } from '../api/screenerApi';
import { activeList, loadWatchlistStore } from '../chart/watchlists';
import { useMountEffect } from '../hooks/useMountEffect';
import { bounds, fitSelection, QUADRANTS, quadrantOf, type Quadrant } from '../utils/rrg';
import { Button } from './Button';
import { NO_FILTERS, RotationFilters, passes, type LiquidityFilters } from './rotation/RotationFilters';
import { RotationList, type ListRow } from './rotation/RotationList';
import { RotationPlot } from './rotation/RotationPlot';
import { RotationTimeline } from './rotation/RotationTimeline';
import { RotationTracker, type TrackerRow, type TrackerSort } from './rotation/RotationTracker';

const STOCK_UNIVERSES: [string, string][] = [['N50', 'Nifty 50'], ['N100', 'Nifty 100'], ['N500', 'Nifty 500'],
  ['MID150', 'Midcap 150'], ['SML250', 'Smallcap 250'], ['MS400', 'MidSmall 400'], ['ALL', 'All stocks'], ['WATCH', 'Watchlist']];
const QUADRANT_LABEL: Record<Quadrant, string> = {leading: 'Leading', improving: 'Improving', weakening: 'Weakening', lagging: 'Lagging'};
const CHIP_ORDER: Quadrant[] = ['leading', 'weakening', 'lagging', 'improving'];
const SPEEDS = [0.5, 1, 2];
const BENCHMARK_ORDER: BenchmarkCode[] = ['EW', 'N50', 'N100', 'N500', 'MID150', 'SML250', 'MS400', 'TOTAL'];
const STEP_MS = 620;
const LIST_LIMIT = 150;
/** Names on the chart: the items that moved furthest over the trail. Everything is plotted regardless. */
const LABELLED = 10;
/** Items named in the flow summary on each side. */
const FLOW_NAMES = 4;
type ListSort = TrackerSort;

const universeKey = (universe: Universe) => universe.kind === 'stocks' ? `stocks:${universe.code}`
  : universe.kind === 'level' ? `level:${universe.level}` : `members:${universe.group}`;
function parseUniverse(key: string): Universe {
  const split = key.indexOf(':'), kind = key.slice(0, split), value = key.slice(split + 1);
  return kind === 'level' ? {kind, level: value as typeof LEVELS[number]} : kind === 'members' ? {kind, group: value} : {kind: 'stocks', code: value};
}
const shortDate = (date: string, frame: Frame) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN',
  frame === 'M' ? {month: 'short', year: 'numeric', timeZone: 'UTC'} : {day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC'});

function Select({label, value, onChange, children}: {label: string; value: string; onChange: (value: string) => void; children: React.ReactNode}) {
  return <label className="rot-select"><span className="sr-only">{label}</span>
    <select value={value} onChange={event => onChange(event.target.value)}>{children}</select><ChevronDown size={12} aria-hidden="true" /></label>;
}

export default function RotationTab({datasetRevision, onOpenChart}: {datasetRevision?: string; onOpenChart: (symbol: string) => void}) {
  const index = useQuery({queryKey: ['rotation-index', datasetRevision], queryFn: () => screenerApi.getRotationIndex(datasetRevision),
    staleTime: Infinity, retry: 1});
  const [view, setView] = useState<'chart' | 'tracker'>('chart');
  // Thematic blocks (about 30) read cleanly with every trail drawn; finer levels are one click away.
  const [universe, setUniverse] = useState<Universe>({kind: 'level', level: 'block'});
  const [back, setBack] = useState<Universe | null>(null);
  const [frame, setFrame] = useState<Frame>('W');
  const [range, setRange] = useState(DEFAULT_RANGE.W);
  // Groups compare with the equal-weight market they are built like; a group's stocks with the group itself.
  const [benchmarkChoice, setBenchmark] = useState<BenchmarkCode | 'GROUP' | null>(null);
  const [tail, setTail] = useState(DEFAULT_TAIL.W);
  const [cursorChoice, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [glide, setGlide] = useState(0);
  const [focusId, setFocus] = useState<string | null>(null);
  const [hoverId, setHover] = useState<string | null>(null);
  const [quadrant, setQuadrant] = useState<Quadrant | null>(null);
  const [filters, setFilters] = useState<LiquidityFilters>(NO_FILTERS);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ListSort>('quadrant');
  const [copied, setCopied] = useState(false);
  const [watchlist] = useState(() => new Set(activeList(loadWatchlistStore()).items.filter(item => !item.startsWith('###'))));

  const data = index.data;
  const isGroups = universe.kind === 'level';
  const group = universe.kind === 'members' ? data?.groups.find(entry => entry.id === universe.group) : undefined;
  let benchmark: Benchmark;
  if (universe.kind === 'members' && (benchmarkChoice ?? 'GROUP') === 'GROUP') benchmark = {group: universe.group};
  else {
    // Default: groups against the equal-weight market, an index's stocks against that index.
    const own = universe.kind === 'stocks' ? universe.code as BenchmarkCode : 'N500';
    const code = benchmarkChoice && benchmarkChoice !== 'GROUP' ? benchmarkChoice : isGroups ? 'EW' : own;
    benchmark = data?.benchmarks[code] ? code : 'N500';
  }
  const benchmarkName = typeof benchmark === 'string' ? data?.benchmarks[benchmark]?.name : group && displayLabel(group.n);

  const items = useMemo(() => {
    const all = data ? itemsFor(data, universe, watchlist) : [];
    return isGroups ? all : all.filter(item => passes(filters, item));
  }, [data, universe, watchlist, filters, isGroups]);
  const needed = [...new Set([...items.map(item => item.shard), ...(typeof benchmark === 'string' ? [] : ['groups' as const])])].sort() as RotationShardName[];
  const shardQueries = useQueries({queries: needed.map(name => ({
    queryKey: ['rotation-shard', datasetRevision, name], queryFn: () => screenerApi.getRotationShard(datasetRevision, name), staleTime: Infinity, retry: 1,
  }))});
  const loading = index.isPending || shardQueries.some(query => query.isPending);
  const failed = index.error ?? shardQueries.find(query => query.error)?.error;
  const benchmarkKey = typeof benchmark === 'string' ? benchmark : benchmark.group;
  // Shard objects are immutable per release, so their load stamps identify them.
  const shardStamp = shardQueries.map(query => query.dataUpdatedAt).join();
  const loaded = () => Object.fromEntries(needed.flatMap((name, i) => shardQueries[i]?.data ? [[name, shardQueries[i].data!]] : []));
  const allTracks = useMemo<Track[]>(() => data && !loading ? tracks(data, items, loaded(), frame, benchmark) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, items, frame, benchmarkKey, loading, shardStamp]);
  const closes = useMemo(() => data ? benchmarkCloses(data, frame, benchmark, loaded()) : new Float64Array(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, frame, benchmarkKey, shardStamp]);

  const dates = data?.frames[frame] ?? [];
  const end = dates.length - 1;
  const start = data ? end - rangeLength(data, frame, range) + 1 : 0;
  const cursor = Math.min(end, Math.max(start, cursorChoice ?? end));
  const dateLabel = (i: number) => dates[i] ? shortDate(dates[i], frame) : '';

  // Axes are fixed over the whole replay so every frame is drawn on the same scale.
  const half = useMemo(() => {
    const points = [];
    const stride = Math.max(1, Math.floor(allTracks.length * (end - start + tail) / 150_000));
    for (const track of allTracks) for (let i = Math.max(0, start - tail); i <= end; i += stride) {
      if (Number.isFinite(track.ratio[i]) && Number.isFinite(track.momentum[i])) points.push({x: track.ratio[i], y: track.momentum[i]});
    }
    const reach = bounds(points);
    // Keep the robust overview scale, but always fit a selected item's replay path.
    const focused = allTracks.find(track => track.item.id === focusId);
    return focused ? fitSelection(reach, focused.ratio, focused.momentum, start - tail, end) : reach;
  }, [allTracks, start, end, tail, focusId]);
  const breadth = useMemo(() => Array.from({length: Math.max(0, end - start + 1)}, (_, k) => {
    const counts: Record<Quadrant, number> = {leading: 0, weakening: 0, lagging: 0, improving: 0};
    for (const track of allTracks) {
      const x = track.ratio[start + k], y = track.momentum[start + k];
      if (Number.isFinite(x) && Number.isFinite(y)) counts[quadrantOf({x, y})]++;
    }
    return counts;
  }), [allTracks, start, end]);
  const at = (track: Track, i = cursor) => ({x: track.ratio[i], y: track.momentum[i]});
  const live = allTracks.filter(track => Number.isFinite(track.ratio[cursor]) && Number.isFinite(track.momentum[cursor]));
  const counts = Object.fromEntries(QUADRANTS.map(q => [q, live.filter(track => quadrantOf(at(track)) === q).length])) as Record<Quadrant, number>;
  const inQuadrant = live.filter(track => !quadrant || quadrantOf(at(track)) === quadrant);
  const text = query.trim().toLowerCase();
  const matching = inQuadrant.filter(track => !text || track.item.label.toLowerCase().includes(text) || track.item.detail.toLowerCase().includes(text));
  const describe = (track: Track): TrackerRow => {
    const point = at(track), previous = at(track, cursor - 1);
    const angle = Number.isFinite(previous.x) && Number.isFinite(previous.y) && (point.x !== previous.x || point.y !== previous.y)
      ? Math.atan2(point.y - previous.y, point.x - previous.x) * 180 / Math.PI : null;
    const trail = [];
    for (let i = Math.max(0, cursor - tail); i <= cursor; i++) if (Number.isFinite(track.ratio[i]) && Number.isFinite(track.momentum[i])) trail.push(at(track, i));
    return {item: track.item, point, quadrant: quadrantOf(point), angle, moved: travel(track, cursor, tail, half), trail};
  };
  const order = (a: TrackerRow, b: TrackerRow) => sort === 'name' ? a.item.label.localeCompare(b.item.label)
    : sort === 'ratio' ? b.point.x - a.point.x : sort === 'momentum' ? b.point.y - a.point.y : sort === 'moved' ? b.moved - a.moved
    : QUADRANTS.indexOf(a.quadrant) - QUADRANTS.indexOf(b.quadrant) || b.moved - a.moved;
  const rows = matching.map(describe).sort(order);
  // How strongly each trail draws and which carry names: by how far each moved over the trail, right now.
  const moved = new Map(inQuadrant.map(track => [track.item.id, travel(track, cursor, tail, half)]));
  const peak = Math.max(1e-9, ...moved.values());
  const emphasis = new Map([...moved].map(([id, value]) => [id, (value / peak) ** 0.75]));
  const labelled = new Set([...moved].sort((a, b) => b[1] - a[1]).slice(0, LABELLED).map(([id]) => id));
  // Change in relative strength over the trail; this is not a capital-flow measure.
  const flow = live.map(track => {
    let from = Math.max(0, cursor - tail);
    while (from < cursor && !Number.isFinite(track.ratio[from])) from++;
    return {track, change: (track.ratio[cursor] - track.ratio[from]) / half.x};
  }).filter(entry => Number.isFinite(entry.change));
  const flowingIn = flow.filter(entry => entry.change > 0).sort((a, b) => b.change - a.change).slice(0, FLOW_NAMES);
  const flowingOut = flow.filter(entry => entry.change < 0).sort((a, b) => a.change - b.change).slice(0, FLOW_NAMES);

  // Playback: one step per tick, gliding between steps; stops at the latest period.
  const playback = useRef({playing, speed, cursor, start, end});
  playback.current = {playing, speed, cursor, start, end};
  useMountEffect(() => {
    let frameId = 0, last = performance.now();
    const tick = (time: number) => {
      frameId = requestAnimationFrame(tick);
      const state = playback.current;
      if (!state.playing) { last = time; return; }
      if (time - last < STEP_MS / state.speed) return;
      last = time;
      if (state.cursor >= state.end) { setPlaying(false); return; }
      setCursor(state.cursor + 1);
    };
    frameId = requestAnimationFrame(tick);
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, select, textarea, button, [role="slider"]') || !document.querySelector('.rot')) return;
      const state = playback.current;
      if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); stepTo(state.cursor - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); stepTo(state.cursor + 1); }
      if (event.key === 'Escape') setFocus(null);
    };
    window.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(frameId); window.removeEventListener('keydown', key); };
  });

  function togglePlay() {
    const state = playback.current;
    if (state.playing) { setPlaying(false); return; }
    setGlide(STEP_MS * 0.92 / state.speed);
    if (state.cursor >= state.end) setCursor(state.start);
    setPlaying(true);
  }
  function stepTo(target: number) {
    const state = playback.current;
    setPlaying(false);
    setGlide(280);
    setCursor(Math.min(state.end, Math.max(state.start, target)));
  }
  const resetView = () => { setCursor(null); setPlaying(false); setFocus(null); setQuadrant(null); };
  const chooseUniverse = (next: Universe, from: Universe | null = null) => { setUniverse(next); setBack(from); setBenchmark(null); resetView(); setQuery(''); };
  const chooseFrame = (next: Frame) => { setFrame(next); setRange(DEFAULT_RANGE[next]); setTail(DEFAULT_TAIL[next]); resetView(); };
  const open = (item: RotationItem) => item.kind === 'group' ? chooseUniverse({kind: 'members', group: item.id}, universe) : onOpenChart(item.id);
  const copySymbols = async () => {
    const symbols = isGroups
      ? [...new Set((focusId ? matching.filter(track => track.item.id === focusId) : matching).flatMap(track => track.item.members ?? []))]
      : matching.map(track => track.item.id);
    try {
      await navigator.clipboard.writeText(symbols.map(symbol => `NSE:${symbol}`).join(', '));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* Clipboard access can be refused; nothing else to do. */ }
  };
  const scopeLabel = group ? displayLabel(group.n) : universe.kind === 'level' ? LEVEL_LABEL[universe.level]
    : universe.kind === 'stocks' ? STOCK_UNIVERSES.find(([code]) => code === universe.code)?.[1] ?? '' : '';
  const unit = frame === 'D' ? 'd' : frame === 'W' ? 'w' : 'm';

  if (index.isPending) return <div className="rot"><p className="rot-state" role="status">Loading rotation…</p></div>;
  if (!data) return <div className="rot"><div className="rot-state" role="alert">
    <h2>Rotation is not published yet</h2><p>{failed ? String(failed) : 'It appears after the next daily refresh.'}</p>
    {import.meta.env.DEV && !failed && <p>Locally: run <code>python3 tools/build_rotation_local.py</code> and reload.</p>}</div></div>;

  const ready = !failed && !loading && allTracks.length > 0;
  const search = <label className="rot-search"><Search size={13} aria-hidden="true" />
    <input type="search" placeholder={isGroups ? 'Find a group' : 'Find a stock'} aria-label="Search" value={query} onChange={event => setQuery(event.target.value)} />
  </label>;
  const state = failed ? <p className="rot-state" role="alert">{String(failed)}</p>
    : loading ? <p className="rot-state" role="status">Loading prices…</p>
    : !allTracks.length ? <p className="rot-state">Nothing to show for this universe.</p> : null;

  return <div className="rot" data-view={view}>
    <header className="rot-head">
      <div className="rot-title">
        <h1>Rotation</h1>
        <div className="rot-segment" role="tablist" aria-label="View">
          {(['chart', 'tracker'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={view === value}
            onClick={() => setView(value)}>{value === 'chart' ? 'Chart' : 'Tracker'}</button>)}
        </div>
      </div>
      <div className="rot-controls">
        <div className="rot-control-group" aria-label="Scope controls">
          <Select label="Universe" value={universe.kind === 'members' && back ? universeKey(back) : universeKey(universe)} onChange={key => chooseUniverse(parseUniverse(key))}>
            <optgroup label="Groups">{LEVELS.map(level => <option key={level} value={`level:${level}`}>{LEVEL_LABEL[level]}</option>)}</optgroup>
            <optgroup label="Stocks">{STOCK_UNIVERSES.map(([code, label]) => <option key={code} value={`stocks:${code}`} disabled={code === 'WATCH' && !watchlist.size}>{label}</option>)}</optgroup>
          </Select>
          <Select label="Benchmark" value={typeof benchmark === 'string' ? benchmark : 'GROUP'} onChange={value => setBenchmark(value as BenchmarkCode | 'GROUP')}>
            {group && <option value="GROUP">vs {displayLabel(group.n)}</option>}
            {BENCHMARK_ORDER.filter(code => data.benchmarks[code]).map(code => <option key={code} value={code}>vs {data.benchmarks[code]!.name}</option>)}
          </Select>
        </div>
        <div className="rot-control-divider" aria-hidden="true" />
        <div className="rot-control-group" aria-label="Display controls">
          <div className="rot-segment" role="radiogroup" aria-label="Timeframe">
            {(['D', 'W', 'M'] as Frame[]).map(value => <button key={value} type="button" role="radio" aria-checked={frame === value} title={FRAME_LABEL[value]}
              onClick={() => chooseFrame(value)}>{value}</button>)}
          </div>
          <Select label="Range" value={range} onChange={value => { setRange(value); resetView(); }}>
            {RANGES[frame].map(([label]) => <option key={label} value={label}>{label}</option>)}
          </Select>
          <div className="rot-stepper" aria-label="Trail length">
            <button type="button" aria-label="Shorter trail" disabled={tail <= 1} onClick={() => setTail(value => Math.max(1, value - 1))}><Minus size={12} /></button>
            <span>{tail}{unit}<small> trail</small></span>
            <button type="button" aria-label="Longer trail" disabled={tail >= 30} onClick={() => setTail(value => Math.min(30, value + 1))}><Plus size={12} /></button>
          </div>
          {!isGroups && <RotationFilters filters={filters} onChange={setFilters} />}
        </div>
      </div>
    </header>

    <div className="rot-body">
      {view === 'chart' && <aside className="rot-rail" aria-label="Items">
        <div className="rot-rail-head">
          <div><b>{scopeLabel}</b><span>{live.length.toLocaleString('en-IN')} {isGroups ? 'groups' : 'stocks'} · vs {benchmarkName}</span></div>
          <Button variant="ghost" className="rot-icon" onClick={copySymbols} aria-label="Copy symbols"
            title={isGroups ? (focusId ? 'Copy this group’s stocks' : 'Copy the stocks in these groups') : 'Copy these symbols'}>
            {copied ? <Check size={14} /> : <Copy size={14} />}</Button>
        </div>
        <div className="rot-tools">{search}
          <Select label="Sort" value={sort} onChange={value => setSort(value as ListSort)}>
            <option value="quadrant">Quadrant</option><option value="moved">Moved</option><option value="ratio">RS-Ratio</option>
            <option value="momentum">RS-Momentum</option><option value="name">Name</option>
          </Select>
        </div>
        <RotationList rows={rows.slice(0, LIST_LIMIT) as ListRow[]} total={rows.length} focusId={focusId} hoverId={hoverId}
          onFocus={setFocus} onOpen={open} />
      </aside>}

      <main className="rot-main">
        <div className="rot-bar">
          {group ? <div className="rot-crumb"><Button variant="ghost" onClick={() => back && chooseUniverse(back)}>{back?.kind === 'level' ? LEVEL_LABEL[back.level] : 'Back'}</Button>
            <span>/</span><b>{displayLabel(group.n)}</b><Button variant="ghost" aria-label="Close group" onClick={() => back && chooseUniverse(back)}><X size={12} /></Button></div>
            : <span className="rot-date">{dateLabel(cursor)}</span>}
          <div className="rot-chips" role="group" aria-label="Filter by quadrant">
            {CHIP_ORDER.map(q => <button key={q} type="button" data-quadrant={q} aria-pressed={quadrant === q}
              onClick={() => setQuadrant(quadrant === q ? null : q)}><i />{QUADRANT_LABEL[q]}<b>{counts[q]}</b></button>)}
          </div>
          {view === 'tracker' && search}
        </div>
        {ready && (flowingIn.length > 0 || flowingOut.length > 0) && <div className="rot-flow" aria-label={`Flow over the last ${tail}${unit}`}>
          {([['in', 'Gaining relative strength', flowingIn], ['out', 'Losing relative strength', flowingOut]] as const).map(([side, title, list]) => list.length > 0 &&
            <div key={side} className="rot-flow-side" data-side={side}>
              <span>{title}<small> · {tail}{unit}</small></span>
              {list.map(({track}) => <button key={track.item.id} type="button" data-quadrant={quadrantOf(at(track))}
                aria-pressed={focusId === track.item.id} onClick={() => setFocus(focusId === track.item.id ? null : track.item.id)}>
                <i />{track.item.label}</button>)}
            </div>)}
        </div>}
        {view === 'chart' ? <section className="rot-stage" aria-label="Rotation chart">
          {state ?? <RotationPlot tracks={inQuadrant} cursor={cursor} rangeStart={start} tail={tail} half={half} glide={glide} emphasis={emphasis} labelled={labelled}
            focusId={focusId} onHover={setHover} onSelect={setFocus} dateLabel={dateLabel}
            onOpen={id => { const item = allTracks.find(track => track.item.id === id)?.item; if (item) open(item); }} />}
        </section> : <section className="rot-stage is-table" aria-label="Rotation tracker">
          {state ?? <RotationTracker key={`${universeKey(universe)}:${sort}:${query}:${quadrant}`} rows={rows} half={half} sort={sort} onSort={setSort} onOpen={open}
            onShow={id => { setView('chart'); setFocus(id); }} />}
        </section>}
        {ready && <footer className="rot-dock">
          <div className="rot-transport">
            <button type="button" aria-label="Previous period" onClick={() => stepTo(cursor - 1)} disabled={cursor <= start}><SkipBack size={13} /></button>
            <button type="button" className="rot-play" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button>
            <button type="button" aria-label="Next period" onClick={() => stepTo(cursor + 1)} disabled={cursor >= end}><SkipForward size={13} /></button>
            <button type="button" className="rot-speed" aria-label={`Speed ${speed}×, change`} title="Playback speed"
              onClick={() => { const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; setSpeed(next); if (playing) setGlide(STEP_MS * 0.92 / next); }}>{speed}×</button>
          </div>
          <RotationTimeline dates={dates} closes={closes} start={start} end={end} cursor={cursor} tail={tail}
            breadth={breadth} dateLabel={dateLabel} onScrub={i => { setPlaying(false); setGlide(0); setCursor(i); }} />
        </footer>}
      </main>
    </div>
  </div>;
}
