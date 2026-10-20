import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import {
  RrgQuadrant,
  RrgBlockItem,
  RrgNicheItem,
  RrgIpoItem,
} from '../types/thematicRrg';
import {
  Search,
  ChevronRight,
  X,
  ArrowUpDown,
  Compass,
  Sparkles,
} from 'lucide-react';

interface ThematicRrgTabProps {
  datasetRevision?: string;
}

type ViewMode = 'blocks' | 'niches' | 'ipos';
type SortDirection = 'asc' | 'desc';

type ClusterSortField =
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

type IpoSortField =
  | 'symbol'
  | 'quadrant'
  | 'excessReturn10d'
  | 'turnoverIntensity'
  | 'close'
  | 'listingDate'
  | 'gainSinceListingPct'
  | 'turnoverCr'
  | 'deliveryPct'
  | 'marketCapCr';

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
    item: RrgBlockItem | RrgNicheItem | RrgIpoItem;
    screenX: number;
    screenY: number;
  } | null>(null);

  const [selectedDrawerItem, setSelectedDrawerItem] = useState<RrgBlockItem | RrgNicheItem | null>(null);
  const [selectedIpoDrawerItem, setSelectedIpoDrawerItem] = useState<RrgIpoItem | null>(null);

  // Sorting state for clusters
  const [clusterSortField, setClusterSortField] = useState<ClusterSortField>('excessReturn3m');
  const [clusterSortDir, setClusterSortDir] = useState<SortDirection>('desc');

  // Sorting state for IPOs
  const [ipoSortField, setIpoSortField] = useState<IpoSortField>('excessReturn10d');
  const [ipoSortDir, setIpoSortDir] = useState<SortDirection>('desc');

  // Constituent drawer sorting
  const [stockSortField, setStockSortField] = useState<'symbol' | 'rsRating' | 'excessReturn3m' | 'return1m' | 'marketCapCr' | 'turnover20Cr'>('excessReturn3m');
  const [stockSortDir, setStockSortDir] = useState<SortDirection>('desc');

  // Active items depending on viewMode and drilldown
  const activeClusterItems = useMemo<(RrgBlockItem | RrgNicheItem)[]>(() => {
    if (!data) return [];
    if (activeDrillBlock) {
      return data.niches.filter((n) => n.parentBlock === activeDrillBlock);
    }
    if (viewMode === 'blocks') {
      return data.blocks;
    }
    if (viewMode === 'niches') {
      return data.niches;
    }
    return [];
  }, [data, viewMode, activeDrillBlock]);

  const activeIpoItems = useMemo<RrgIpoItem[]>(() => {
    if (!data || viewMode !== 'ipos') return [];
    return data.ipoTactical ?? [];
  }, [data, viewMode]);

  // Filtered items
  const filteredClusterItems = useMemo(() => {
    let result = activeClusterItems;
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
  }, [activeClusterItems, selectedQuadrant, searchQuery]);

  const filteredIpoItems = useMemo(() => {
    let result = activeIpoItems;
    if (selectedQuadrant !== 'ALL') {
      result = result.filter((item) => item.quadrant === selectedQuadrant);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (item) =>
          item.symbol.toLowerCase().includes(q) ||
          item.name.toLowerCase().includes(q) ||
          (item.theme && item.theme.toLowerCase().includes(q)) ||
          (item.block && item.block.toLowerCase().includes(q))
      );
    }
    return result;
  }, [activeIpoItems, selectedQuadrant, searchQuery]);

  // Quadrant counts across current view scope
  const quadrantCounts = useMemo(() => {
    const list = viewMode === 'ipos' ? activeIpoItems : activeClusterItems;
    const counts = { ALL: list.length, Leading: 0, Weakening: 0, Lagging: 0, Improving: 0 };
    for (const item of list) {
      if (counts[item.quadrant] !== undefined) {
        counts[item.quadrant]++;
      }
    }
    return counts;
  }, [viewMode, activeIpoItems, activeClusterItems]);

  // Sorted items for cluster table
  const sortedClusterItems = useMemo(() => {
    const items = [...filteredClusterItems];
    items.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      switch (clusterSortField) {
        case 'name':
          return clusterSortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
        case 'quadrant':
          return clusterSortDir === 'asc' ? a.quadrant.localeCompare(b.quadrant) : b.quadrant.localeCompare(a.quadrant);
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
        return clusterSortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
    return items;
  }, [filteredClusterItems, clusterSortField, clusterSortDir]);

  // Sorted items for IPO table
  const sortedIpoItems = useMemo(() => {
    const items = [...filteredIpoItems];
    items.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      switch (ipoSortField) {
        case 'symbol':
          return ipoSortDir === 'asc' ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
        case 'quadrant':
          return ipoSortDir === 'asc' ? a.quadrant.localeCompare(b.quadrant) : b.quadrant.localeCompare(a.quadrant);
        case 'excessReturn10d':
          aVal = a.excessReturn10d;
          bVal = b.excessReturn10d;
          break;
        case 'turnoverIntensity':
          aVal = a.turnoverIntensity;
          bVal = b.turnoverIntensity;
          break;
        case 'close':
          aVal = a.close;
          bVal = b.close;
          break;
        case 'listingDate':
          return ipoSortDir === 'asc' ? a.listingDate.localeCompare(b.listingDate) : b.listingDate.localeCompare(a.listingDate);
        case 'gainSinceListingPct':
          aVal = a.gainSinceListingPct;
          bVal = b.gainSinceListingPct;
          break;
        case 'turnoverCr':
          aVal = a.turnoverCr;
          bVal = b.turnoverCr;
          break;
        case 'deliveryPct':
          aVal = a.deliveryPct ?? -1;
          bVal = b.deliveryPct ?? -1;
          break;
        case 'marketCapCr':
          aVal = a.marketCapCr;
          bVal = b.marketCapCr;
          break;
      }

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return ipoSortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
    return items;
  }, [filteredIpoItems, ipoSortField, ipoSortDir]);

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

    const currentList = viewMode === 'ipos' ? activeIpoItems : activeClusterItems;

    for (const item of currentList) {
      if (item.x < minX) minX = item.x;
      if (item.x > maxX) maxX = item.x;
      if (item.y < minY) minY = item.y;
      if (item.y > maxY) maxY = item.y;

      for (const pt of item.trail) {
        if (viewMode === 'ipos' || pt.week <= trailWeeks) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }
      }
    }

    const spanX = Math.max(Math.abs(minX), Math.abs(maxX)) * 1.15;
    const spanY = Math.max(Math.abs(minY), Math.abs(maxY)) * 1.15;

    const finalXMin = -spanX;
    const finalXMax = spanX;
    const finalYMin = -spanY;
    const finalYMax = spanY;

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
  }, [viewMode, activeIpoItems, activeClusterItems, trailWeeks, plotWidth, plotHeight, padding.left, padding.top]);

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

  const handleClusterSort = (field: ClusterSortField) => {
    if (clusterSortField === field) {
      setClusterSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setClusterSortField(field);
      setClusterSortDir('desc');
    }
  };

  const handleIpoSort = (field: IpoSortField) => {
    if (ipoSortField === field) {
      setIpoSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setIpoSortField(field);
      setIpoSortDir('desc');
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

  if (isLoading) {
    return (
      <div className="rrg-container" role="status">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: 'var(--muted)', gap: '0.75rem' }}>
          <Compass className="animate-spin" size={24} />
          <span>Generating Relative Rotation Graph across thematic &amp; IPO universe…</span>
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
            {viewMode === 'ipos' ? 'Fast-Cadence Tactical IPO RRG' : 'Thematic Relative Rotation Graph'}
            <span className="rrg-title-badge">
              {viewMode === 'ipos' ? '10D Excess · Turnover Intensity' : '3M Excess · 21D RS Momentum'}
            </span>
          </h1>
          <div className="rrg-subtitle">
            Benchmark: <strong>{data.benchmark}</strong> · As of {data.asOfDate} · {data.totalBlocks} Blocks · {data.totalNiches} Niches · {data.ipoTactical?.length ?? 0} Tactical IPOs Tracked
          </div>
        </div>

        {/* Top Controls */}
        <div className="rrg-controls-row">
          {/* Segmented View Mode Toggle */}
          <div className="rrg-segmented-control" role="group" aria-label="Granularity">
            <button
              type="button"
              className="rrg-segmented-btn"
              aria-pressed={viewMode === 'blocks'}
              onClick={() => {
                setViewMode('blocks');
                setActiveDrillBlock(null);
              }}
            >
              Thematic Blocks ({data.blocks.length})
            </button>
            <button
              type="button"
              className="rrg-segmented-btn"
              aria-pressed={viewMode === 'niches'}
              onClick={() => {
                setViewMode('niches');
                setActiveDrillBlock(null);
              }}
            >
              All Niches ({data.niches.length})
            </button>
            <button
              type="button"
              className="rrg-segmented-btn"
              aria-pressed={viewMode === 'ipos'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
              onClick={() => {
                setViewMode('ipos');
                setActiveDrillBlock(null);
              }}
            >
              <Sparkles size={12} style={{ color: '#f59e0b' }} />
              Tactical IPO RRG ({data.ipoTactical?.length ?? 0})
            </button>
          </div>

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

          {/* Trail Length Selector (in block/niche mode) */}
          {viewMode !== 'ipos' && (
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
          )}
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
            placeholder={
              viewMode === 'ipos'
                ? 'Filter IPO debutants, themes...'
                : activeDrillBlock
                ? `Filter niches in ${activeDrillBlock}…`
                : 'Filter blocks or niches…'
            }
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
          {/* Quadrant background fills */}
          <rect
            x={padding.left}
            y={padding.top}
            width={Math.max(0, zeroX - padding.left)}
            height={Math.max(0, zeroY - padding.top)}
            className="rrg-quadrant-bg-improving"
          />
          <rect
            x={zeroX}
            y={padding.top}
            width={Math.max(0, svgWidth - padding.right - zeroX)}
            height={Math.max(0, zeroY - padding.top)}
            className="rrg-quadrant-bg-leading"
          />
          <rect
            x={padding.left}
            y={zeroY}
            width={Math.max(0, zeroX - padding.left)}
            height={Math.max(0, svgHeight - padding.bottom - zeroY)}
            className="rrg-quadrant-bg-lagging"
          />
          <rect
            x={zeroX}
            y={zeroY}
            width={Math.max(0, svgWidth - padding.right - zeroX)}
            height={Math.max(0, svgHeight - padding.bottom - zeroY)}
            className="rrg-quadrant-bg-weakening"
          />

          {/* Quadrant Watermark Labels */}
          <text x={padding.left + 14} y={padding.top + 22} className="rrg-quadrant-label" style={{ fill: '#3b82f6' }}>
            {viewMode === 'ipos' ? 'IMPROVING · Dip Buying / Surge Inflow' : 'IMPROVING · Underperforming / RS Strengthening'}
          </text>
          <text
            x={svgWidth - padding.right - 14}
            y={padding.top + 22}
            className="rrg-quadrant-label"
            textAnchor="end"
            style={{ fill: '#10b981' }}
          >
            {viewMode === 'ipos' ? 'LEADING · Outperforming / High Volume Inflow' : 'LEADING · Outperforming / RS Strengthening'}
          </text>
          <text
            x={padding.left + 14}
            y={svgHeight - padding.bottom - 14}
            className="rrg-quadrant-label"
            style={{ fill: '#f43f5e' }}
          >
            {viewMode === 'ipos' ? 'LAGGING · Underperforming / Subsiding Volume' : 'LAGGING · Underperforming / RS Weakening'}
          </text>
          <text
            x={svgWidth - padding.right - 14}
            y={svgHeight - padding.bottom - 14}
            className="rrg-quadrant-label"
            textAnchor="end"
            style={{ fill: '#f59e0b' }}
          >
            {viewMode === 'ipos' ? 'WEAKENING · Outperforming / Volume Cooling' : 'WEAKENING · Outperforming / RS Weakening'}
          </text>

          {/* Grid Lines */}
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
                  {tick > 0 ? `+${tick}%` : `${tick}%`}
                </text>
              </g>
            );
          })}

          {/* Center Crosshairs (0, 0) */}
          <line x1={zeroX} y1={padding.top} x2={zeroX} y2={svgHeight - padding.bottom} className="rrg-axis-center" />
          <line x1={padding.left} y1={zeroY} x2={svgWidth - padding.right} y2={zeroY} className="rrg-axis-center" />

          <text x={zeroX} y={svgHeight - padding.bottom + 16} textAnchor="middle" className="rrg-axis-text" style={{ fontWeight: 700 }}>
            0%
          </text>
          <text x={padding.left - 8} y={zeroY + 3} textAnchor="end" className="rrg-axis-text" style={{ fontWeight: 700 }}>
            0%
          </text>

          {/* Dynamic Axis Titles */}
          <text
            x={svgWidth / 2}
            y={svgHeight - 12}
            textAnchor="middle"
            className="rrg-axis-text"
            style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em' }}
          >
            {viewMode === 'ipos'
              ? '← UNDERPERFORMING BENCHMARK | 10-DAY / LTD EXCESS RETURN VS NIFTY 500 (%) | OUTPERFORMING BENCHMARK →'
              : '← UNDERPERFORMING BENCHMARK | 3-MONTH MEDIAN EXCESS RETURN VS NIFTY 500 (%) | OUTPERFORMING BENCHMARK →'}
          </text>
          <text
            x={-(svgHeight / 2)}
            y={16}
            transform="rotate(-90)"
            textAnchor="middle"
            className="rrg-axis-text"
            style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em' }}
          >
            {viewMode === 'ipos'
              ? '← SUBSIDING VOLUME | 5-DAY TURNOVER INTENSITY VS LISTING AVERAGE (%) | SURGING VOLUME ACCUMULATION →'
              : '← WEAKENING RS MOMENTUM | 1-MONTH CHANGE IN RS RATING (21-DAY Δ) | STRENGTHENING RS MOMENTUM →'}
          </text>

          {/* Trails */}
          {(viewMode === 'ipos' ? filteredIpoItems : filteredClusterItems).map((item) => {
            const isHovered =
              hoveredNode?.item.name === item.name ||
              ('symbol' in item && hoveredNode?.item && 'symbol' in hoveredNode.item && hoveredNode.item.symbol === item.symbol);
            const itemColor = getQuadrantColor(item.quadrant);

            const relevantTrail = item.trail
              .filter((pt) => viewMode === 'ipos' || pt.week <= trailWeeks)
              .sort((a, b) => b.week - a.week);

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
              </g>
            );
          })}

          {/* Nodes at T0 */}
          {(viewMode === 'ipos' ? filteredIpoItems : filteredClusterItems).map((item) => {
            const cx = getPx(item.x);
            const cy = getPy(item.y);
            const isIpo = 'listingDate' in item;
            const radius = isIpo ? 7 : Math.min(13, Math.max(6, 5 + Math.sqrt((item as RrgBlockItem).metrics?.constituentCount ?? 1) * 1.2));
            const isHovered =
              hoveredNode?.item.name === item.name ||
              (isIpo && hoveredNode?.item && 'symbol' in hoveredNode.item && hoveredNode.item.symbol === (item as RrgIpoItem).symbol);
            const itemColor = getQuadrantColor(item.quadrant);

            return (
              <g
                key={`node-${item.name}`}
                className="rrg-node-point"
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setHoveredNode({
                    item,
                    screenX: rect.right + 12,
                    screenY: rect.top - 20,
                  });
                }}
                onClick={() => {
                  if (isIpo) {
                    setSelectedIpoDrawerItem(item as RrgIpoItem);
                  } else if (viewMode === 'blocks' && !activeDrillBlock) {
                    setActiveDrillBlock(item.name);
                  } else {
                    setSelectedDrawerItem(item as RrgBlockItem | RrgNicheItem);
                  }
                }}
              >
                {isHovered && (
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

                {(viewMode === 'blocks' || isHovered || Math.abs(item.x) > 20 || (isIpo && Math.abs(item.y) > 40)) && (
                  <text
                    x={cx + radius + 4}
                    y={cy + 3}
                    className="rrg-node-label"
                    style={{
                      opacity: isHovered ? 1 : 0.8,
                      fontWeight: isHovered ? 700 : 500,
                    }}
                  >
                    {isIpo ? (item as RrgIpoItem).symbol : item.name}
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
              <span className="rrg-tooltip-title">
                {'symbol' in hoveredNode.item ? (hoveredNode.item as RrgIpoItem).symbol : hoveredNode.item.name}
              </span>
              <span className={`rrg-tooltip-badge badge-${hoveredNode.item.quadrant.toLowerCase()}`}>
                {hoveredNode.item.quadrant}
              </span>
            </div>

            {'listingDate' in hoveredNode.item ? (
              // IPO Tooltip fields
              <>
                <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.35rem' }}>
                  {(hoveredNode.item as RrgIpoItem).name}
                </div>
                <div className="rrg-tooltip-row">
                  <span>10D / LTD Excess:</span>
                  <span className={`rrg-tooltip-val ${hoveredNode.item.x >= 0 ? 'val-positive' : 'val-negative'}`}>
                    {hoveredNode.item.x > 0 ? `+${hoveredNode.item.x.toFixed(2)}` : hoveredNode.item.x.toFixed(2)}%
                  </span>
                </div>
                <div className="rrg-tooltip-row">
                  <span>Turnover Intensity:</span>
                  <span className={`rrg-tooltip-val ${hoveredNode.item.y >= 0 ? 'val-positive' : 'val-negative'}`}>
                    {hoveredNode.item.y > 0 ? `+${hoveredNode.item.y.toFixed(1)}` : hoveredNode.item.y.toFixed(1)}%
                  </span>
                </div>
                <div className="rrg-tooltip-row">
                  <span>Listed:</span>
                  <span className="rrg-tooltip-val">
                    {(hoveredNode.item as RrgIpoItem).listingDate} ({(hoveredNode.item as RrgIpoItem).listingAgeDays}d)
                  </span>
                </div>
                <div className="rrg-tooltip-row">
                  <span>Current Close:</span>
                  <span className="rrg-tooltip-val">₹{(hoveredNode.item as RrgIpoItem).close.toLocaleString('en-IN')}</span>
                </div>
                <div className="rrg-tooltip-row">
                  <span>Turnover (Day):</span>
                  <span className="rrg-tooltip-val">₹{(hoveredNode.item as RrgIpoItem).turnoverCr} Cr</span>
                </div>
                <div className="rrg-tooltip-row">
                  <span>Theme:</span>
                  <span className="rrg-tooltip-val">{(hoveredNode.item as RrgIpoItem).theme ?? '—'}</span>
                </div>
              </>
            ) : (
              // Cluster Tooltip fields
              <>
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
                  <span className="rrg-tooltip-val">{(hoveredNode.item as RrgBlockItem).metrics.medianRs}</span>
                </div>
                <div className="rrg-tooltip-row">
                  <span>Breadth (% &gt; N500):</span>
                  <span className="rrg-tooltip-val">{(hoveredNode.item as RrgBlockItem).metrics.beatingBenchmarkPct}%</span>
                </div>
                <div className="rrg-tooltip-row">
                  <span>Setup Coverage:</span>
                  <span className="rrg-tooltip-val">{(hoveredNode.item as RrgBlockItem).metrics.setupCoveragePct}%</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Ranked Table Area */}
      <section className="rrg-table-card">
        <div className="rrg-table-header-row">
          <div className="rrg-table-title">
            {viewMode === 'ipos'
              ? `Tactical IPO Debutants Ranked (${sortedIpoItems.length})`
              : activeDrillBlock
              ? `Niches in ${activeDrillBlock} (${sortedClusterItems.length})`
              : viewMode === 'blocks'
              ? `Thematic Blocks Ranked (${sortedClusterItems.length})`
              : `Thematic Niches Ranked (${sortedClusterItems.length})`}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
            {viewMode === 'ipos'
              ? 'Click any debutant to view performance breakdown'
              : 'Click any row to view constituents & setups'}
          </span>
        </div>

        <div className="rrg-table-wrapper">
          {viewMode === 'ipos' ? (
            // Tactical IPO Table
            <table className="rrg-table">
              <thead>
                <tr>
                  <th onClick={() => handleIpoSort('symbol')}>
                    Symbol <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('quadrant')}>
                    Quadrant <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('excessReturn10d')}>
                    10D / LTD Excess <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('turnoverIntensity')}>
                    Turnover Intensity <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('close')}>
                    Close (1D) <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('listingDate')}>
                    Listed (Age) <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('gainSinceListingPct')}>
                    Listing Gain <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('turnoverCr')}>
                    Turnover (₹Cr) <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleIpoSort('deliveryPct')}>
                    Delivery % <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th>Primary Theme</th>
                </tr>
              </thead>
              <tbody>
                {sortedIpoItems.map((stock) => (
                  <tr key={stock.symbol} onClick={() => setSelectedIpoDrawerItem(stock)}>
                    <td>
                      <div>
                        <strong style={{ color: 'var(--text)' }}>{stock.symbol}</strong>
                        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {stock.name}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`rrg-tooltip-badge badge-${stock.quadrant.toLowerCase()}`}>
                        {stock.quadrant}
                      </span>
                    </td>
                    <td className={`val-mono ${stock.excessReturn10d >= 0 ? 'val-positive' : 'val-negative'}`}>
                      {stock.excessReturn10d > 0 ? `+${stock.excessReturn10d.toFixed(2)}` : stock.excessReturn10d.toFixed(2)}%
                    </td>
                    <td className={`val-mono ${stock.turnoverIntensity >= 0 ? 'val-positive' : 'val-negative'}`}>
                      {stock.turnoverIntensity > 0 ? `+${stock.turnoverIntensity.toFixed(1)}` : stock.turnoverIntensity.toFixed(1)}%
                    </td>
                    <td className="val-mono">
                      ₹{stock.close.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      <div className={stock.changePct >= 0 ? 'val-positive' : 'val-negative'} style={{ fontSize: '0.7rem' }}>
                        {stock.changePct > 0 ? `+${stock.changePct.toFixed(2)}%` : `${stock.changePct.toFixed(2)}%`}
                      </div>
                    </td>
                    <td className="val-mono" style={{ fontSize: '0.75rem' }}>
                      {stock.listingDate}
                      <span style={{ color: 'var(--muted)', marginLeft: 4 }}>({stock.listingAgeDays}d)</span>
                    </td>
                    <td className={`val-mono ${stock.gainSinceListingPct >= 0 ? 'val-positive' : 'val-negative'}`}>
                      {stock.gainSinceListingPct > 0 ? `+${stock.gainSinceListingPct.toFixed(1)}%` : `${stock.gainSinceListingPct.toFixed(1)}%`}
                    </td>
                    <td className="val-mono">
                      {Math.round(stock.turnoverCr).toLocaleString('en-IN')}
                    </td>
                    <td className="val-mono">
                      {stock.deliveryPct !== null ? `${stock.deliveryPct.toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                      {stock.theme ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            // Cluster Table (Blocks & Niches)
            <table className="rrg-table">
              <thead>
                <tr>
                  <th onClick={() => handleClusterSort('name')}>
                    Name <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('quadrant')}>
                    Quadrant <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('excessReturn3m')}>
                    3M Excess vs N500 <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('rsMomentum21d')}>
                    RS Mom (21D Δ) <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('medianRs')}>
                    Median RS <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('beatingBenchmarkPct')}>
                    % &gt; N500 <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('improvingRsPct')}>
                    % RS Imp <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('setupCoveragePct')}>
                    Setup Cov <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('totalTurnover20Cr')}>
                    20D TO (₹ Cr) <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th onClick={() => handleClusterSort('constituentCount')}>
                    Stocks <ArrowUpDown size={11} style={{ display: 'inline', marginLeft: 2 }} />
                  </th>
                  <th>Top Contributors</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedClusterItems.map((item) => (
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
          )}
        </div>
      </section>

      {/* Cluster Constituent Stock Slide-Over Drawer */}
      {selectedDrawerItem && (
        <>
          <div className="rrg-drawer-backdrop" onClick={() => setSelectedDrawerItem(null)} />
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
                        <td className="val-mono">{Math.round(stock.turnover20Cr).toLocaleString('en-IN')}</td>
                        <td className="val-mono">{Math.round(stock.marketCapCr).toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </aside>
        </>
      )}

      {/* Individual Tactical IPO Detail Drawer */}
      {selectedIpoDrawerItem && (
        <>
          <div className="rrg-drawer-backdrop" onClick={() => setSelectedIpoDrawerItem(null)} />
          <aside className="rrg-drawer" aria-label="IPO Details Drawer">
            <header className="rrg-drawer-header">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className={`rrg-dot dot-${selectedIpoDrawerItem.quadrant.toLowerCase()}`} />
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>
                    {selectedIpoDrawerItem.symbol} — {selectedIpoDrawerItem.name}
                  </h2>
                  <span className={`rrg-tooltip-badge badge-${selectedIpoDrawerItem.quadrant.toLowerCase()}`}>
                    {selectedIpoDrawerItem.quadrant}
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
                  Listed {selectedIpoDrawerItem.listingDate} ({selectedIpoDrawerItem.listingAgeDays} days ago) · {selectedIpoDrawerItem.sessions} Trading Sessions · Primary Theme: {selectedIpoDrawerItem.theme ?? '—'}
                </div>
              </div>
              <button
                type="button"
                className="rrg-drawer-close"
                onClick={() => setSelectedIpoDrawerItem(null)}
                aria-label="Close IPO drawer"
              >
                <X size={20} />
              </button>
            </header>

            <div className="rrg-drawer-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                <div style={{ padding: '0.75rem', background: 'var(--surface-subtle)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>10D / LTD Excess vs N500</div>
                  <div className={`val-mono ${selectedIpoDrawerItem.excessReturn10d >= 0 ? 'val-positive' : 'val-negative'}`} style={{ fontSize: '1.25rem', marginTop: '0.25rem' }}>
                    {selectedIpoDrawerItem.excessReturn10d > 0 ? `+${selectedIpoDrawerItem.excessReturn10d.toFixed(2)}%` : `${selectedIpoDrawerItem.excessReturn10d.toFixed(2)}%`}
                  </div>
                </div>

                <div style={{ padding: '0.75rem', background: 'var(--surface-subtle)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>Turnover Intensity vs Baseline</div>
                  <div className={`val-mono ${selectedIpoDrawerItem.turnoverIntensity >= 0 ? 'val-positive' : 'val-negative'}`} style={{ fontSize: '1.25rem', marginTop: '0.25rem' }}>
                    {selectedIpoDrawerItem.turnoverIntensity > 0 ? `+${selectedIpoDrawerItem.turnoverIntensity.toFixed(1)}%` : `${selectedIpoDrawerItem.turnoverIntensity.toFixed(1)}%`}
                  </div>
                </div>

                <div style={{ padding: '0.75rem', background: 'var(--surface-subtle)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>Gain Since Listing</div>
                  <div className={`val-mono ${selectedIpoDrawerItem.gainSinceListingPct >= 0 ? 'val-positive' : 'val-negative'}`} style={{ fontSize: '1.25rem', marginTop: '0.25rem' }}>
                    {selectedIpoDrawerItem.gainSinceListingPct > 0 ? `+${selectedIpoDrawerItem.gainSinceListingPct.toFixed(1)}%` : `${selectedIpoDrawerItem.gainSinceListingPct.toFixed(1)}%`}
                  </div>
                </div>

                <div style={{ padding: '0.75rem', background: 'var(--surface-subtle)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>Current Price</div>
                  <div className="val-mono" style={{ fontSize: '1.25rem', marginTop: '0.25rem', fontWeight: 700 }}>
                    ₹{selectedIpoDrawerItem.close.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </div>
                </div>

                <div style={{ padding: '0.75rem', background: 'var(--surface-subtle)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>Daily Turnover</div>
                  <div className="val-mono" style={{ fontSize: '1.25rem', marginTop: '0.25rem', fontWeight: 700 }}>
                    ₹{selectedIpoDrawerItem.turnoverCr} Cr
                  </div>
                </div>

                <div style={{ padding: '0.75rem', background: 'var(--surface-subtle)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>Delivery %</div>
                  <div className="val-mono" style={{ fontSize: '1.25rem', marginTop: '0.25rem', fontWeight: 700 }}>
                    {selectedIpoDrawerItem.deliveryPct !== null ? `${selectedIpoDrawerItem.deliveryPct.toFixed(1)}%` : '—'}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
};

export default ThematicRrgTab;
