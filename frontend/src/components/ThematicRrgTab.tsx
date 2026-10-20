import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import {
  RrgQuadrant,
  RrgBlockItem,
  RrgNicheItem,
} from '../types/thematicRrg';
import {
  Search,
  ChevronRight,
  X,
  ArrowUpDown,
  Compass,
} from 'lucide-react';

interface ThematicRrgTabProps {
  datasetRevision?: string;
}

type ViewMode = 'blocks' | 'niches';
type SortField =
  | 'name'
  | 'quadrant'
  | 'excessReturn3m'
  | 'rsMomentum21d'
  | 'medianRs'
  | 'beatingBenchmarkPct'
  | 'improvingRsPct'
  | 'setupCoveragePct'
  | 'totalTurnover20Cr'
  | 'constituentCount';

type SortDirection = 'asc' | 'desc';

export const ThematicRrgTab: React.FC<ThematicRrgTabProps> = ({ datasetRevision }) => {
  // Query data using TanStack Query (no useEffect)
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['thematicRrg', datasetRevision],
    queryFn: () => screenerApi.getThematicRrg(datasetRevision),
    staleTime: 5 * 60 * 1000,
  });

  // Local UI state
  const [viewMode, setViewMode] = useState<ViewMode>('blocks');
  const [selectedQuadrant, setSelectedQuadrant] = useState<RrgQuadrant | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [trailWeeks, setTrailWeeks] = useState<number>(12);
  const [activeDrillBlock, setActiveDrillBlock] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<{
    item: RrgBlockItem | RrgNicheItem;
    screenX: number;
    screenY: number;
  } | null>(null);
  const [selectedDrawerItem, setSelectedDrawerItem] = useState<RrgBlockItem | RrgNicheItem | null>(null);

  // Table sorting
  const [sortField, setSortField] = useState<SortField>('excessReturn3m');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  // Constituent drawer sorting
  const [stockSortField, setStockSortField] = useState<'symbol' | 'rsRating' | 'excessReturn3m' | 'return1m' | 'marketCapCr' | 'turnover20Cr'>('excessReturn3m');
  const [stockSortDir, setStockSortDir] = useState<SortDirection>('desc');

  // Active items depending on viewMode and drilldown
  const activeItems = useMemo<(RrgBlockItem | RrgNicheItem)[]>(() => {
    if (!data) return [];
    if (activeDrillBlock) {
      return data.niches.filter((n) => n.parentBlock === activeDrillBlock);
    }
    if (viewMode === 'blocks') {
      return data.blocks;
    }
    return data.niches;
  }, [data, viewMode, activeDrillBlock]);

  // Filtered items
  const filteredItems = useMemo(() => {
    let result = activeItems;

    if (selectedQuadrant !== 'ALL') {
      result = result.filter((item) => item.quadrant === selectedQuadrant);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          (item.macro && item.macro.toLowerCase().includes(q)) ||
          item.constituents.some((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      );
    }

    return result;
  }, [activeItems, selectedQuadrant, searchQuery]);

  // Quadrant counts across current view scope
  const quadrantCounts = useMemo(() => {
    const counts = { ALL: activeItems.length, Leading: 0, Weakening: 0, Lagging: 0, Improving: 0 };
    for (const item of activeItems) {
      if (counts[item.quadrant] !== undefined) {
        counts[item.quadrant]++;
      }
    }
    return counts;
  }, [activeItems]);

  // Sorted items for the table
  const sortedItems = useMemo(() => {
    const items = [...filteredItems];
    items.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      switch (sortField) {
        case 'name':
          aVal = a.name;
          bVal = b.name;
          return sortDir === 'asc' ? (aVal as string).localeCompare(bVal as string) : (bVal as string).localeCompare(aVal as string);
        case 'quadrant':
          aVal = a.quadrant;
          bVal = b.quadrant;
          return sortDir === 'asc' ? (aVal as string).localeCompare(bVal as string) : (bVal as string).localeCompare(aVal as string);
        case 'excessReturn3m':
          aVal = a.metrics.excessReturn3m;
          bVal = b.metrics.excessReturn3m;
          break;
        case 'rsMomentum21d':
          aVal = a.metrics.rsMomentum21d;
          bVal = b.metrics.rsMomentum21d;
          break;
        case 'medianRs':
          aVal = a.metrics.medianRs;
          bVal = b.metrics.medianRs;
          break;
        case 'beatingBenchmarkPct':
          aVal = a.metrics.beatingBenchmarkPct;
          bVal = b.metrics.beatingBenchmarkPct;
          break;
        case 'improvingRsPct':
          aVal = a.metrics.improvingRsPct;
          bVal = b.metrics.improvingRsPct;
          break;
        case 'setupCoveragePct':
          aVal = a.metrics.setupCoveragePct;
          bVal = b.metrics.setupCoveragePct;
          break;
        case 'totalTurnover20Cr':
          aVal = a.metrics.totalTurnover20Cr;
          bVal = b.metrics.totalTurnover20Cr;
          break;
        case 'constituentCount':
          aVal = a.metrics.constituentCount;
          bVal = b.metrics.constituentCount;
          break;
      }

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
    return items;
  }, [filteredItems, sortField, sortDir]);

  // Sorted drawer constituents
  const sortedDrawerConstituents = useMemo(() => {
    if (!selectedDrawerItem) return [];
    const list = [...selectedDrawerItem.constituents];
    list.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;
      switch (stockSortField) {
        case 'symbol':
          return stockSortDir === 'asc' ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
        case 'rsRating':
          aVal = a.rsRating ?? -1;
          bVal = b.rsRating ?? -1;
          break;
        case 'excessReturn3m':
          aVal = a.excessReturn3m ?? -999;
          bVal = b.excessReturn3m ?? -999;
          break;
        case 'return1m':
          aVal = a.return1m ?? -999;
          bVal = b.return1m ?? -999;
          break;
        case 'marketCapCr':
          aVal = a.marketCapCr;
          bVal = b.marketCapCr;
          break;
        case 'turnover20Cr':
          aVal = a.turnover20Cr;
          bVal = b.turnover20Cr;
          break;
      }
      return stockSortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return list;
  }, [selectedDrawerItem, stockSortField, stockSortDir]);

  // SVG Chart Dimensions & Scales
  const svgWidth = 920;
  const svgHeight = 560;
  const padding = { top: 40, right: 60, bottom: 50, left: 60 };
  const plotWidth = svgWidth - padding.left - padding.right;
  const plotHeight = svgHeight - padding.top - padding.bottom;

  // Calculate dynamic axis domains centered around (0, 0)
  const { xMin, xMax, yMin, yMax, zeroX, zeroY } = useMemo(() => {
    let minX = -15;
    let maxX = 15;
    let minY = -15;
    let maxY = 15;

    for (const item of activeItems) {
      if (item.x < minX) minX = item.x;
      if (item.x > maxX) maxX = item.x;
      if (item.y < minY) minY = item.y;
      if (item.y > maxY) maxY = item.y;

      for (const pt of item.trail) {
        if (pt.week <= trailWeeks) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }
      }
    }

    // Add 12% padding for neat visual breathing room
    const spanX = Math.max(Math.abs(minX), Math.abs(maxX)) * 1.15;
    const spanY = Math.max(Math.abs(minY), Math.abs(maxY)) * 1.15;

    const finalXMin = -spanX;
    const finalXMax = spanX;
    const finalYMin = -spanY;
    const finalYMax = spanY;

    // Zero crosshair pixel positions
    const zX = padding.left + ((0 - finalXMin) / (finalXMax - finalXMin)) * plotWidth;
    const zY = padding.top + ((finalYMax - 0) / (finalYMax - finalYMin)) * plotHeight;

    return {
      xMin: finalXMin,
      xMax: finalXMax,
      yMin: finalYMin,
      yMax: finalYMax,
      zeroX: zX,
      zeroY: zY,
    };
  }, [activeItems, trailWeeks, plotWidth, plotHeight, padding.left, padding.top]);

  // Coordinate conversion helpers
  const getPx = (x: number) => padding.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const getPy = (y: number) => padding.top + ((yMax - y) / (yMax - yMin)) * plotHeight;

  // Grid tick marks
  const gridTicks = useMemo(() => {
    const ticksX: number[] = [];
    const ticksY: number[] = [];
    const stepX = Math.round((xMax / 4) / 5) * 5 || 5;
    const stepY = Math.round((yMax / 4) / 5) * 5 || 5;

    for (let x = -Math.floor(xMax / stepX) * stepX; x <= xMax; x += stepX) {
      if (x !== 0) ticksX.push(x);
    }
    for (let y = -Math.floor(yMax / stepY) * stepY; y <= yMax; y += stepY) {
      if (y !== 0) ticksY.push(y);
    }
    return { ticksX, ticksY };
  }, [xMax, yMax]);

  // Quadrant color mapping
  const getQuadrantColor = (quadrant: RrgQuadrant) => {
    switch (quadrant) {
      case 'Leading':
        return '#10b981';
      case 'Weakening':
        return '#f59e0b';
      case 'Lagging':
        return '#f43f5e';
      case 'Improving':
        return '#3b82f6';
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const handleStockSort = (field: typeof stockSortField) => {
    if (stockSortField === field) {
      setStockSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setStockSortField(field);
      setStockSortDir('desc');
    }
  };

  // Node radius based on constituent count
  const getNodeRadius = (count: number) => {
    return Math.min(13, Math.max(6, 5 + Math.sqrt(count) * 1.2));
  };

  if (isLoading) {
    return (
      <div className="rrg-container" role="status">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: 'var(--muted)', gap: '0.75rem' }}>
          <Compass className="animate-spin" size={24} />
          <span>Generating Relative Rotation Graph across thematic universe…</span>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rrg-container" role="alert">
        <div style={{ padding: '2rem', textAlign: 'center', background: 'var(--surface-subtle)', borderRadius: '12px', border: '1px solid var(--line)' }}>
          <p style={{ color: '#f43f5e', fontWeight: 600, marginBottom: '0.5rem' }}>
            Failed to load Thematic RRG dataset
          </p>
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: '1rem' }}>
            {error instanceof Error ? error.message : 'Unknown network or parsing error.'}
          </p>
          <button className="button button-ghost" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rrg-container">
      {/* Header */}
      <header className="rrg-header">
        <div className="rrg-title-group">
          <h1>
            <Compass size={22} style={{ color: '#6366f1' }} />
            Thematic Relative Rotation Graph
            <span className="rrg-title-badge">RRG · Nexus Hierarchy</span>
          </h1>
          <div className="rrg-subtitle">
            Benchmark: <strong>{data.benchmark}</strong> (3M: <span className={data.benchmark3mReturn >= 0 ? 'val-positive' : 'val-negative'}>{data.benchmark3mReturn > 0 ? `+${data.benchmark3mReturn.toFixed(2)}` : data.benchmark3mReturn.toFixed(2)}%</span>) · As of {data.asOfDate} · {data.totalBlocks} Blocks · {data.totalNiches} Niches · {data.totalEquities} Mapped Equities
          </div>
        </div>

        {/* Top Controls */}
        <div className="rrg-controls-row">
          {/* Segmented Block vs Niche Toggle */}
          {!activeDrillBlock && (
            <div className="rrg-segmented-control" role="group" aria-label="Granularity">
              <button
                type="button"
                className="rrg-segmented-btn"
                aria-pressed={viewMode === 'blocks'}
                onClick={() => setViewMode('blocks')}
              >
                Thematic Blocks ({data.blocks.length})
              </button>
              <button
                type="button"
                className="rrg-segmented-btn"
                aria-pressed={viewMode === 'niches'}
                onClick={() => setViewMode('niches')}
              >
                All Niches ({data.niches.length})
              </button>
            </div>
          )}

          {/* Breadcrumbs if drilled into a block */}
          {activeDrillBlock && (
            <nav className="rrg-breadcrumbs" aria-label="Drilldown Breadcrumbs">
              <button
                type="button"
                className="rrg-breadcrumb-btn"
                onClick={() => {
                  setActiveDrillBlock(null);
                  setViewMode('blocks');
                }}
              >
                All Blocks
              </button>
              <ChevronRight size={14} />
              <strong style={{ color: 'var(--text)' }}>{activeDrillBlock}</strong>
              <button
                type="button"
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', marginLeft: '0.35rem' }}
                onClick={() => {
                  setActiveDrillBlock(null);
                  setViewMode('blocks');
                }}
                title="Back to all blocks"
              >
                <X size={14} />
              </button>
            </nav>
          )}

          {/* Trail Length Selector */}
          <div className="rrg-segmented-control" role="group" aria-label="Trail Length">
            {[4, 8, 12].map((w) => (
              <button
                key={w}
                type="button"
                className="rrg-segmented-btn"
                aria-pressed={trailWeeks === w}
                onClick={() => setTrailWeeks(w)}
              >
                {w}W Trail
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Filter Row: Quadrant chips + Search bar */}
      <div className="rrg-controls-row">
        <div className="rrg-filter-chips">
          <button
            type="button"
            className={`rrg-chip ${selectedQuadrant === 'ALL' ? 'active' : ''}`}
            onClick={() => setSelectedQuadrant('ALL')}
          >
            All ({quadrantCounts.ALL})
          </button>
          <button
            type="button"
            className={`rrg-chip chip-leading ${selectedQuadrant === 'Leading' ? 'active' : ''}`}
            onClick={() => setSelectedQuadrant(selectedQuadrant === 'Leading' ? 'ALL' : 'Leading')}
          >
            <span className="rrg-dot dot-leading" />
            Leading ({quadrantCounts.Leading})
          </button>
          <button
            type="button"
            className={`rrg-chip chip-weakening ${selectedQuadrant === 'Weakening' ? 'active' : ''}`}
            onClick={() => setSelectedQuadrant(selectedQuadrant === 'Weakening' ? 'ALL' : 'Weakening')}
          >
            <span className="rrg-dot dot-weakening" />
            Weakening ({quadrantCounts.Weakening})
          </button>
          <button
            type="button"
            className={`rrg-chip chip-lagging ${selectedQuadrant === 'Lagging' ? 'active' : ''}`}
            onClick={() => setSelectedQuadrant(selectedQuadrant === 'Lagging' ? 'ALL' : 'Lagging')}
          >
            <span className="rrg-dot dot-lagging" />
            Lagging ({quadrantCounts.Lagging})
          </button>
          <button
            type="button"
            className={`rrg-chip chip-improving ${selectedQuadrant === 'Improving' ? 'active' : ''}`}
            onClick={() => setSelectedQuadrant(selectedQuadrant === 'Improving' ? 'ALL' : 'Improving')}
          >
            <span className="rrg-dot dot-improving" />
            Improving ({quadrantCounts.Improving})
          </button>
        </div>

        {/* Real-time search */}
        <div className="rrg-search-wrapper">
          <Search size={14} className="rrg-search-icon" />
          <input
            type="text"
            className="rrg-search-input"
            placeholder={activeDrillBlock ? `Filter niches in ${activeDrillBlock}…` : 'Filter blocks or niches…'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Relative Rotation Graph Canvas */}
      <div className="rrg-canvas-card">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="rrg-svg-root"
          onMouseLeave={() => setHoveredNode(null)}
        >
          {/* Defs for gradients & markers */}
          <defs>
            <marker
              id="arrow-head"
              markerWidth="6"
              markerHeight="6"
              refX="4"
              refY="3"
              orient="auto"
            >
              <polygon points="0 1, 5 3, 0 5" fill="currentColor" opacity="0.75" />
            </marker>
          </defs>

          {/* 1. Quadrant background fills */}
          {/* Improving: Top-Left (X < 0, Y > 0) */}
          <rect
            x={padding.left}
            y={padding.top}
            width={Math.max(0, zeroX - padding.left)}
            height={Math.max(0, zeroY - padding.top)}
            className="rrg-quadrant-bg-improving"
          />
          {/* Leading: Top-Right (X >= 0, Y >= 0) */}
          <rect
            x={zeroX}
            y={padding.top}
            width={Math.max(0, svgWidth - padding.right - zeroX)}
            height={Math.max(0, zeroY - padding.top)}
            className="rrg-quadrant-bg-leading"
          />
          {/* Lagging: Bottom-Left (X < 0, Y < 0) */}
          <rect
            x={padding.left}
            y={zeroY}
            width={Math.max(0, zeroX - padding.left)}
            height={Math.max(0, svgHeight - padding.bottom - zeroY)}
            className="rrg-quadrant-bg-lagging"
          />
          {/* Weakening: Bottom-Right (X >= 0, Y < 0) */}
          <rect
            x={zeroX}
            y={zeroY}
            width={Math.max(0, svgWidth - padding.right - zeroX)}
            height={Math.max(0, svgHeight - padding.bottom - zeroY)}
            className="rrg-quadrant-bg-weakening"
          />

          {/* 2. Quadrant Watermark Labels */}
          <text x={padding.left + 14} y={padding.top + 22} className="rrg-quadrant-label" style={{ fill: '#3b82f6' }}>
            IMPROVING · Underperforming / RS Strengthening
          </text>
          <text
            x={svgWidth - padding.right - 14}
            y={padding.top + 22}
            className="rrg-quadrant-label"
            textAnchor="end"
            style={{ fill: '#10b981' }}
          >
            LEADING · Outperforming / RS Strengthening
          </text>
          <text
            x={padding.left + 14}
            y={svgHeight - padding.bottom - 14}
            className="rrg-quadrant-label"
            style={{ fill: '#f43f5e' }}
          >
            LAGGING · Underperforming / RS Weakening
          </text>
          <text
            x={svgWidth - padding.right - 14}
            y={svgHeight - padding.bottom - 14}
            className="rrg-quadrant-label"
            textAnchor="end"
            style={{ fill: '#f59e0b' }}
          >
            WEAKENING · Outperforming / RS Weakening
          </text>

          {/* 3. Grid Lines */}
          {gridTicks.ticksX.map((tick) => {
            const px = getPx(tick);
            return (
              <g key={`gx-${tick}`}>
                <line x1={px} y1={padding.top} x2={px} y2={svgHeight - padding.bottom} className="rrg-grid-line" />
                <text x={px} y={svgHeight - padding.bottom + 16} textAnchor="middle" className="rrg-axis-text">
                  {tick > 0 ? `+${tick}%` : `${tick}%`}
                </text>
              </g>
            );
          })}

          {gridTicks.ticksY.map((tick) => {
            const py = getPy(tick);
            return (
              <g key={`gy-${tick}`}>
                <line x1={padding.left} y1={py} x2={svgWidth - padding.right} y2={py} className="rrg-grid-line" />
                <text x={padding.left - 8} y={py + 3} textAnchor="end" className="rrg-axis-text">
                  {tick > 0 ? `+${tick}` : `${tick}`}
                </text>
              </g>
            );
          })}

          {/* 4. Center Crosshairs (0, 0) */}
          <line
            x1={zeroX}
            y1={padding.top}
            x2={zeroX}
            y2={svgHeight - padding.bottom}
            className="rrg-axis-center"
          />
          <line
            x1={padding.left}
            y1={zeroY}
            x2={svgWidth - padding.right}
            y2={zeroY}
            className="rrg-axis-center"
          />

          {/* Zero Labels */}
          <text x={zeroX} y={svgHeight - padding.bottom + 16} textAnchor="middle" className="rrg-axis-text" style={{ fontWeight: 700 }}>
            0%
          </text>
          <text x={padding.left - 8} y={zeroY + 3} textAnchor="end" className="rrg-axis-text" style={{ fontWeight: 700 }}>
            0
          </text>

          {/* Axis Labels */}
          <text
            x={svgWidth / 2}
            y={svgHeight - 12}
            textAnchor="middle"
            className="rrg-axis-text"
            style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em' }}
          >
            ← UNDERPERFORMING BENCHMARK | 3-MONTH MEDIAN EXCESS RETURN VS NIFTY 500 (%) | OUTPERFORMING BENCHMARK →
          </text>
          <text
            x={-(svgHeight / 2)}
            y={16}
            transform="rotate(-90)"
            textAnchor="middle"
            className="rrg-axis-text"
            style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em' }}
          >
            ← WEAKENING RS MOMENTUM | 1-MONTH CHANGE IN RS RATING (21-DAY Δ) | STRENGTHENING RS MOMENTUM →
          </text>

          {/* 5. Historical Rotation Trails */}
          {filteredItems.map((item) => {
            const isHovered = hoveredNode?.item.name === item.name;
            const itemColor = getQuadrantColor(item.quadrant);

            // Filter trail to selected trail length
            const relevantTrail = item.trail
              .filter((pt) => pt.week <= trailWeeks)
              .sort((a, b) => b.week - a.week); // oldest to newest

            if (relevantTrail.length < 2) return null;

            const pathPoints = relevantTrail.map((pt) => `${getPx(pt.x)},${getPy(pt.y)}`).join(' ');

            return (
              <g key={`trail-${item.name}`}>
                <polyline
                  points={pathPoints}
                  fill="none"
                  stroke={itemColor}
                  className="rrg-trail-line"
                  style={{
                    opacity: isHovered ? 0.95 : 0.35,
                    strokeWidth: isHovered ? 2.5 : 1.25,
                  }}
                />
                {/* Intermediate trail dots for rotation cadence */}
                {relevantTrail.map((pt) => (
                  <circle
                    key={`dot-${item.name}-${pt.week}`}
                    cx={getPx(pt.x)}
                    cy={getPy(pt.y)}
                    r={pt.week === 0 ? 0 : 2}
                    fill={itemColor}
                    opacity={isHovered ? 0.7 : 0.3}
                  />
                ))}
              </g>
            );
          })}

          {/* 6. Nodes at Current Week (T0) */}
          {filteredItems.map((item) => {
            const cx = getPx(item.x);
            const cy = getPy(item.y);
            const radius = getNodeRadius(item.metrics.constituentCount);
            const isHovered = hoveredNode?.item.name === item.name;
            const isSelected = selectedDrawerItem?.name === item.name;
            const itemColor = getQuadrantColor(item.quadrant);

            return (
              <g
                key={`node-${item.name}`}
                className={`rrg-node-point ${isSelected ? 'selected' : ''}`}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setHoveredNode({
                    item,
                    screenX: rect.right + 12,
                    screenY: rect.top - 20,
                  });
                }}
                onClick={() => {
                  if (viewMode === 'blocks' && !activeDrillBlock) {
                    setActiveDrillBlock(item.name);
                  } else {
                    setSelectedDrawerItem(item);
                  }
                }}
              >
                {/* Halo ring when hovered or selected */}
                {(isHovered || isSelected) && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={radius + 5}
                    fill="none"
                    stroke={itemColor}
                    strokeWidth={2}
                    opacity={0.6}
                  />
                )}

                <circle
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill={itemColor}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  style={{ color: itemColor }}
                />

                {/* Node Label: show prominent or if hovered / viewMode === 'blocks' */}
                {(viewMode === 'blocks' || isHovered || Math.abs(item.x) > 10 || Math.abs(item.y) > 8) && (
                  <text
                    x={cx + radius + 4}
                    y={cy + 3}
                    className="rrg-node-label"
                    style={{
                      opacity: isHovered ? 1 : 0.8,
                      fontWeight: isHovered ? 700 : 500,
                    }}
                  >
                    {item.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Floating Tooltip */}
        {hoveredNode && (
          <div
            className="rrg-tooltip"
            style={{
              left: Math.min(window.innerWidth - 260, Math.max(20, hoveredNode.screenX)),
              top: Math.max(100, hoveredNode.screenY),
              position: 'fixed',
            }}
          >
            <div className="rrg-tooltip-header">
              <span className="rrg-tooltip-title">{hoveredNode.item.name}</span>
              <span className={`rrg-tooltip-badge badge-${hoveredNode.item.quadrant.toLowerCase()}`}>
                {hoveredNode.item.quadrant}
              </span>
            </div>

            <div className="rrg-tooltip-row">
              <span>3M Excess Return:</span>
              <span className={`rrg-tooltip-val ${hoveredNode.item.x >= 0 ? 'val-positive' : 'val-negative'}`}>
                {hoveredNode.item.x > 0 ? `+${hoveredNode.item.x.toFixed(2)}` : hoveredNode.item.x.toFixed(2)}%
              </span>
            </div>

            <div className="rrg-tooltip-row">
              <span>1M RS Momentum (21D):</span>
              <span className={`rrg-tooltip-val ${hoveredNode.item.y >= 0 ? 'val-positive' : 'val-negative'}`}>
                {hoveredNode.item.y > 0 ? `+${hoveredNode.item.y.toFixed(1)}` : hoveredNode.item.y.toFixed(1)}
              </span>
            </div>

            <div className="rrg-tooltip-row">
              <span>Median RS Rating:</span>
              <span className="rrg-tooltip-val">{hoveredNode.item.metrics.medianRs}</span>
            </div>

            <div className="rrg-tooltip-row">
              <span>Breadth (% &gt; N500):</span>
              <span className="rrg-tooltip-val">{hoveredNode.item.metrics.beatingBenchmarkPct}%</span>
            </div>

            <div className="rrg-tooltip-row">
              <span>RS Improving Breadth:</span>
              <span className="rrg-tooltip-val">{hoveredNode.item.metrics.improvingRsPct}%</span>
            </div>

            <div className="rrg-tooltip-row">
              <span>Setup Coverage:</span>
              <span className="rrg-tooltip-val">{hoveredNode.item.metrics.setupCoveragePct}%</span>
            </div>

            <div className="rrg-tooltip-row">
              <span>Constituents:</span>
              <span className="rrg-tooltip-val">{hoveredNode.item.metrics.constituentCount} stocks</span>
            </div>

            {hoveredNode.item.metrics.topContributors?.length > 0 && (
              <div className="rrg-tooltip-contributors">
                Top: {hoveredNode.item.metrics.topContributors.join(', ')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ranked Thematic Table */}
      <section className="rrg-table-card">
        <div className="rrg-table-header-row">
          <div className="rrg-table-title">
            {activeDrillBlock
              ? `Niches in ${activeDrillBlock} (${sortedItems.length})`
              : viewMode === 'blocks'
              ? `Thematic Blocks Ranked (${sortedItems.length})`
              : `Thematic Niches Ranked (${sortedItems.length})`}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
            Click any row to view constituents &amp; setups
          </span>
        </div>

        <div className="rrg-table-wrapper">
          <table className="rrg-table">
            <thead>
              <tr>
                <th onClick={() => handleSort('name')}>
                  Name <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('quadrant')}>
                  Quadrant <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('excessReturn3m')}>
                  3M Excess vs N500 <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('rsMomentum21d')}>
                  RS Mom (21D Δ) <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('medianRs')}>
                  Median RS <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('beatingBenchmarkPct')}>
                  % &gt; N500 <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('improvingRsPct')}>
                  % RS Imp <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('setupCoveragePct')}>
                  Setup Cov <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('totalTurnover20Cr')}>
                  20D TO (₹ Cr) <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th onClick={() => handleSort('constituentCount')}>
                  Stocks <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                </th>
                <th>Top Contributors</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item) => (
                <tr
                  key={item.name}
                  onClick={() => {
                    if (viewMode === 'blocks' && !activeDrillBlock) {
                      setActiveDrillBlock(item.name);
                    } else {
                      setSelectedDrawerItem(item);
                    }
                  }}
                >
                  <td style={{ fontWeight: 600 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className={`rrg-dot dot-${item.quadrant.toLowerCase()}`} />
                      <span>{item.name}</span>
                    </div>
                  </td>
                  <td>
                    <span className={`rrg-tooltip-badge badge-${item.quadrant.toLowerCase()}`}>
                      {item.quadrant}
                    </span>
                  </td>
                  <td className={`val-mono ${item.metrics.excessReturn3m >= 0 ? 'val-positive' : 'val-negative'}`}>
                    {item.metrics.excessReturn3m > 0 ? `+${item.metrics.excessReturn3m.toFixed(2)}` : item.metrics.excessReturn3m.toFixed(2)}%
                  </td>
                  <td className={`val-mono ${item.metrics.rsMomentum21d >= 0 ? 'val-positive' : 'val-negative'}`}>
                    {item.metrics.rsMomentum21d > 0 ? `+${item.metrics.rsMomentum21d.toFixed(1)}` : item.metrics.rsMomentum21d.toFixed(1)}
                  </td>
                  <td className="val-mono">{item.metrics.medianRs}</td>
                  <td className="val-mono">{item.metrics.beatingBenchmarkPct}%</td>
                  <td className="val-mono">{item.metrics.improvingRsPct}%</td>
                  <td className="val-mono">{item.metrics.setupCoveragePct}%</td>
                  <td className="val-mono">{Math.round(item.metrics.totalTurnover20Cr).toLocaleString('en-IN')}</td>
                  <td className="val-mono">{item.metrics.constituentCount}</td>
                  <td style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                    {item.metrics.topContributors?.slice(0, 3).join(', ')}
                  </td>
                  <td>
                    {viewMode === 'blocks' && !activeDrillBlock ? (
                      <button
                        type="button"
                        className="button button-ghost"
                        style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveDrillBlock(item.name);
                        }}
                      >
                        Niches →
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button-ghost"
                        style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDrawerItem(item);
                        }}
                      >
                        Stocks →
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Constituent Stock Slide-Over Drawer */}
      {selectedDrawerItem && (
        <>
          <div
            className="rrg-drawer-backdrop"
            onClick={() => setSelectedDrawerItem(null)}
          />
          <aside className="rrg-drawer" aria-label="Constituents Drawer">
            <header className="rrg-drawer-header">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className={`rrg-dot dot-${selectedDrawerItem.quadrant.toLowerCase()}`} />
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>
                    {selectedDrawerItem.name}
                  </h2>
                  <span className={`rrg-tooltip-badge badge-${selectedDrawerItem.quadrant.toLowerCase()}`}>
                    {selectedDrawerItem.quadrant}
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
                  {selectedDrawerItem.parentBlock ? `Parent Block: ${selectedDrawerItem.parentBlock} · ` : ''}
                  {selectedDrawerItem.metrics.constituentCount} Equities · Median RS: {selectedDrawerItem.metrics.medianRs} · 3M Excess: {selectedDrawerItem.metrics.excessReturn3m > 0 ? `+${selectedDrawerItem.metrics.excessReturn3m.toFixed(2)}` : selectedDrawerItem.metrics.excessReturn3m.toFixed(2)}%
                </div>
              </div>
              <button
                type="button"
                className="rrg-drawer-close"
                onClick={() => setSelectedDrawerItem(null)}
                aria-label="Close constituents drawer"
              >
                <X size={20} />
              </button>
            </header>

            <div className="rrg-drawer-body">
              <div className="rrg-table-wrapper">
                <table className="rrg-table">
                  <thead>
                    <tr>
                      <th onClick={() => handleStockSort('symbol')}>Symbol</th>
                      <th>Close (1D)</th>
                      <th onClick={() => handleStockSort('rsRating')}>RS (21D Δ)</th>
                      <th onClick={() => handleStockSort('return1m')}>1M Ret</th>
                      <th onClick={() => handleStockSort('excessReturn3m')}>3M Excess</th>
                      <th>Active Setups</th>
                      <th onClick={() => handleStockSort('turnover20Cr')}>20D TO (₹Cr)</th>
                      <th onClick={() => handleStockSort('marketCapCr')}>MCap (₹Cr)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDrawerConstituents.map((stock) => (
                      <tr key={stock.symbol}>
                        <td>
                          <div>
                            <strong style={{ color: 'var(--text)' }}>{stock.symbol}</strong>
                            <div style={{ fontSize: '0.7rem', color: 'var(--muted)', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {stock.name}
                            </div>
                          </div>
                        </td>
                        <td className="val-mono">
                          ₹{stock.close.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          <div className={stock.changePct >= 0 ? 'val-positive' : 'val-negative'} style={{ fontSize: '0.7rem' }}>
                            {stock.changePct > 0 ? `+${stock.changePct.toFixed(2)}%` : `${stock.changePct.toFixed(2)}%`}
                          </div>
                        </td>
                        <td className="val-mono">
                          <span style={{ fontWeight: 700 }}>{stock.rsRating ?? '—'}</span>
                          {stock.rsChange21d !== null && (
                            <span className={stock.rsChange21d >= 0 ? 'val-positive' : 'val-negative'} style={{ fontSize: '0.7rem', marginLeft: '0.35rem' }}>
                              {stock.rsChange21d > 0 ? `(+${stock.rsChange21d})` : `(${stock.rsChange21d})`}
                            </span>
                          )}
                        </td>
                        <td className={`val-mono ${stock.return1m !== null && stock.return1m >= 0 ? 'val-positive' : 'val-negative'}`}>
                          {stock.return1m !== null ? (stock.return1m > 0 ? `+${stock.return1m.toFixed(1)}%` : `${stock.return1m.toFixed(1)}%`) : '—'}
                        </td>
                        <td className={`val-mono ${stock.excessReturn3m !== null && stock.excessReturn3m >= 0 ? 'val-positive' : 'val-negative'}`}>
                          {stock.excessReturn3m !== null ? (stock.excessReturn3m > 0 ? `+${stock.excessReturn3m.toFixed(1)}%` : `${stock.excessReturn3m.toFixed(1)}%`) : '—'}
                        </td>
                        <td>
                          <div className="rrg-setup-pills">
                            {stock.setups.stage2 && <span className="rrg-setup-pill active">Stage 2</span>}
                            {stock.setups.vcp && <span className="rrg-setup-pill active">VCP</span>}
                            {stock.setups.darvas && <span className="rrg-setup-pill active">Darvas</span>}
                            {stock.setups.bullFlag && <span className="rrg-setup-pill active">Bull Flag</span>}
                            {stock.setups.cupHandle && <span className="rrg-setup-pill active">Cup&amp;H</span>}
                            {stock.setups.pocketPivot && <span className="rrg-setup-pill active">Pocket</span>}
                            {stock.setups.coiled && <span className="rrg-setup-pill active">Coiled</span>}
                            {stock.setups.tightWeeks && <span className="rrg-setup-pill active">Tight</span>}
                            {!Object.values(stock.setups).some(Boolean) && (
                              <span className="rrg-setup-pill" style={{ opacity: 0.5 }}>None</span>
                            )}
                          </div>
                        </td>
                        <td className="val-mono">
                          {Math.round(stock.turnover20Cr).toLocaleString('en-IN')}
                        </td>
                        <td className="val-mono">
                          {Math.round(stock.marketCapCr).toLocaleString('en-IN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
};

export default ThematicRrgTab;
