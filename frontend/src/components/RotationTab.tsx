import { useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Compass,
  Copy,
  Minus,
  Pause,
  Play,
  Plus,
  Search,
  SkipBack,
  SkipForward,
  Table,
  X,
} from 'lucide-react';
import {
  DEFAULT_RANGE,
  DEFAULT_TAIL,
  FRAME_LABEL,
  LEVELS,
  LEVEL_LABEL,
  RANGES,
  benchmarkCloses,
  displayLabel,
  itemsFor,
  rangeLength,
  tracks,
  travel,
  type Benchmark,
  type BenchmarkCode,
  type Frame,
  type RotationItem,
  type RotationShardName,
  type Track,
  type Universe,
} from '../api/rotation';
import { screenerApi } from '../api/screenerApi';
import { activeList, loadWatchlistStore } from '../chart/watchlists';
import { useMountEffect } from '../hooks/useMountEffect';
import { bounds, QUADRANTS, quadrantOf, type Quadrant, fitSelection } from '../utils/rrg';
import { Button } from './Button';
import { NO_FILTERS, RotationFilters, passes, type LiquidityFilters } from './rotation/RotationFilters';
import { RotationList, type ListRow } from './rotation/RotationList';
import { RotationPlot } from './rotation/RotationPlot';
import { RotationTimeline } from './rotation/RotationTimeline';
import { RotationTracker, type TrackerRow, type TrackerSort } from './rotation/RotationTracker';

const STOCK_UNIVERSES: [string, string][] = [
  ['N50', 'Nifty 50'],
  ['N100', 'Nifty 100'],
  ['N500', 'Nifty 500'],
  ['MID150', 'Midcap 150'],
  ['SML250', 'Smallcap 250'],
  ['MS400', 'MidSmall 400'],
  ['ALL', 'All stocks'],
  ['WATCH', 'Watchlist'],
];

const QUADRANT_LABEL: Record<Quadrant, string> = {
  leading: 'Leading',
  improving: 'Improving',
  weakening: 'Weakening',
  lagging: 'Lagging',
};

const CHIP_ORDER: Quadrant[] = ['leading', 'weakening', 'lagging', 'improving'];
const SPEEDS = [0.5, 1, 2];
const BENCHMARK_ORDER: BenchmarkCode[] = ['EW', 'N50', 'N100', 'N500', 'MID150', 'SML250', 'MS400', 'TOTAL'];
const STEP_MS = 620;
const LIST_LIMIT = 150;
const LABELLED = 10;
type ListSort = TrackerSort;

const universeKey = (universe: Universe) =>
  universe.kind === 'stocks'
    ? `stocks:${universe.code}`
    : universe.kind === 'level'
    ? `level:${universe.level}`
    : `members:${universe.group}`;

function parseUniverse(key: string): Universe {
  const split = key.indexOf(':'),
    kind = key.slice(0, split),
    value = key.slice(split + 1);
  return kind === 'level'
    ? { kind, level: value as (typeof LEVELS)[number] }
    : kind === 'members'
    ? { kind, group: value }
    : { kind: 'stocks', code: value };
}

const shortDate = (date: string, frame: Frame) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(
    'en-IN',
    frame === 'M'
      ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }
  );

function Select({
  label,
  value,
  onChange,
  children,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`rot-field relative inline-flex items-center h-[30px] rounded-lg border border-line bg-surface hover:bg-surface-hover hover:border-line-strong transition focus-within:ring-2 focus-within:ring-accent/20 ${className}`}
    >
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-full w-full min-w-0 truncate pl-2.5 pr-6 bg-transparent text-text font-medium text-xs border-0 outline-none cursor-pointer appearance-none"
      >
        {children}
      </select>
      <ChevronDown size={12} aria-hidden="true" className="absolute right-2 text-muted pointer-events-none" />
    </label>
  );
}

export default function RotationTab({
  datasetRevision,
  onOpenChart,
}: {
  datasetRevision?: string;
  onOpenChart: (symbol: string) => void;
}) {
  const index = useQuery({
    queryKey: ['rotation-index', datasetRevision],
    queryFn: () => screenerApi.getRotationIndex(datasetRevision),
    staleTime: Infinity,
    retry: 1,
  });

  const [view, setView] = useState<'chart' | 'tracker'>('chart');
  const [universe, setUniverse] = useState<Universe>({ kind: 'level', level: 'block' });
  const [back, setBack] = useState<Universe | null>(null);
  const [frame, setFrame] = useState<Frame>('W');
  const [range, setRange] = useState(DEFAULT_RANGE.W);
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
  const [sort, setSort] = useState<ListSort>('ratio');
  const [copied, setCopied] = useState(false);
  const [watchlist] = useState(
    () => new Set(activeList(loadWatchlistStore()).items.filter((item) => !item.startsWith('###')))
  );

  const data = index.data;
  const isGroups = universe.kind === 'level';
  const group = universe.kind === 'members' ? data?.groups.find((entry) => entry.id === universe.group) : undefined;
  let benchmark: Benchmark;
  if (universe.kind === 'members' && (benchmarkChoice ?? 'GROUP') === 'GROUP') {
    benchmark = { group: universe.group };
  } else {
    const own = universe.kind === 'stocks' ? (universe.code as BenchmarkCode) : 'N500';
    const code = benchmarkChoice && benchmarkChoice !== 'GROUP' ? benchmarkChoice : isGroups ? 'EW' : own;
    benchmark = data?.benchmarks[code] ? code : 'N500';
  }
  const benchmarkName = typeof benchmark === 'string' ? data?.benchmarks[benchmark]?.name : group && displayLabel(group.n);

  const items = useMemo(() => {
    const all = data ? itemsFor(data, universe, watchlist) : [];
    return isGroups ? all : all.filter((item) => passes(filters, item));
  }, [data, universe, watchlist, filters, isGroups]);

  const needed = [
    ...new Set([...items.map((item) => item.shard), ...(typeof benchmark === 'string' ? [] : (['groups'] as const))]),
  ].sort() as RotationShardName[];

  const shardQueries = useQueries({
    queries: needed.map((name) => ({
      queryKey: ['rotation-shard', datasetRevision, name],
      queryFn: () => screenerApi.getRotationShard(datasetRevision, name),
      staleTime: Infinity,
      retry: 1,
    })),
  });

  const loading = index.isPending || shardQueries.some((query) => query.isPending);
  const failed = index.error ?? shardQueries.find((query) => query.error)?.error;
  const benchmarkKey = typeof benchmark === 'string' ? benchmark : benchmark.group;
  const shardStamp = shardQueries.map((query) => query.dataUpdatedAt).join();

  const loaded = () =>
    Object.fromEntries(needed.flatMap((name, i) => (shardQueries[i]?.data ? [[name, shardQueries[i].data!]] : [])));

  const allTracks = useMemo<Track[]>(
    () => (data && !loading ? tracks(data, items, loaded(), frame, benchmark) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, items, frame, benchmarkKey, loading, shardStamp]
  );

  const closes = useMemo(
    () => (data ? benchmarkCloses(data, frame, benchmark, loaded()) : new Float64Array()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, frame, benchmarkKey, shardStamp]
  );

  const dates = data?.frames[frame] ?? [];
  const end = dates.length - 1;
  const start = data ? end - rangeLength(data, frame, range) + 1 : 0;
  const cursor = Math.min(end, Math.max(start, cursorChoice ?? end));
  const dateLabel = (i: number) => (dates[i] ? shortDate(dates[i], frame) : '');

  const half = useMemo(() => {
    const points = [];
    const stride = Math.max(1, Math.floor((allTracks.length * (end - start + tail)) / 150_000));
    for (const track of allTracks) {
      for (let i = Math.max(0, start - tail); i <= end; i += stride) {
        if (Number.isFinite(track.ratio[i]) && Number.isFinite(track.momentum[i])) {
          points.push({ x: track.ratio[i], y: track.momentum[i] });
        }
      }
    }
    return bounds(points);
  }, [allTracks, start, end, tail]);

  const breadth = useMemo(
    () =>
      Array.from({ length: Math.max(0, end - start + 1) }, (_, k) => {
        const counts: Record<Quadrant, number> = { leading: 0, weakening: 0, lagging: 0, improving: 0 };
        for (const track of allTracks) {
          const x = track.ratio[start + k],
            y = track.momentum[start + k];
          if (Number.isFinite(x) && Number.isFinite(y)) counts[quadrantOf({ x, y })]++;
        }
        return counts;
      }),
    [allTracks, start, end]
  );

  const at = (track: Track, i = cursor) => ({ x: track.ratio[i], y: track.momentum[i] });
  const live = allTracks.filter((track) => Number.isFinite(track.ratio[cursor]) && Number.isFinite(track.momentum[cursor]));
  const counts = Object.fromEntries(
    QUADRANTS.map((q) => [q, live.filter((track) => quadrantOf(at(track)) === q).length])
  ) as Record<Quadrant, number>;

  const inQuadrant = live.filter((track) => !quadrant || quadrantOf(at(track)) === quadrant);
  const text = query.trim().toLowerCase();
  const matching = inQuadrant.filter(
    (track) =>
      !text ||
      track.item.label.toLowerCase().includes(text) ||
      track.item.detail.toLowerCase().includes(text)
  );

  const describe = (track: Track): TrackerRow => {
    const point = at(track),
      previous = at(track, cursor - 1);
    const angle =
      Number.isFinite(previous.x) &&
      Number.isFinite(previous.y) &&
      (point.x !== previous.x || point.y !== previous.y)
        ? (Math.atan2(point.y - previous.y, point.x - previous.x) * 180) / Math.PI
        : null;
    const trail = [];
    for (let i = Math.max(0, cursor - tail); i <= cursor; i++) {
      if (Number.isFinite(track.ratio[i]) && Number.isFinite(track.momentum[i])) trail.push(at(track, i));
    }
    return { item: track.item, point, quadrant: quadrantOf(point), angle, moved: travel(track, cursor, tail, half), trail };
  };

  const order = (a: TrackerRow, b: TrackerRow) =>
    sort === 'name'
      ? a.item.label.localeCompare(b.item.label)
      : sort === 'ratio'
      ? b.point.x - a.point.x
      : sort === 'momentum'
      ? b.point.y - a.point.y
      : sort === 'moved'
      ? b.moved - a.moved
      : QUADRANTS.indexOf(a.quadrant) - QUADRANTS.indexOf(b.quadrant) || b.point.x - a.point.x;

  const rows = matching.map(describe).sort(order);
  const moved = new Map(inQuadrant.map((track) => [track.item.id, travel(track, cursor, tail, half)]));
  const peak = Math.max(1e-9, ...moved.values());
  const emphasis = new Map([...moved].map(([id, value]) => [id, (value / peak) ** 0.75]));
  const labelled = new Set([...moved].sort((a, b) => b[1] - a[1]).slice(0, LABELLED).map(([id]) => id));
  // A selected item keeps its whole replay path in view; the overview keeps its robust bounds.
  const focusedTrack = focusId ? allTracks.find((track) => track.item.id === focusId) : undefined;
  const plotHalf = focusedTrack ? fitSelection(half, focusedTrack.ratio, focusedTrack.momentum, start - tail, end) : half;
  // Change in RS-Ratio over the trail: where relative strength is rotating. Not a measure of capital flows.
  const shifts = live
    .map((track) => {
      let from = Math.max(0, cursor - tail);
      while (from < cursor && !Number.isFinite(track.ratio[from])) from++;
      return { track, change: (track.ratio[cursor] - track.ratio[from]) / half.x };
    })
    .filter((entry) => Number.isFinite(entry.change) && entry.change !== 0);
  const gaining = shifts.filter((entry) => entry.change > 0).sort((a, b) => b.change - a.change).slice(0, 4);
  const losing = shifts.filter((entry) => entry.change < 0).sort((a, b) => a.change - b.change).slice(0, 4);

  const playback = useRef({ playing, speed, cursor, start, end });
  playback.current = { playing, speed, cursor, start, end };

  useMountEffect(() => {
    let frameId = 0,
      last = performance.now();
    const tick = (time: number) => {
      frameId = requestAnimationFrame(tick);
      const state = playback.current;
      if (!state.playing) {
        last = time;
        return;
      }
      if (time - last < STEP_MS / state.speed) return;
      last = time;
      if (state.cursor >= state.end) {
        setPlaying(false);
        return;
      }
      setCursor(state.cursor + 1);
    };
    frameId = requestAnimationFrame(tick);

    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, select, textarea, button, [role="slider"]')) return;
      const state = playback.current;
      if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepTo(state.cursor - 1);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepTo(state.cursor + 1);
      }
      if (event.key === 'Escape') setFocus(null);
    };

    window.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('keydown', key);
    };
  });

  function togglePlay() {
    const state = playback.current;
    if (state.playing) {
      setPlaying(false);
      return;
    }
    setGlide((STEP_MS * 0.92) / state.speed);
    if (state.cursor >= state.end) setCursor(state.start);
    setPlaying(true);
  }

  function stepTo(target: number) {
    const state = playback.current;
    setPlaying(false);
    setGlide(280);
    setCursor(Math.min(state.end, Math.max(state.start, target)));
  }

  const resetView = () => {
    setCursor(null);
    setPlaying(false);
    setFocus(null);
    setQuadrant(null);
  };

  const chooseUniverse = (next: Universe, from: Universe | null = null) => {
    setUniverse(next);
    setBack(from);
    setBenchmark(null);
    resetView();
    setQuery('');
  };

  const chooseFrame = (next: Frame) => {
    setFrame(next);
    setRange(DEFAULT_RANGE[next]);
    setTail(DEFAULT_TAIL[next]);
    resetView();
  };

  const open = (item: RotationItem) =>
    item.kind === 'group'
      ? chooseUniverse({ kind: 'members', group: item.id }, universe)
      : onOpenChart(item.id);

  const copySymbols = async () => {
    const symbols = isGroups
      ? [
          ...new Set(
            (focusId ? matching.filter((track) => track.item.id === focusId) : matching).flatMap(
              (track) => track.item.members ?? []
            )
          ),
        ]
      : matching.map((track) => track.item.id);
    try {
      await navigator.clipboard.writeText(symbols.map((symbol) => `NSE:${symbol}`).join(', '));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* Clipboard error handling */
    }
  };

  const scopeLabel = group
    ? displayLabel(group.n)
    : universe.kind === 'level'
    ? LEVEL_LABEL[universe.level]
    : universe.kind === 'stocks'
    ? STOCK_UNIVERSES.find(([code]) => code === universe.code)?.[1] ?? ''
    : '';

  const unit = frame === 'D' ? 'd' : frame === 'W' ? 'w' : 'm';

  if (index.isPending) {
    return (
      <div className="rot flex flex-1 items-center justify-center p-12 text-xs text-muted" role="status">
        Loading rotation history…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rot flex flex-1 items-center justify-center p-12 text-center" role="alert">
        <div className="flex max-w-sm flex-col gap-2 rounded-xl border border-line bg-surface p-6 shadow-sm">
          <h2 className="text-sm font-bold text-text">Rotation is not published yet</h2>
          <p className="text-xs text-muted">
            {failed ? String(failed) : 'Rotation snapshots appear after the next daily publication.'}
          </p>
          {import.meta.env.DEV && !failed && (
            <p className="mt-1 text-[11px] text-muted">
              Locally: run <code className="font-mono bg-field px-1 py-0.5 rounded">python3 tools/build_rotation_local.py</code>.
            </p>
          )}
        </div>
      </div>
    );
  }

  const ready = !failed && !loading && allTracks.length > 0;
  const state = failed ? (
    <div className="flex flex-1 items-center justify-center p-8 text-xs text-negative" role="alert">
      {String(failed)}
    </div>
  ) : loading ? (
    <div className="flex flex-1 items-center justify-center p-8 text-xs text-muted" role="status">
      Loading prices…
    </div>
  ) : !allTracks.length ? (
    <div className="flex flex-1 items-center justify-center p-8 text-xs text-muted">
      Nothing to display for this universe.
    </div>
  ) : null;

  return (
    <div
      className="rot flex h-full flex-col gap-2 min-h-0 w-full max-md:gap-3 max-md:overflow-y-auto max-md:px-3.5 max-md:pt-3 max-md:pb-[max(16px,env(safe-area-inset-bottom))]"
      data-view={view}
    >
      {/* =========================================================================
          Clean, Light Header
          ========================================================================= */}
      <header className="flex flex-wrap items-center justify-between gap-3 shrink-0 py-0.5">
        {/* Title & View Switcher */}
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold tracking-tight text-text">Rotation</h1>

          <div className="inline-flex rounded-lg border border-line bg-field p-0.5" role="tablist" aria-label="View">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'chart'}
              onClick={() => setView('chart')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
                view === 'chart'
                  ? 'bg-surface text-text font-semibold shadow-sm'
                  : 'text-muted hover:text-text'
              }`}
            >
              <Compass size={13} />
              <span>Chart</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'tracker'}
              onClick={() => setView('tracker')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
                view === 'tracker'
                  ? 'bg-surface text-text font-semibold shadow-sm'
                  : 'text-muted hover:text-text'
              }`}
            >
              <Table size={13} />
              <span>Tracker</span>
            </button>
          </div>
        </div>

        {/* Lightweight Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Scope: Universe + Benchmark */}
          <div className="flex items-center gap-1.5 max-md:w-full" aria-label="Scope controls">
            <Select
              label="Universe"
              className="max-md:min-w-0 max-md:flex-1"
              value={universe.kind === 'members' && back ? universeKey(back) : universeKey(universe)}
              onChange={(key) => chooseUniverse(parseUniverse(key))}
            >
              <optgroup label="Groups">
                {LEVELS.map((level) => (
                  <option key={level} value={`level:${level}`}>
                    {LEVEL_LABEL[level]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Stocks">
                {STOCK_UNIVERSES.map(([code, label]) => (
                  <option key={code} value={`stocks:${code}`} disabled={code === 'WATCH' && !watchlist.size}>
                    {label}
                  </option>
                ))}
              </optgroup>
            </Select>

            <Select
              label="Benchmark"
              className="max-md:min-w-0 max-md:flex-1"
              value={typeof benchmark === 'string' ? benchmark : 'GROUP'}
              onChange={(value) => setBenchmark(value as BenchmarkCode | 'GROUP')}
            >
              {group && <option value="GROUP">vs {displayLabel(group.n)}</option>}
              {BENCHMARK_ORDER.filter((code) => data.benchmarks[code]).map((code) => (
                <option key={code} value={code}>
                  vs {data.benchmarks[code]!.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="h-3.5 w-px bg-line shrink-0 max-md:hidden" aria-hidden="true" />

          {/* Display Parameters */}
          <div className="flex items-center gap-1.5" aria-label="Display settings">
            {/* Timeframe D/W/M */}
            <div className="inline-flex rounded-lg border border-line bg-field p-0.5" role="radiogroup" aria-label="Timeframe">
              {(['D', 'W', 'M'] as Frame[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={frame === value}
                  title={FRAME_LABEL[value]}
                  onClick={() => chooseFrame(value)}
                  className={`h-6 min-w-[24px] rounded px-1.5 text-xs font-semibold transition cursor-pointer ${
                    frame === value
                      ? 'bg-surface text-text shadow-sm'
                      : 'text-muted hover:text-text'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>

            {/* Range */}
            <Select
              label="Range"
              value={range}
              onChange={(value) => {
                setRange(value);
                resetView();
              }}
            >
              {RANGES[frame].map(([label]) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </Select>

            {/* Trail Length Stepper */}
            <div
              className="inline-flex h-[30px] items-center gap-1 rounded-lg border border-line bg-surface px-1 text-xs"
              aria-label="Trail length"
            >
              <button
                type="button"
                aria-label="Shorter trail"
                disabled={tail <= 1}
                onClick={() => setTail((v) => Math.max(1, v - 1))}
                className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-field hover:text-text disabled:opacity-30 cursor-pointer"
              >
                <Minus size={12} />
              </button>
              <span className="min-w-[42px] text-center font-semibold tabular-nums text-text">
                {tail}
                {unit} <span className="font-normal text-[11px] text-muted">trail</span>
              </span>
              <button
                type="button"
                aria-label="Longer trail"
                disabled={tail >= 30}
                onClick={() => setTail((v) => Math.min(30, v + 1))}
                className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-field hover:text-text disabled:opacity-30 cursor-pointer"
              >
                <Plus size={12} />
              </button>
            </div>

            {/* Liquidity Filters */}
            {!isGroups && <RotationFilters filters={filters} onChange={setFilters} />}
          </div>
        </div>
      </header>

      {/* =========================================================================
          Main Workspace: Light Rail + Open Stage
          ========================================================================= */}
      {/* Phones stack the stage above the list and scroll the page as one surface. */}
      <div className={`grid grid-cols-1 gap-3.5 md:flex-1 md:min-h-0 ${view === 'chart' ? 'md:grid-cols-[285px_minmax(0,1fr)]' : ''}`}>
        {/* Left Rail: Quiet Directory */}
        {view === 'chart' && (
          <aside className="flex shrink-0 flex-col gap-2.5 max-md:order-2 md:w-[285px] md:min-h-0" aria-label="Items">
            {/* Header info */}
            <div className="flex items-center justify-between px-1">
              <div className="flex min-w-0 flex-col">
                <h2 className="truncate text-xs font-bold text-text">{scopeLabel}</h2>
                <span className="text-[11px] text-muted truncate">
                  {live.length.toLocaleString('en-IN')} {isGroups ? 'groups' : 'stocks'} · vs {benchmarkName}
                </span>
              </div>
              <Button
                variant="ghost"
                onClick={copySymbols}
                aria-label="Copy symbols"
                title={isGroups ? (focusId ? 'Copy this group’s stocks' : 'Copy stocks in these groups') : 'Copy symbols'}
                className="!h-7 !w-7 !p-0 rounded-full text-muted hover:text-text hover:bg-surface-hover"
              >
                {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
              </Button>
            </div>

            {/* Search & Sort */}
            <div className="flex items-center gap-1.5">
              <div className="rot-field flex h-7 flex-1 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-xs transition focus-within:border-accent">
                <Search size={12} className="text-muted shrink-0" />
                <input
                  type="search"
                  placeholder={isGroups ? 'Find group…' : 'Find stock…'}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full min-w-0 border-0 bg-transparent text-xs text-text outline-none placeholder:text-muted"
                />
              </div>
              <Select
                label="Sort items"
                value={sort}
                onChange={(val) => setSort(val as ListSort)}
                className="!h-7 shrink-0 !text-[11px]"
              >
                <option value="quadrant">Quadrant</option>
                <option value="moved">Moved</option>
                <option value="ratio">RS-Ratio</option>
                <option value="momentum">RS-Mom.</option>
                <option value="name">Name</option>
              </Select>
            </div>

            {/* Rail list */}
            <RotationList
              rows={rows.slice(0, LIST_LIMIT) as ListRow[]}
              total={rows.length}
              focusId={focusId}
              hoverId={hoverId}
              onFocus={setFocus}
              onOpen={open}
            />
          </aside>
        )}

        {/* Center Stage Card: Header summary bar + Canvas Plot + Minimal Replay Dock */}
        <main className="flex min-w-0 flex-col rounded-xl border border-line/60 bg-surface shadow-sm overflow-hidden md:flex-1 md:min-h-0">
          {/* Subtle Stage Top Bar: Date + 4 Quadrant Counts */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line/50 px-3.5 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              {group ? (
                <div className="inline-flex items-center gap-1.5 text-xs text-text">
                  <button
                    type="button"
                    onClick={() => back && chooseUniverse(back)}
                    className="text-muted hover:text-text cursor-pointer transition"
                  >
                    {back?.kind === 'level' ? LEVEL_LABEL[back.level] : 'Back'}
                  </button>
                  <span className="text-muted">/</span>
                  <span className="font-bold text-text">{displayLabel(group.n)}</span>
                  <button
                    type="button"
                    aria-label="Close group"
                    onClick={() => back && chooseUniverse(back)}
                    className="ml-0.5 rounded-full p-0.5 text-muted hover:text-text cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <span className="whitespace-nowrap font-semibold tabular-nums text-text text-xs">{dateLabel(cursor)}</span>
              )}
            </div>

            {/* Quiet Quadrant Counts */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 max-md:w-full max-md:flex-nowrap max-md:justify-between max-md:gap-x-1">
              {CHIP_ORDER.map((q) => {
                const active = quadrant === q;
                return (
                  <button
                    key={q}
                    type="button"
                    data-quadrant={q}
                    onClick={() => setQuadrant(active ? null : q)}
                    className={`inline-flex items-center gap-1.5 text-[11.5px] cursor-pointer transition max-md:gap-1 max-md:text-[11px] ${
                      active ? 'font-bold text-text' : 'font-medium text-muted hover:text-text'
                    }`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--q)' }} />
                    <span>{QUADRANT_LABEL[q]}</span>
                    <span className="tabular-nums font-semibold text-text">{counts[q]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Relative-strength shifts over the trail, in one quiet line */}
          {ready && view === 'chart' && (gaining.length > 0 || losing.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line/50 px-3.5 py-1.5 text-[11.5px]">
              {([['Gaining strength', gaining, 'text-(--rrg-leading)'], ['Losing strength', losing, 'text-(--rrg-lagging)']] as const).map(
                ([title, list, tone]) =>
                  list.length > 0 && (
                    <div key={title} className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none]">
                      <span className={`shrink-0 font-semibold ${tone}`} title="Change in RS-Ratio over the trail; not a measure of capital flows">
                        {title} · {tail}
                        {unit}
                      </span>
                      {list.map(({ track }) => (
                        <button
                          key={track.item.id}
                          type="button"
                          data-quadrant={quadrantOf(at(track))}
                          aria-pressed={focusId === track.item.id}
                          onClick={() => setFocus(focusId === track.item.id ? null : track.item.id)}
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 cursor-pointer transition ${
                            focusId === track.item.id ? 'bg-text text-surface' : 'text-text hover:bg-field'
                          }`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--q)' }} />
                          {track.item.label}
                        </button>
                      ))}
                    </div>
                  )
              )}
            </div>
          )}

          {/* Plot Stage or Tracker View */}
          <div
            className={`relative flex flex-1 min-h-0 w-full flex-col overflow-hidden ${
              view === 'chart' ? 'max-md:h-[min(100vw,440px)] max-md:flex-none' : 'max-md:flex-none max-md:overflow-visible'
            }`}
          >
            {view === 'chart' ? (
              state ?? (
                <RotationPlot
                  tracks={inQuadrant}
                  cursor={cursor}
                  rangeStart={start}
                  tail={tail}
                  half={plotHalf}
                  glide={glide}
                  emphasis={emphasis}
                  labelled={labelled}
                  focusId={focusId}
                  onHover={setHover}
                  onSelect={setFocus}
                  dateLabel={dateLabel}
                  onOpen={(id) => {
                    const item = allTracks.find((track) => track.item.id === id)?.item;
                    if (item) open(item);
                  }}
                />
              )
            ) : (
              state ?? (
                <RotationTracker
                  rows={rows}
                  half={half}
                  sort={sort}
                  onSort={setSort}
                  onOpen={open}
                  onShow={(id) => {
                    setView('chart');
                    setFocus(id);
                  }}
                />
              )
            )}
          </div>

          {/* Studio Replay Dock */}
          {ready && (
            <footer className="flex items-center gap-3 border-t border-line/50 bg-surface-subtle/30 px-3 py-1.5 shrink-0">
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  aria-label="Previous period"
                  onClick={() => stepTo(cursor - 1)}
                  disabled={cursor <= start}
                  className="grid h-7 w-7 place-items-center rounded text-muted hover:text-text disabled:opacity-30 cursor-pointer transition"
                >
                  <SkipBack size={13} />
                </button>

                <button
                  type="button"
                  aria-label={playing ? 'Pause replay' : 'Play replay'}
                  onClick={togglePlay}
                  className="grid h-7 w-7 place-items-center rounded-full bg-text text-surface shadow-sm hover:opacity-90 active:scale-95 transition cursor-pointer"
                >
                  {playing ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" className="ml-0.5" />}
                </button>

                <button
                  type="button"
                  aria-label="Next period"
                  onClick={() => stepTo(cursor + 1)}
                  disabled={cursor >= end}
                  className="grid h-7 w-7 place-items-center rounded text-muted hover:text-text disabled:opacity-30 cursor-pointer transition"
                >
                  <SkipForward size={13} />
                </button>

                <button
                  type="button"
                  aria-label={`Playback speed ${speed}×, click to change`}
                  title="Playback speed"
                  onClick={() => {
                    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                    setSpeed(next);
                    if (playing) setGlide((STEP_MS * 0.92) / next);
                  }}
                  className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-muted hover:text-text cursor-pointer transition"
                >
                  {speed}×
                </button>
              </div>

              <RotationTimeline
                dates={dates}
                closes={closes}
                start={start}
                end={end}
                cursor={cursor}
                tail={tail}
                breadth={breadth}
                dateLabel={dateLabel}
                onScrub={(i) => {
                  setPlaying(false);
                  setGlide(0);
                  setCursor(i);
                }}
              />
            </footer>
          )}
        </main>
      </div>
    </div>
  );
}
