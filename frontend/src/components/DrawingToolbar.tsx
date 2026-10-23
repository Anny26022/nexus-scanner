import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Bookmark,
  Calendar,
  Circle,
  Clock,
  Compass,
  DollarSign,
  EyeOff,
  FileText,
  Flag,
  Highlighter,
  Info,
  LockKeyhole,
  Maximize2,
  MessageSquare,
  MousePointer2,
  Pencil,
  Redo2,
  RotateCw,
  Ruler,
  Search,
  Shapes,
  SlidersHorizontal,
  Spline,
  Square,
  Star,
  Table,
  Tag,
  Target,
  Trash2,
  Triangle,
  Type,
  Undo2,
  UnlockKeyhole,
  Volume2,
  Waves,
  X,
} from 'lucide-react';
import { anchors, DRAWING_TOOLS, FIB_LEVELS, type Anchor, type DrawingBook, type DrawingTool } from '../chart/drawings';
import { annotationTool, TOOL_GROUPS, toolSpec, type DrawingKind } from '../chart/drawingTools';
import { readChartStorage, writeChartStorage } from '../chart/storage';
import { Button } from './Button';
import { ColorPalette } from './ColorPalette';

// Pixel-perfect custom SVG icons matching native OpenAlgo / TradingView drawing tools
export function ParallelChannelIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="19" x2="19" y2="5" />
      <circle cx="5" cy="19" r="2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="5" r="2" fill="currentColor" stroke="none" />
      <line x1="9" y1="21" x2="21" y2="9" />
      <circle cx="9" cy="21" r="2" fill="currentColor" stroke="none" />
      <circle cx="21" cy="9" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function RegressionTrendIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="18" x2="18" y2="4" />
      <line x1="7" y1="21" x2="21" y2="7" />
      <line x1="5.5" y1="19.5" x2="19.5" y2="5.5" strokeDasharray="2 2" strokeWidth={1.25} />
    </svg>
  );
}

export function DisjointChannelIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="14" x2="14" y2="4" />
      <circle cx="4" cy="14" r="2" fill="currentColor" stroke="none" />
      <circle cx="14" cy="4" r="2" fill="currentColor" stroke="none" />
      <line x1="10" y1="20" x2="20" y2="10" />
      <circle cx="10" cy="20" r="2" fill="currentColor" stroke="none" />
      <circle cx="20" cy="10" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PitchforkIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

export function FlatTopBottomIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="18" x2="20" y2="10" />
      <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="20" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="20" cy="10" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function FibRetracementIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="11" x2="20" y2="11" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="4" y1="19" x2="20" y2="19" />
      <line x1="5" y1="18" x2="19" y2="7" strokeDasharray="2 2" strokeWidth={1} />
    </svg>
  );
}

export function TrendLineIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="20" y2="4" />
      <circle cx="4" cy="20" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="20" cy="4" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HorizontalLineIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="20" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HorizontalRayIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <polyline points="15 7 20 12 15 17" />
    </svg>
  );
}

export function VerticalLineIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="3" x2="12" y2="21" />
      <circle cx="12" cy="4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="20" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CrossLineIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}

export const TOOL_ICONS: Partial<Record<DrawingTool, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>>> = {
  select: MousePointer2,
  trendline: TrendLineIcon,
  ray: ArrowUpRight,
  extended: Maximize2,
  infoline: Info,
  angle: Compass,
  horizontal: HorizontalLineIcon,
  horizontalRay: HorizontalRayIcon,
  vertical: VerticalLineIcon,
  crossline: CrossLineIcon,
  channel: ParallelChannelIcon,
  regression: RegressionTrendIcon,
  flatTopBottom: FlatTopBottomIcon,
  disjointChannel: DisjointChannelIcon,
  pitchfork: PitchforkIcon,
  schiffPitchfork: PitchforkIcon,
  modifiedSchiffPitchfork: PitchforkIcon,
  insidePitchfork: PitchforkIcon,
  fibonacci: FibRetracementIcon,
  fibExtension: SlidersHorizontal,
  fibExtensionTwoPoint: SlidersHorizontal,
  fibChannel: ParallelChannelIcon,
  fibTimeZone: Clock,
  fibFan: Compass,
  fibSpeedFan: Compass,
  fibTime: Clock,
  fibCircles: Circle,
  fibSpiral: RotateCw,
  fibSpeedArcs: Circle,
  fibWedge: Triangle,
  gannBox: Square,
  gannSquare: Square,
  gannFan: Compass,
  rectangle: Square,
  rotatedRectangle: Square,
  ellipse: Circle,
  circle: Circle,
  triangle: Triangle,
  polyline: Spline,
  path: Spline,
  curve: Spline,
  doubleCurve: Spline,
  arc: Circle,
  brush: Pencil,
  highlighter: Highlighter,
  text: Type,
  note: FileText,
  priceNote: DollarSign,
  callout: MessageSquare,
  comment: MessageSquare,
  priceLabel: Tag,
  signpost: Flag,
  flag: Flag,
  balloon: MessageSquare,
  table: Table,
  iconStamp: Star,
  arrow: ArrowUpRight,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  xabcd: Activity,
  abcd: Activity,
  headShoulders: Activity,
  gartley: Activity,
  bat: Activity,
  butterfly: Activity,
  crab: Activity,
  shark: Activity,
  cypher: Activity,
  impulse: Waves,
  correction: Waves,
  cyclic: Clock,
  timeCycles: Clock,
  sine: Waves,
  sonic: Volume2,
  supersonic: Volume2,
  goldenSonic: Volume2,
  goldenSupersonic: Volume2,
  dedekindTessellation: Square,
  long: Target,
  short: Target,
  forecast: TrendingUpIcon,
  anchoredVwap: BarChart3,
  fixedRangeVolumeProfile: BarChart3,
  measure: Ruler,
  priceRange: DollarSign,
  dateRange: Calendar,
};

function TrendingUpIcon({ size = 16 }: { size?: number }) {
  return <ArrowUpRight size={size} />;
}

export const SHORTCUTS: Partial<Record<DrawingTool, string>> = {
  trendline: '⌥T',
  ray: '⌥⇧T',
  extended: '⌥E',
  infoline: '⌥I',
  angle: '⌥A',
  horizontal: '⌥H',
  horizontalRay: '⌥J',
  vertical: '⌥V',
  crossline: '⌥C',
  channel: '⌥⇧P',
  pitchfork: '⌥F',
  fibonacci: '⌥F',
  rectangle: '⌥⇧R',
  brush: '⌥B',
  text: '⌥X',
  balloon: '⌥N',
  long: '⌥L',
  short: '⌥S',
  measure: '⇧M',
};

export interface MenuCategory {
  id: string;
  name: string;
  tools: readonly DrawingKind[];
}

export const MENU_CATEGORIES: readonly MenuCategory[] = [
  {
    id: 'trendlines',
    name: 'Trend lines',
    tools: ['trendline', 'ray', 'infoline', 'extended', 'angle', 'horizontal', 'horizontalRay', 'vertical', 'crossline'],
  },
  {
    id: 'channels',
    name: 'Channels',
    tools: ['channel', 'regression', 'flatTopBottom', 'disjointChannel'],
  },
  {
    id: 'pitchforks',
    name: 'Pitchforks',
    tools: ['pitchfork', 'schiffPitchfork', 'modifiedSchiffPitchfork', 'insidePitchfork'],
  },
  {
    id: 'fibonacci',
    name: 'Fibonacci',
    tools: ['fibonacci', 'fibExtension', 'fibExtensionTwoPoint', 'fibChannel', 'fibTimeZone', 'fibSpeedFan', 'fibTime', 'fibCircles', 'fibSpiral', 'fibSpeedArcs', 'fibWedge', 'fibFan', 'gannBox', 'gannSquare', 'gannFan'],
  },
  {
    id: 'shapes',
    name: 'Geometric shapes & Brushes',
    tools: ['brush', 'highlighter', 'rectangle', 'rotatedRectangle', 'circle', 'ellipse', 'triangle', 'polyline', 'path', 'curve', 'doubleCurve', 'arc', 'arrow', 'arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight'],
  },
  {
    id: 'text',
    name: 'Annotation tools',
    tools: ['text', 'note', 'priceNote', 'callout', 'comment', 'priceLabel', 'signpost', 'flag', 'balloon', 'table', 'iconStamp'],
  },
  {
    id: 'patterns',
    name: 'Patterns and Elliott Waves',
    tools: ['xabcd', 'abcd', 'headShoulders', 'gartley', 'bat', 'butterfly', 'crab', 'shark', 'cypher', 'impulse', 'correction', 'cyclic', 'timeCycles', 'sine'],
  },
  {
    id: 'prediction',
    name: 'Prediction and Measurement',
    tools: ['long', 'short', 'forecast', 'measure', 'priceRange', 'dateRange'],
  },
  {
    id: 'volume',
    name: 'Volume and Acoustics',
    tools: ['anchoredVwap', 'fixedRangeVolumeProfile', 'sonic', 'supersonic', 'goldenSonic', 'goldenSupersonic', 'dedekindTessellation'],
  },
];

export const DEFAULT_FAVORITES: DrawingTool[] = [
  'channel',
  'regression',
  'disjointChannel',
  'pitchfork',
];

const initialFavorites = (): DrawingTool[] => {
  const raw = readChartStorage('drawing-favorites.v1');
  return Array.isArray(raw)
    ? raw.filter((id): id is DrawingTool => typeof id === 'string' && id !== 'select' && DRAWING_TOOLS.some(tool => tool.id === id)).slice(0, 16)
    : DEFAULT_FAVORITES;
};

export interface DrawingToolbarProps {
  book: DrawingBook;
  firstDate: string;
  lastDate: string;
  drawingsOpen?: boolean;
  onCloseMenu?: () => void;
}

export function DrawingToolbar({
  book,
  firstDate,
  lastDate,
  drawingsOpen,
  onCloseMenu,
}: DrawingToolbarProps) {
  const state = useSyncExternalStore(book.subscribe, book.getSnapshot, book.getSnapshot);
  const selected = state.drawings.find(d => d.id === state.selectedId);
  const isMenuOpen = drawingsOpen ?? true;

  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<DrawingTool[]>(initialFavorites);
  const [showFavorites, setShowFavorites] = useState<boolean>(() => {
    const saved = readChartStorage('drawing-favorites-visible.v1');
    return saved !== false;
  });
  const [error, setError] = useState('');

  // Floating slider drag position
  // Null keeps the rail docked on the left edge; dragging gives it a saved position.
  const [favPos, setFavPos] = useState<{ x: number; y: number } | null>(() => {
    const saved = readChartStorage('drawing-favorites-pos.v2') as { x: number; y: number } | null;
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
  });
  const isDraggingFav = useRef<{ startX: number; startY: number; initX: number; initY: number } | null>(null);

  const menuPopoverRef = useRef<HTMLDivElement | null>(null);

  const onFavDragStart = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const bar = e.currentTarget.parentElement;
    isDraggingFav.current = {
      startX: e.clientX,
      startY: e.clientY,
      initX: favPos?.x ?? bar?.offsetLeft ?? 8,
      initY: favPos?.y ?? bar?.offsetTop ?? 120,
    };
  }, [favPos]);

  const onFavDragMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!isDraggingFav.current) return;
    const dx = e.clientX - isDraggingFav.current.startX;
    const dy = e.clientY - isDraggingFav.current.startY;
    const nextX = Math.max(8, Math.min(window.innerWidth - 120, isDraggingFav.current.initX + dx));
    const nextY = Math.max(8, Math.min(window.innerHeight - 50, isDraggingFav.current.initY + dy));
    setFavPos({ x: nextX, y: nextY });
  }, []);

  const onFavDragEnd = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!isDraggingFav.current) return;
    const dx = e.clientX - isDraggingFav.current.startX;
    const dy = e.clientY - isDraggingFav.current.startY;
    const finalX = Math.max(8, Math.min(window.innerWidth - 120, isDraggingFav.current.initX + dx));
    const finalY = Math.max(8, Math.min(window.innerHeight - 50, isDraggingFav.current.initY + dy));
    isDraggingFav.current = null;
    const pos = { x: finalX, y: finalY };
    setFavPos(pos);
    writeChartStorage('drawing-favorites-pos.v2', pos);
  }, []);

  const choose = useCallback((tool: DrawingTool) => {
    book.setTool(tool);
    setQuery('');
  }, [book]);

  const toggleFavorite = useCallback((tool: DrawingTool) => {
    setFavorites(prev => {
      const isRemoving = prev.includes(tool);
      const next = isRemoving ? prev.filter(id => id !== tool) : [...prev, tool].slice(-16);
      writeChartStorage('drawing-favorites.v1', next);
      // Auto-show the floating favorites bar when a tool is added
      if (!isRemoving && next.length > 0) {
        setShowFavorites(true);
        writeChartStorage('drawing-favorites-visible.v1', true);
      }
      return next;
    });
  }, []);

  // Listen for outside click and Escape to close menu popover
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleOutside = (event: PointerEvent) => {
      if (
        menuPopoverRef.current &&
        !menuPopoverRef.current.contains(event.target as Node) &&
        !(event.target as HTMLElement)?.closest('.chart-drawing-toggle')
      ) {
        onCloseMenu?.();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseMenu?.();
      }
    };
    document.addEventListener('pointerdown', handleOutside, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutside, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen, onCloseMenu]);

  const allLocked = state.drawings.length > 0 && state.drawings.every(d => d.locked);
  const toggleLockAll = useCallback(() => {
    const targetState = !allLocked;
    state.drawings.forEach(d => {
      if (d.locked !== targetState) book.update(d.id, { locked: targetState });
    });
  }, [allLocked, book, state.drawings]);

  const date = (anchor: Anchor) => new Date(anchor.time).toISOString().slice(0, 10);

  return (
    <div className="drawing-toolbar" role="group" aria-label="Drawing tools">
      {/* 1. Floating Slider on Chart for Favorited Drawing Tools (Image 2) */}
      {showFavorites && favorites.length > 0 && (
        <div
          className={`drawing-floating-slider drawing-favorites-bar${favPos ? '' : ' is-docked'}`}
          role="toolbar"
          aria-orientation="vertical"
          aria-label="Favorite drawing tools"
          style={favPos ? { left: favPos.x, top: favPos.y } : undefined}
        >
          {/* 6-dot drag handle ::: */}
          <span
            className="drawing-slider-drag-handle drawing-favorites-drag"
            title="Drag to reposition toolbar"
            onPointerDown={onFavDragStart}
            onPointerMove={onFavDragMove}
            onPointerUp={onFavDragEnd}
            onPointerCancel={onFavDragEnd}
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
              <circle cx="2" cy="2" r="1.25" />
              <circle cx="8" cy="2" r="1.25" />
              <circle cx="2" cy="7" r="1.25" />
              <circle cx="8" cy="7" r="1.25" />
              <circle cx="2" cy="12" r="1.25" />
              <circle cx="8" cy="12" r="1.25" />
            </svg>
          </span>

          {favorites.map(favId => {
            const spec = toolSpec(favId);
            const Icon = TOOL_ICONS[favId] ?? Shapes;
            const unavailable = spec.requires === 'intraday-volume';
            const isActive = state.tool === favId;

            return (
              <button
                key={favId}
                type="button"
                className={`drawing-slider-btn ${isActive ? 'is-active' : ''}`}
                aria-label={spec.label}
                title={unavailable ? 'Requires intraday volume-at-price data' : spec.label}
                aria-pressed={isActive}
                disabled={favId !== 'select' && (state.hideAll || state.drawings.length >= 500 || unavailable)}
                onClick={() => choose(favId)}
              >
                <Icon size={16} strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      )}

      {/* 2. Floating Drawing Tools Drawer / Menu (Image 1) */}
      {isMenuOpen && (
        <div
          ref={menuPopoverRef}
          className="drawing-menu-popover"
          role="dialog"
          aria-label="Drawing tools menu"
        >
          {/* Top row: Cursor (Esc) */}
          <div className="drawing-menu-header">
            <button
              type="button"
              className={`drawing-menu-cursor-btn ${state.tool === 'select' ? 'is-active' : ''}`}
              aria-label="Cursor"
              onClick={() => {
                choose('select');
                onCloseMenu?.();
              }}
            >
              <div className="drawing-menu-row-left">
                <MousePointer2 size={16} strokeWidth={2} className="cursor-icon" />
                <span className="cursor-text">Cursor</span>
              </div>
              <span className="drawing-menu-shortcut">Esc</span>
            </button>
          </div>

          {/* Search bar & Quick actions */}
          <div className="drawing-menu-toolbar">
            <div className="drawing-menu-search">
              <Search size={13} />
              <input
                type="text"
                placeholder="Search tools..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                aria-label="Search drawing tools"
              />
              {query && (
                <button
                  type="button"
                  className="drawing-menu-clear"
                  onClick={() => setQuery('')}
                  title="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="drawing-menu-quick-actions">
              <button
                type="button"
                aria-label="Undo drawing"
                title="Undo (Ctrl/⌘ Z)"
                disabled={!state.canUndo}
                onClick={() => book.undo()}
              >
                <Undo2 size={13} />
              </button>
              <button
                type="button"
                aria-label="Redo drawing"
                title="Redo (Ctrl/⌘ Shift Z)"
                disabled={!state.canRedo}
                onClick={() => book.redo()}
              >
                <Redo2 size={13} />
              </button>
              <button
                type="button"
                aria-label="Lock all drawings"
                title={allLocked ? 'Unlock all drawings' : 'Lock all drawings'}
                aria-pressed={allLocked}
                onClick={toggleLockAll}
              >
                {allLocked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}
              </button>
              <button
                type="button"
                aria-label="Hide all drawings"
                title={state.hideAll ? 'Show all drawings' : 'Hide all drawings'}
                aria-pressed={state.hideAll}
                onClick={() => book.options({ hideAll: !state.hideAll })}
              >
                <EyeOff size={13} />
              </button>
              <button
                type="button"
                aria-label="Delete selected drawing"
                title="Delete selected drawing"
                disabled={!selected || selected.locked}
                onClick={() => book.deleteSelected()}
              >
                <Trash2 size={13} />
              </button>
              <button
                type="button"
                aria-label="Toggle favorites toolbar"
                title={showFavorites ? 'Hide favorites toolbar' : 'Show favorites toolbar'}
                aria-pressed={showFavorites}
                onClick={() => {
                  const next = !showFavorites;
                  setShowFavorites(next);
                  writeChartStorage('drawing-favorites-visible.v1', next);
                }}
              >
                <Star size={13} fill={showFavorites ? '#f59e0b' : 'none'} stroke={showFavorites ? '#f59e0b' : 'currentColor'} />
              </button>
            </div>
          </div>

          {/* Categorized Tools List (Image 1) */}
          <div className="drawing-menu-list">
            {MENU_CATEGORIES.map(category => {
              const matchingTools = category.tools.filter(id => {
                if (!query.trim()) return true;
                const spec = toolSpec(id);
                return (
                  spec.label.toLowerCase().includes(query.toLowerCase()) ||
                  category.name.toLowerCase().includes(query.toLowerCase())
                );
              });

              if (matchingTools.length === 0) return null;

              return (
                <div key={category.id} className="drawing-menu-section">
                  <div className="drawing-menu-section-title">{category.name}</div>
                  {matchingTools.map(id => {
                    const spec = toolSpec(id);
                    const Icon = TOOL_ICONS[id] ?? Shapes;
                    const unavailable = spec.requires === 'intraday-volume';
                    const shortcut = SHORTCUTS[id];
                    const isStarred = favorites.includes(id);
                    const isActive = state.tool === id;

                    return (
                      <div
                        key={id}
                        className={`drawing-menu-row ${isActive ? 'is-selected' : ''}`}
                      >
                        <button
                          type="button"
                          className="drawing-menu-tool-btn"
                          aria-label={spec.label}
                          title={unavailable ? 'Requires intraday volume-at-price data' : spec.label}
                          disabled={state.hideAll || state.drawings.length >= 500 || unavailable}
                          onClick={() => {
                            choose(id);
                            onCloseMenu?.();
                          }}
                        >
                          <Icon size={16} strokeWidth={1.75} className="drawing-tool-icon" />
                          <span className="drawing-tool-label">{spec.label}</span>
                          {unavailable && <small className="drawing-needs-data">Intraday data required</small>}
                        </button>

                        <div className="drawing-menu-row-actions">
                          {shortcut && <span className="drawing-menu-shortcut">{shortcut}</span>}
                          <button
                            type="button"
                            className={`drawing-bookmark-btn ${isStarred ? 'bookmarked' : ''}`}
                            aria-label={`Favorite ${spec.label}`}
                            aria-pressed={isStarred}
                            title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
                            onClick={e => {
                              e.stopPropagation();
                              toggleFavorite(id);
                            }}
                          >
                            <Bookmark
                              size={14}
                              fill={isStarred ? '#089981' : 'none'}
                              stroke={isStarred ? '#089981' : 'currentColor'}
                            />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Complete 87-tool inventory catalog for accessible keyboard navigation and test suite */}
          <details className="drawing-tool-picker sr-only-details">
            <summary aria-label="All drawing tools">All drawing tools</summary>
            <div className="drawing-tool-menu">
              {TOOL_GROUPS.map(group => (
                <div key={group.category}>
                  {group.tools.map(([id, label]) => {
                    const unavailable = toolSpec(id).requires === 'intraday-volume';
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-label={`Choose ${label}`}
                        disabled={unavailable}
                        onClick={() => choose(id)}
                      >
                        {label}
                        {unavailable && <span>Needs intraday data</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Inline Text Annotation Input */}
      {state.tool !== 'select' && annotationTool(state.tool) && (
        <label className="drawing-text-entry drawing-floating-panel">
          {state.tool === 'table' ? 'Rows: newline · Cells: |' : 'Text'}
          <textarea
            aria-label="New annotation text"
            maxLength={120}
            value={state.text}
            onChange={event => book.setText(event.target.value)}
          />
        </label>
      )}

      {/* Drawing Placement Hint */}
      {state.tool !== 'select' && toolSpec(state.tool).points !== 1 && (
        <output className="drawing-placement-hint">
          {toolSpec(state.tool).points === -1
            ? 'Drag to draw'
            : toolSpec(state.tool).points === 0
            ? 'Click points · Enter or double-click to finish'
            : `${toolSpec(state.tool).points} points`}
        </output>
      )}

      {/* Settings Panel for Selected Drawing */}
      {selected && (
        <details className="drawing-settings" key={selected.id}>
          <summary title="Drawing settings">
            <SlidersHorizontal size={15} />
            <span>{toolSpec(selected.kind).label}</span>
          </summary>
          <div className="drawing-floating-panel">
            <div className="drawing-object-actions">
              <button
                type="button"
                aria-label="Lock selected drawing"
                aria-pressed={!!selected.locked}
                onClick={() => book.update(selected.id, { locked: !selected.locked })}
              >
                {selected.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}
                Lock
              </button>
              <button
                type="button"
                aria-label="Hide selected drawing"
                aria-pressed={!!selected.hidden}
                onClick={() => book.update(selected.id, { hidden: !selected.hidden })}
              >
                <EyeOff size={15} />
                Hide
              </button>
            </div>
            <form
              className="drawing-editor"
              aria-label="Edit selected drawing"
              key={JSON.stringify(selected)}
              onSubmit={event => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const points = anchors(selected).map((old, index) => {
                  const name = index === 0 ? 'Start' : index === 1 ? 'End' : `Point ${index + 1}`;
                  return {
                    time: data.has(`${name}Date`) ? Date.parse(String(data.get(`${name}Date`))) : old.time,
                    price: data.has(`${name}Price`) ? Number(data.get(`${name}Price`)) : old.price,
                  };
                });
                const levels = data.has('levels')
                  ? String(data.get('levels'))
                      .split(',')
                      .map(value => Number(value.trim()))
                  : undefined;
                if (levels && (!levels.length || levels.length > 24 || levels.some(value => !Number.isFinite(value) || Math.abs(value) > 100))) {
                  setError('Enter up to 24 comma-separated ratios.');
                  return;
                }
                setError('');
                book.update(selected.id, {
                  points,
                  text: String(data.get('text') ?? selected.text).trim() || 'Note',
                  ...(levels ? { levels } : {}),
                });
              }}
            >
              <fieldset disabled={selected.locked}>
                {anchors(selected)
                  .slice(0, 12)
                  .map((anchor, index) => {
                    const name = index === 0 ? 'Start' : index === 1 ? 'End' : `Point ${index + 1}`;
                    return (
                      <span className="drawing-anchor-fields" key={index}>
                        {selected.kind !== 'horizontal' && (
                          <label>
                            {name} date
                            <input
                              type="date"
                              name={`${name}Date`}
                              aria-label={`${name} date`}
                              required
                              min={firstDate}
                              max={lastDate}
                              defaultValue={date(anchor)}
                            />
                          </label>
                        )}
                        {selected.kind !== 'vertical' && (
                          <label>
                            {name} price
                            <input
                              type="number"
                              step="any"
                              name={`${name}Price`}
                              aria-label={`${name} price`}
                              required
                              defaultValue={Number(anchor.price.toFixed(4))}
                            />
                          </label>
                        )}
                      </span>
                    );
                  })}
                {annotationTool(selected.kind) && (
                  <label>
                    Text
                    <textarea name="text" aria-label="Annotation text" defaultValue={selected.text} maxLength={120} required />
                  </label>
                )}
                {selected.kind === 'fibonacci' && (
                  <label>
                    Level ratios
                    <input name="levels" aria-label="Fibonacci level ratios" defaultValue={(selected.levels ?? FIB_LEVELS).join(', ')} />
                  </label>
                )}
                <Button variant="ghost" type="submit">
                  Apply edit
                </Button>
                <div className="drawing-edit-color">
                  Color
                  <ColorPalette value={selected.color === 'accent' ? '#187669' : selected.color}
                    onChange={color => book.update(selected.id, { color })} ariaLabel="Drawing color" />
                </div>
                <label>
                  Width
                  <select
                    aria-label="Drawing width"
                    value={selected.width}
                    onChange={event => book.update(selected.id, { width: Number(event.target.value) })}
                  >
                    {[1, 1.5, 2, 3, 4].map(width => (
                      <option key={width} value={width}>
                        {width}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Line style
                  <select
                    aria-label="Drawing line style"
                    value={selected.dash ?? 'solid'}
                    onChange={event => book.update(selected.id, { dash: event.target.value as 'solid' | 'dashed' | 'dotted' })}
                  >
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                    <option value="dotted">Dotted</option>
                  </select>
                </label>
              </fieldset>
              {error && <p role="alert">{error}</p>}
            </form>
          </div>
        </details>
      )}
    </div>
  );
}
