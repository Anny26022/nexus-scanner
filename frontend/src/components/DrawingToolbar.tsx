import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  AlignJustify,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Baseline,
  Calendar,
  Check,
  ChevronRight,
  Circle,
  Clock,
  Compass,
  Crosshair,
  DollarSign,
  Eraser,
  EyeOff,
  FileText,
  Flag,
  GitFork,
  GripVertical,
  Highlighter,
  Info,
  LockKeyhole,
  Magnet,
  Maximize2,
  MessageSquare,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
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
  TrendingDown,
  TrendingUp,
  Triangle,
  Type,
  Undo2,
  UnlockKeyhole,
  Volume2,
  Waves,
  Zap,
} from 'lucide-react';
import { anchors, DRAWING_TOOLS, FIB_LEVELS, type Anchor, type DrawingBook, type DrawingTool } from '../chart/drawings';
import { annotationTool, TOOL_GROUPS, toolSpec, type DrawingKind } from '../chart/drawingTools';
import { readChartStorage, writeChartStorage } from '../chart/storage';

export const TOOL_ICONS: Partial<Record<DrawingTool, typeof Minus>> = {
  select: MousePointer2,
  trendline: TrendingUp,
  ray: ArrowUpRight,
  extended: Maximize2,
  infoline: Info,
  angle: Compass,
  horizontal: Minus,
  horizontalRay: ArrowRight,
  vertical: Minus,
  crossline: Plus,
  channel: AlignJustify,
  regression: TrendingDown,
  flatTopBottom: Baseline,
  disjointChannel: Spline,
  pitchfork: GitFork,
  schiffPitchfork: GitFork,
  modifiedSchiffPitchfork: GitFork,
  insidePitchfork: GitFork,
  fibonacci: SlidersHorizontal,
  fibExtension: SlidersHorizontal,
  fibExtensionTwoPoint: SlidersHorizontal,
  fibChannel: AlignJustify,
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
  forecast: TrendingUp,
  anchoredVwap: BarChart3,
  fixedRangeVolumeProfile: BarChart3,
  measure: Ruler,
  priceRange: DollarSign,
  dateRange: Calendar,
};

export const SHORTCUTS: Partial<Record<DrawingTool, string>> = {
  trendline: '⌥ T',
  infoline: '⌥ I',
  angle: '⌥ A',
  horizontal: '⌥ H',
  horizontalRay: '⌥ J',
  vertical: '⌥ V',
  crossline: '⌥ C',
  channel: '⌥ P',
  fibonacci: '⌥ F',
  rectangle: '⌥ ⇧ R',
  brush: '⌥ B',
  text: '⌥ X',
  balloon: '⌥ N',
  long: '⌥ L',
  short: '⌥ S',
  measure: '⇧ M',
};

export interface RailCategory {
  id: string;
  name: string;
  defaultTool: DrawingKind;
  icon: typeof Minus;
  subgroups: readonly { name: string; tools: readonly DrawingKind[] }[];
}

export const RAIL_CATEGORIES: readonly RailCategory[] = [
  {
    id: 'lines',
    name: 'Trend Line Tools',
    defaultTool: 'trendline',
    icon: TrendingUp,
    subgroups: [
      { name: 'LINES', tools: ['trendline', 'ray', 'infoline', 'extended', 'angle', 'horizontal', 'horizontalRay', 'vertical', 'crossline'] },
      { name: 'CHANNELS', tools: ['channel', 'regression', 'flatTopBottom', 'disjointChannel'] },
      { name: 'PITCHFORKS', tools: ['pitchfork', 'schiffPitchfork', 'modifiedSchiffPitchfork', 'insidePitchfork'] },
    ],
  },
  {
    id: 'fibGann',
    name: 'Gann and Fibonacci Tools',
    defaultTool: 'fibonacci',
    icon: SlidersHorizontal,
    subgroups: [
      { name: 'FIBONACCI', tools: ['fibonacci', 'fibExtension', 'fibExtensionTwoPoint', 'fibChannel', 'fibTimeZone', 'fibSpeedFan', 'fibTime', 'fibCircles', 'fibSpiral', 'fibSpeedArcs', 'fibWedge', 'fibFan'] },
      { name: 'GANN', tools: ['gannBox', 'gannSquare', 'gannFan'] },
    ],
  },
  {
    id: 'shapes',
    name: 'Geometric Shapes & Brushes',
    defaultTool: 'brush',
    icon: Pencil,
    subgroups: [
      { name: 'BRUSHES', tools: ['brush', 'highlighter'] },
      { name: 'ARROWS', tools: ['arrow', 'arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight'] },
      { name: 'SHAPES', tools: ['rectangle', 'rotatedRectangle', 'path', 'circle', 'ellipse', 'polyline', 'triangle', 'arc', 'curve', 'doubleCurve'] },
    ],
  },
  {
    id: 'text',
    name: 'Annotation Tools',
    defaultTool: 'text',
    icon: Type,
    subgroups: [
      { name: 'TEXT AND NOTES', tools: ['text', 'note', 'priceNote', 'signpost', 'table', 'callout', 'comment', 'priceLabel', 'flag'] },
      { name: 'CONTENT', tools: ['balloon', 'iconStamp'] },
    ],
  },
  {
    id: 'patterns',
    name: 'Patterns and Elliott Waves',
    defaultTool: 'xabcd',
    icon: Activity,
    subgroups: [
      { name: 'PATTERNS', tools: ['xabcd', 'abcd', 'headShoulders', 'gartley', 'bat', 'butterfly', 'crab', 'shark', 'cypher'] },
      { name: 'ELLIOTT WAVES', tools: ['impulse', 'correction'] },
      { name: 'CYCLES', tools: ['cyclic', 'timeCycles', 'sine'] },
    ],
  },
  {
    id: 'prediction',
    name: 'Prediction and Measurement',
    defaultTool: 'long',
    icon: Target,
    subgroups: [
      { name: 'PROJECTION', tools: ['long', 'short', 'forecast'] },
      { name: 'MEASUREMENT', tools: ['measure', 'priceRange', 'dateRange'] },
    ],
  },
  {
    id: 'volume',
    name: 'Volume and Acoustics',
    defaultTool: 'anchoredVwap',
    icon: BarChart3,
    subgroups: [
      { name: 'VOLUME', tools: ['anchoredVwap', 'fixedRangeVolumeProfile'] },
      { name: 'ACOUSTICS', tools: ['sonic', 'supersonic', 'goldenSonic', 'goldenSupersonic', 'dedekindTessellation'] },
    ],
  },
];

const initialFavorites = (): DrawingTool[] => {
  const raw = readChartStorage('drawing-favorites.v1');
  return Array.isArray(raw)
    ? raw.filter((id): id is DrawingTool => typeof id === 'string' && id !== 'select' && DRAWING_TOOLS.some(tool => tool.id === id)).slice(0, 12)
    : (['trendline', 'horizontal', 'rectangle', 'fibonacci', 'text'] as DrawingTool[]);
};

export function DrawingToolbar({ book, firstDate, lastDate }: { book: DrawingBook; firstDate: string; lastDate: string }) {
  const state = useSyncExternalStore(book.subscribe, book.getSnapshot, book.getSnapshot);
  const selected = state.drawings.find(d => d.id === state.selectedId);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(initialFavorites);
  const [showFavorites, setShowFavorites] = useState(() => {
    const saved = readChartStorage('drawing-favorites-visible.v1');
    return saved !== false;
  });
  const [snapToIndicators, setSnapToIndicators] = useState(false);
  const [error, setError] = useState('');
  const [activeFlyout, setActiveFlyout] = useState<string | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState({ left: 42, top: 100 });
  const [categoryActive, setCategoryActive] = useState<Record<string, DrawingKind>>(() => ({
    lines: 'trendline',
    fibGann: 'fibonacci',
    shapes: 'brush',
    text: 'text',
    patterns: 'xabcd',
    prediction: 'long',
    volume: 'anchoredVwap',
  }));

  const [favPos, setFavPos] = useState<{ x: number; y: number }>(() => {
    const saved = readChartStorage('drawing-favorites-pos.v1') as { x: number; y: number } | null;
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : { x: 52, y: 12 };
  });
  const isDraggingFav = useRef<{ startX: number; startY: number; initX: number; initY: number } | null>(null);

  const onFavDragStart = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDraggingFav.current = {
      startX: e.clientX,
      startY: e.clientY,
      initX: favPos.x,
      initY: favPos.y,
    };
  }, [favPos]);

  const onFavDragMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!isDraggingFav.current) return;
    const dx = e.clientX - isDraggingFav.current.startX;
    const dy = e.clientY - isDraggingFav.current.startY;
    const nextX = Math.max(10, Math.min(window.innerWidth - 120, isDraggingFav.current.initX + dx));
    const nextY = Math.max(10, Math.min(window.innerHeight - 50, isDraggingFav.current.initY + dy));
    setFavPos({ x: nextX, y: nextY });
  }, []);

  const onFavDragEnd = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!isDraggingFav.current) return;
    const dx = e.clientX - isDraggingFav.current.startX;
    const dy = e.clientY - isDraggingFav.current.startY;
    const finalX = Math.max(10, Math.min(window.innerWidth - 120, isDraggingFav.current.initX + dx));
    const finalY = Math.max(10, Math.min(window.innerHeight - 50, isDraggingFav.current.initY + dy));
    isDraggingFav.current = null;
    const pos = { x: finalX, y: finalY };
    setFavPos(pos);
    writeChartStorage('drawing-favorites-pos.v1', pos);
  }, []);

  const menu = useRef<HTMLDetailsElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);

  // Sync active category tool when state.tool changes
  useEffect(() => {
    if (state.tool === 'select') return;
    for (const cat of RAIL_CATEGORIES) {
      if (cat.subgroups.some(sub => sub.tools.includes(state.tool as DrawingKind))) {
        setCategoryActive(prev => (prev[cat.id] === state.tool ? prev : { ...prev, [cat.id]: state.tool as DrawingKind }));
        break;
      }
    }
  }, [state.tool]);

  // Click outside and escape listener for flyout drawer
  useEffect(() => {
    if (!activeFlyout) return;
    const handleOutside = (event: PointerEvent) => {
      if (flyoutRef.current && !flyoutRef.current.contains(event.target as Node)) {
        setActiveFlyout(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveFlyout(null);
    };
    document.addEventListener('pointerdown', handleOutside, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutside, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeFlyout]);

  const attachAllTools = useCallback((node: HTMLDetailsElement | null) => {
    menu.current = node;
    if (!node) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !node.contains(event.target)) node.open = false;
    };
    const close = () => {
      node.open = false;
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
      menu.current = null;
    };
  }, []);

  const choose = (tool: DrawingTool) => {
    book.setTool(tool);
    setActiveFlyout(null);
    if (menu.current) menu.current.open = false;
    setQuery('');
  };

  const toggleFavorite = (tool: DrawingTool) => {
    const next = favorites.includes(tool) ? favorites.filter(id => id !== tool) : [...favorites, tool].slice(-12);
    setFavorites(next);
    writeChartStorage('drawing-favorites.v1', next);
  };

  const toggleFavoritesBar = () => {
    const next = !showFavorites;
    setShowFavorites(next);
    writeChartStorage('drawing-favorites-visible.v1', next);
  };

  const openCategoryFlyout = (categoryId: string, element: HTMLElement) => {
    if (activeFlyout === categoryId) {
      setActiveFlyout(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const topClamped = Math.max(8, Math.min(rect.top - 4, window.innerHeight - 440));
    setFlyoutPosition({ left: Math.max(42, rect.right + 2), top: topClamped });
    setQuery('');
    setActiveFlyout(categoryId);
  };

  const allLocked = state.drawings.length > 0 && state.drawings.every(d => d.locked);
  const toggleLockAll = () => {
    const targetState = !allLocked;
    state.drawings.forEach(d => {
      if (d.locked !== targetState) book.update(d.id, { locked: targetState });
    });
  };

  const date = (anchor: Anchor) => new Date(anchor.time).toISOString().slice(0, 10);
  const currentFlyoutCategory = RAIL_CATEGORIES.find(c => c.id === activeFlyout);

  return (
    <>
      <div className="drawing-toolbar" role="group" aria-label="Drawing tools">
        {/* 1. Cursor Slot with Caret Flyout (Image 2) */}
        <div className={`drawing-slot ${activeFlyout === 'cursor' ? 'drawer-open' : ''}`}>
          <button
            type="button"
            className="drawing-slot-main"
            aria-label="Cursor"
            title={`Cursor (${state.cursorMode ?? 'cross'})`}
            aria-pressed={state.tool === 'select' && state.cursorMode !== 'eraser'}
            onClick={() => {
              if (state.cursorMode === 'eraser') book.options({ cursorMode: 'cross' });
              choose('select');
            }}
          >
            {state.cursorMode === 'arrow' ? (
              <MousePointer2 size={16} strokeWidth={1.75} />
            ) : state.cursorMode === 'dot' ? (
              <Circle size={7} fill="currentColor" />
            ) : state.cursorMode === 'eraser' ? (
              <Eraser size={16} strokeWidth={1.75} />
            ) : (
              <Crosshair size={16} strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            className="drawing-slot-caret"
            aria-label="Cursor menu"
            title="Cursor menu"
            aria-expanded={activeFlyout === 'cursor'}
            onClick={e => {
              e.stopPropagation();
              openCategoryFlyout('cursor', e.currentTarget.parentElement!);
            }}
          >
            <ChevronRight size={9} strokeWidth={2.5} />
          </button>
        </div>

        {/* 2 to 8: The 7 TradingView Category Slots */}
        {RAIL_CATEGORIES.map(category => {
          const activeToolId = categoryActive[category.id] ?? category.defaultTool;
          const spec = toolSpec(activeToolId);
          const Icon = TOOL_ICONS[activeToolId] ?? category.icon;
          const isCategoryActive = category.subgroups.some(sub => sub.tools.includes(state.tool as DrawingKind));
          const isDrawerOpen = activeFlyout === category.id;
          const unavailable = spec.requires === 'intraday-volume';

          return (
            <div className={`drawing-slot ${isDrawerOpen ? 'drawer-open' : ''}`} key={category.id}>
              <button
                type="button"
                className="drawing-slot-main"
                aria-label={`${category.name} (${spec.label})`}
                title={unavailable ? 'Requires intraday volume-at-price data' : `${category.name} · ${spec.label}`}
                aria-pressed={state.tool === activeToolId}
                disabled={state.hideAll || state.drawings.length >= 500 || unavailable}
                onClick={() => choose(activeToolId)}
              >
                <Icon size={16} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className={`drawing-slot-caret ${isCategoryActive ? 'active' : ''}`}
                aria-label={`${category.name} menu`}
                title={`${category.name} drawer`}
                aria-expanded={isDrawerOpen}
                onClick={e => {
                  e.stopPropagation();
                  openCategoryFlyout(category.id, e.currentTarget.parentElement!);
                }}
              >
                <ChevronRight size={9} strokeWidth={2.5} />
              </button>
            </div>
          );
        })}

        <span className="drawing-rail-divider" />

        {/* All Drawing Tools Search & Catalog (accessible modal) */}
        <details
          ref={attachAllTools}
          className="drawing-tool-picker"
          onToggle={event => {
            if (event.currentTarget.open) {
              const rect = event.currentTarget.getBoundingClientRect();
              setFlyoutPosition({
                left: Math.max(42, Math.min(rect.right + 6, window.innerWidth - Math.min(300, window.innerWidth - 24) - 12)),
                top: Math.max(12, Math.min(rect.top, window.innerHeight - Math.min(560, window.innerHeight - 24) - 12)),
              });
              event.currentTarget.querySelector('input')?.focus();
            }
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              if (menu.current) {
                menu.current.open = false;
                menu.current.querySelector('summary')?.focus();
              }
            }
          }}
        >
          <summary aria-label="All drawing tools" title="All drawing tools">
            <Search size={15} />
          </summary>
          <div className="drawing-tool-menu" style={flyoutPosition} role="group" aria-label="Choose drawing tool">
            <label className="drawing-tool-search">
              <Search size={14} />
              <input
                aria-label="Search drawing tools"
                placeholder="Search tools"
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            <div className="drawing-tool-results">
              {TOOL_GROUPS.map(group => {
                const tools = group.tools.filter(([, label]) => `${group.category} ${label}`.toLowerCase().includes(query.toLowerCase()));
                return tools.length ? (
                  <section key={group.category}>
                    <h3>{group.category}</h3>
                    {tools.map(([id, label]) => {
                      const Icon = TOOL_ICONS[id] ?? Shapes;
                      const unavailable = toolSpec(id).requires === 'intraday-volume';
                      return (
                        <div className="drawing-tool-option" key={id}>
                          <button
                            type="button"
                            aria-label={`Choose ${label}`}
                            title={unavailable ? 'Requires intraday volume-at-price data' : undefined}
                            aria-pressed={state.tool === id}
                            disabled={state.hideAll || state.drawings.length >= 500 || unavailable}
                            onClick={() => choose(id)}
                          >
                            <Icon size={16} />
                            <span>{label}</span>
                            {unavailable ? <small>Needs intraday data</small> : state.tool === id && <Check size={14} />}
                          </button>
                          <button
                            type="button"
                            aria-label={`Favorite ${label}`}
                            aria-pressed={favorites.includes(id)}
                            onClick={() => toggleFavorite(id)}
                          >
                            <Star size={14} fill={favorites.includes(id) ? 'currentColor' : 'none'} />
                          </button>
                        </div>
                      );
                    })}
                  </section>
                ) : null;
              })}
              {!DRAWING_TOOLS.some(tool => tool.id !== 'select' && `${tool.category} ${tool.label}`.toLowerCase().includes(query.toLowerCase())) && (
                <p>No matching tools</p>
              )}
            </div>
          </div>
        </details>

        {/* Magnet Slot with Caret Flyout (Image 1) */}
        <div className={`drawing-slot ${activeFlyout === 'magnet' ? 'drawer-open' : ''}`}>
          <button
            type="button"
            className={`drawing-slot-main drawing-magnet-btn ${state.magnet ? 'active' : ''}`}
            aria-label="Snap drawing anchors to OHLC"
            title={state.magnet ? `Magnet Mode: ${state.magnetMode ?? 'weak'} (Active)` : 'Magnet Mode (Snap anchors to OHLC)'}
            aria-pressed={state.magnet}
            onClick={() => book.options({ magnet: !state.magnet })}
          >
            {state.magnetMode === 'strong' ? <Zap size={15} /> : <Magnet size={16} />}
          </button>
          <button
            type="button"
            className="drawing-slot-caret"
            aria-label="Magnet menu"
            title="Magnet menu"
            aria-expanded={activeFlyout === 'magnet'}
            onClick={e => {
              e.stopPropagation();
              openCategoryFlyout('magnet', e.currentTarget.parentElement!);
            }}
          >
            <ChevronRight size={9} strokeWidth={2.5} />
          </button>
        </div>

        {/* Stay in Drawing Mode */}
        <button
          type="button"
          aria-label="Keep drawing"
          title="Stay in Drawing Mode"
          aria-pressed={state.stayDrawing}
          onClick={() => book.options({ stayDrawing: !state.stayDrawing })}
        >
          <Pencil size={16} />
        </button>

        {/* Lock All Drawings */}
        <button
          type="button"
          aria-label="Lock all drawings"
          title={allLocked ? 'Unlock all drawings' : 'Lock all drawings'}
          aria-pressed={allLocked}
          onClick={toggleLockAll}
        >
          {allLocked ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}
        </button>

        {/* Hide All Drawings */}
        <button
          type="button"
          aria-label="Hide all drawings"
          title="Hide all drawings"
          aria-pressed={state.hideAll}
          onClick={() => book.options({ hideAll: !state.hideAll })}
        >
          <EyeOff size={16} />
        </button>

        <span className="drawing-rail-divider" />

        {/* Undo / Redo */}
        <button type="button" aria-label="Undo drawing" title="Undo (Ctrl/⌘ Z)" disabled={!state.canUndo} onClick={() => book.undo()}>
          <Undo2 size={14} />
        </button>

        <button type="button" aria-label="Redo drawing" title="Redo (Ctrl/⌘ Shift Z)" disabled={!state.canRedo} onClick={() => book.redo()}>
          <Redo2 size={14} />
        </button>

        {/* Delete Selected Drawing */}
        <button
          type="button"
          aria-label="Delete selected drawing"
          title="Delete selected drawing"
          disabled={!selected || selected.locked}
          onClick={() => book.deleteSelected()}
        >
          <Trash2 size={14} />
        </button>

        <div className="drawing-rail-spacer" />

        {/* Bottom Star Button: Toggle Favorites Bar (exactly like TradingView) */}
        <button
          type="button"
          className="drawing-rail-fav-toggle"
          aria-label="Toggle favorites toolbar"
          title={showFavorites ? 'Hide favorites toolbar' : 'Show favorites toolbar'}
          aria-pressed={showFavorites}
          onClick={toggleFavoritesBar}
        >
          <Star size={16} fill={showFavorites ? '#f59e0b' : 'none'} stroke={showFavorites ? '#f59e0b' : 'currentColor'} />
        </button>
      </div>

      {/* Cursor Flyout Menu (Image 2) */}
      {activeFlyout === 'cursor' && (
        <div
          ref={flyoutRef}
          className="drawing-flyout-menu drawing-flyout-compact"
          style={{ left: flyoutPosition.left, top: flyoutPosition.top }}
          role="dialog"
          aria-label="Cursor options"
        >
          <div className="drawing-flyout-body">
            <button
              type="button"
              className={`drawing-flyout-row ${state.cursorMode === 'cross' || !state.cursorMode ? 'selected' : ''}`}
              onClick={() => {
                book.options({ cursorMode: 'cross' });
                choose('select');
              }}
            >
              <Crosshair size={16} strokeWidth={1.75} />
              <span>Cross</span>
            </button>
            <button
              type="button"
              className={`drawing-flyout-row ${state.cursorMode === 'dot' ? 'selected' : ''}`}
              onClick={() => {
                book.options({ cursorMode: 'dot' });
                choose('select');
              }}
            >
              <Circle size={7} fill="currentColor" />
              <span>Dot</span>
            </button>
            <button
              type="button"
              className={`drawing-flyout-row ${state.cursorMode === 'arrow' ? 'selected' : ''}`}
              onClick={() => {
                book.options({ cursorMode: 'arrow' });
                choose('select');
              }}
            >
              <MousePointer2 size={16} strokeWidth={1.75} />
              <span>Arrow</span>
            </button>
            <div className="drawing-flyout-divider" />
            <button
              type="button"
              className={`drawing-flyout-row ${state.cursorMode === 'eraser' ? 'selected' : ''}`}
              onClick={() => {
                book.options({ cursorMode: 'eraser' });
                setActiveFlyout(null);
              }}
            >
              <Eraser size={16} strokeWidth={1.75} />
              <span>Eraser</span>
            </button>
          </div>
        </div>
      )}

      {/* Magnet Flyout Menu (Image 1) */}
      {activeFlyout === 'magnet' && (
        <div
          ref={flyoutRef}
          className="drawing-flyout-menu drawing-flyout-compact"
          style={{ left: flyoutPosition.left, top: flyoutPosition.top }}
          role="dialog"
          aria-label="Magnet options"
        >
          <div className="drawing-flyout-body">
            <button
              type="button"
              className={`drawing-flyout-row ${state.magnet && state.magnetMode === 'weak' ? 'selected' : ''}`}
              onClick={() => {
                book.options({ magnet: true, magnetMode: 'weak' });
                setActiveFlyout(null);
              }}
            >
              <Magnet size={16} strokeWidth={1.75} />
              <span>Weak magnet</span>
            </button>
            <button
              type="button"
              className={`drawing-flyout-row ${state.magnet && state.magnetMode === 'strong' ? 'selected' : ''}`}
              onClick={() => {
                book.options({ magnet: true, magnetMode: 'strong' });
                setActiveFlyout(null);
              }}
            >
              <Zap size={16} strokeWidth={1.75} />
              <span>Strong magnet</span>
            </button>
            <div className="drawing-flyout-divider" />
            <div className="drawing-flyout-toggle-row">
              <span>Snap to indicators</span>
              <label className="drawing-switch">
                <input
                  type="checkbox"
                  checked={snapToIndicators}
                  onChange={e => setSnapToIndicators(e.target.checked)}
                />
                <span className="drawing-switch-slider" />
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Tool Category Flyout Drawer */}
      {currentFlyoutCategory && (
        <div
          ref={flyoutRef}
          className="drawing-flyout-menu"
          style={{ left: flyoutPosition.left, top: flyoutPosition.top }}
          role="dialog"
          aria-label={currentFlyoutCategory.name}
        >
          <div className="drawing-flyout-body">
            {currentFlyoutCategory.subgroups.map(subgroup => {
              return (
                <div key={subgroup.name} className="drawing-flyout-section">
                  <div className="drawing-flyout-section-title">{subgroup.name}</div>
                  {subgroup.tools.map(id => {
                    const spec = toolSpec(id);
                    const Icon = TOOL_ICONS[id] ?? Shapes;
                    const unavailable = spec.requires === 'intraday-volume';
                    const shortcut = SHORTCUTS[id];
                    const isStarred = favorites.includes(id);

                    return (
                      <div className="drawing-flyout-item" key={id}>
                        <button
                          type="button"
                          className="drawing-flyout-tool"
                          aria-label={`Choose ${spec.label}`}
                          title={unavailable ? 'Requires intraday volume-at-price data' : undefined}
                          aria-pressed={state.tool === id}
                          disabled={state.hideAll || state.drawings.length >= 500 || unavailable}
                          onClick={() => choose(id)}
                        >
                          <Icon size={16} strokeWidth={1.75} />
                          <span>{spec.label}</span>
                          {unavailable ? <small>Needs intraday data</small> : state.tool === id && <Check size={14} className="drawing-active-check" />}
                        </button>
                        {shortcut && <span className="drawing-shortcut">{shortcut}</span>}
                        <button
                          type="button"
                          className={`drawing-star-btn ${isStarred ? 'starred' : ''}`}
                          aria-label={`Favorite ${spec.label}`}
                          aria-pressed={isStarred}
                          onClick={e => {
                            e.stopPropagation();
                            toggleFavorite(id);
                          }}
                        >
                          <Star size={14} fill={isStarred ? '#f59e0b' : 'none'} stroke={isStarred ? '#f59e0b' : 'currentColor'} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TradingView Lean Draggable Favorites Bar */}
      {showFavorites && favorites.length > 0 && (
        <div
          className="drawing-favorites-bar"
          role="toolbar"
          aria-label="Favorite drawing tools"
          style={{ left: favPos.x, top: favPos.y }}
        >
          <span
            className="drawing-favorites-drag"
            title="Drag to move"
            onPointerDown={onFavDragStart}
            onPointerMove={onFavDragMove}
            onPointerUp={onFavDragEnd}
            onPointerCancel={onFavDragEnd}
          >
            <GripVertical size={13} />
          </span>
          {favorites.map(favId => {
            const spec = toolSpec(favId);
            const Icon = TOOL_ICONS[favId] ?? Shapes;
            const unavailable = spec.requires === 'intraday-volume';
            return (
              <button
                key={favId}
                type="button"
                aria-label={spec.label}
                title={unavailable ? 'Requires intraday volume-at-price data' : spec.label}
                aria-pressed={state.tool === favId}
                disabled={favId !== 'select' && (state.hideAll || state.drawings.length >= 500 || unavailable)}
                onClick={() => choose(favId)}
              >
                <Icon size={15} strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      )}

      {/* Text / Annotation inline input */}
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

      {state.tool !== 'select' && toolSpec(state.tool).points !== 1 && (
        <output className="drawing-placement-hint">
          {toolSpec(state.tool).points === -1
            ? 'Drag to draw'
            : toolSpec(state.tool).points === 0
            ? 'Click points · Enter or double-click to finish'
            : `${toolSpec(state.tool).points} points`}
        </output>
      )}

      {/* Settings Panel for selected drawing */}
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
                <button type="submit" className="button button-ghost">
                  Apply edit
                </button>
                <label>
                  Color
                  <input
                    type="color"
                    aria-label="Drawing color"
                    value={selected.color === 'accent' ? '#187669' : selected.color}
                    onChange={event => book.update(selected.id, { color: event.target.value })}
                  />
                </label>
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
    </>
  );
}
