import { useCallback, useMemo, useState } from "react";
import {
  QUADRANT_ORDER,
  QUADRANT_VAR,
  fmtNum,
  fmtSigned,
  isIpoItem,
  itemKey,
  trailFor,
  type RrgBounds,
  type RrgItem,
} from "./rrgShared";
import type { RrgTrailPoint } from "../../types/thematicRrg";
import { useElementSize } from "./useElementSize";

const PAD = { top: 34, right: 30, bottom: 52, left: 64 };
const GRID_RATIOS = [-0.5, -0.25, 0.25, 0.5];

export interface RrgChartProps {
  items: RrgItem[];
  scope: RrgItem[];
  selectedKey: string | null;
  onSelect: (item: RrgItem) => void;
  weeks: number;
  showTrails: boolean;
  isIpoMode: boolean;
  showLabels: boolean;
  benchmark: string;
  bounds: RrgBounds;
}

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: LabelBox, b: LabelBox) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function RrgChart({
  items,
  scope,
  selectedKey,
  onSelect,
  weeks,
  showTrails,
  isIpoMode,
  showLabels,
  benchmark,
  bounds,
}: RrgChartProps) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const width = size.width || 900;
  const height = size.height || 520;

  const limits = bounds;

  const plotWidth = Math.max(120, width - PAD.left - PAD.right);
  const plotHeight = Math.max(120, height - PAD.top - PAD.bottom);
  const originX = PAD.left + plotWidth / 2;
  const originY = PAD.top + plotHeight / 2;
  const halfX = plotWidth / 2;
  const halfY = plotHeight / 2;

  const mapX = (x: number) =>
    originX + (Math.max(-limits.x, Math.min(limits.x, x)) / limits.x) * halfX;
  const mapY = (y: number) =>
    originY - (Math.max(-limits.y, Math.min(limits.y, y)) / limits.y) * halfY;

  const activeKey = hoveredKey ?? selectedKey;
  const activeItem =
    items.find((item) => itemKey(item) === activeKey) ??
    scope.find((item) => itemKey(item) === activeKey) ??
    null;

  /**
   * Trail points that fall outside the plotted range are dropped so the path
   * never collapses into a clamped zig-zag along the frame.
   */
  const segmentsFor = useCallback(
    (points: RrgTrailPoint[]) => {
      const segments: RrgTrailPoint[][] = [];
      let current: RrgTrailPoint[] = [];
      points.forEach((point) => {
        const inside = Math.abs(point.x) <= limits.x && Math.abs(point.y) <= limits.y;
        if (inside) {
          current.push(point);
        } else if (current.length) {
          segments.push(current);
          current = [];
        }
      });
      if (current.length) segments.push(current);
      return segments.filter((segment) => segment.length > 1);
    },
    [limits.x, limits.y],
  );

  const focalTrail = useMemo(() => {
    if (!activeItem) return [] as { x: number; y: number }[];
    const points = trailFor(activeItem, weeks, isIpoMode);
    return points.map((point) => ({ x: mapX(point.x), y: mapY(point.y) }));
  }, [activeItem, weeks, isIpoMode, width, height]);

  const focalPaths = useMemo(() => {
    if (!activeItem) return [] as string[];
    const segments = segmentsFor(trailFor(activeItem, weeks, isIpoMode));
    return segments.map((segment) =>
      segment
        .map(
          (point, index) =>
            `${index === 0 ? "M" : "L"} ${mapX(point.x).toFixed(1)} ${mapY(point.y).toFixed(1)}`,
        )
        .join(" "),
    );
  }, [activeItem, weeks, isIpoMode, segmentsFor, width, height]);

  const nonFocalTrails = useMemo(() => {
    if (!showTrails || weeks <= 0 || isIpoMode) return [] as { key: string; d: string; color: string }[];
    const out: { key: string; d: string; color: string }[] = [];
    items.forEach((item) => {
      const key = itemKey(item);
      if (key === activeKey) return;
      const segments = segmentsFor(trailFor(item, weeks, false));
      if (!segments.length) return;
      const d = segments
        .map((segment) =>
          segment
            .map(
              (point, index) =>
                `${index === 0 ? "M" : "L"} ${mapX(point.x).toFixed(1)} ${mapY(point.y).toFixed(1)}`,
            )
            .join(" "),
        )
        .join(" ");
      out.push({ key, d, color: QUADRANT_VAR[item.quadrant] });
    });
    return out;
  }, [items, weeks, showTrails, isIpoMode, activeKey, segmentsFor, width, height]);

  const labels = useMemo(() => {
    if (!showLabels && !activeKey) return [] as { key: string; x: number; y: number; anchor: "start" | "end"; text: string; strong: boolean }[];

    const candidates = items
      .map((item) => ({
        key: itemKey(item),
        item,
        strong: itemKey(item) === activeKey,
        importance: Math.abs(item.x) + Math.abs(item.y) * 2,
      }))
      .filter((candidate) => showLabels || candidate.strong)
      .sort((a, b) => {
        if (a.strong !== b.strong) return a.strong ? -1 : 1;
        return b.importance - a.importance;
      });

    const placed: LabelBox[] = [];
    const result: { key: string; x: number; y: number; anchor: "start" | "end"; text: string; strong: boolean }[] = [];

    const plotLeft = PAD.left + 2;
    const plotRight = PAD.left + plotWidth - 2;

    for (const candidate of candidates) {
      const cx = mapX(candidate.item.x);
      const cy = mapY(candidate.item.y);
      const text = candidate.key;
      const w = Math.min(210, text.length * 6.7 + 10);
      const h = 14;
      const right = candidate.item.x >= 0;

      const offsets = right
        ? [
            { x: cx + 11, y: cy - 4, anchor: "start" as const },
            { x: cx - 11, y: cy - 4, anchor: "end" as const },
            { x: cx + 11, y: cy - 16, anchor: "start" as const },
            { x: cx - 11, y: cy - 16, anchor: "end" as const },
            { x: cx + 11, y: cy + 10, anchor: "start" as const },
            { x: cx - 11, y: cy + 10, anchor: "end" as const },
          ]
        : [
            { x: cx - 11, y: cy - 4, anchor: "end" as const },
            { x: cx + 11, y: cy - 4, anchor: "start" as const },
            { x: cx - 11, y: cy - 16, anchor: "end" as const },
            { x: cx + 11, y: cy - 16, anchor: "start" as const },
            { x: cx - 11, y: cy + 10, anchor: "end" as const },
            { x: cx + 11, y: cy + 10, anchor: "start" as const },
          ];

      for (const offset of offsets) {
        const left = offset.anchor === "start" ? offset.x : offset.x - w;
        if (left < plotLeft || left + w > plotRight) continue;
        const box: LabelBox = { x: left, y: offset.y - h + 3, w, h };
        if (placed.some((other) => overlaps(box, other))) continue;
        placed.push(box);
        result.push({
          key: candidate.key,
          x: offset.x,
          y: offset.y,
          anchor: offset.anchor,
          text,
          strong: candidate.strong,
        });
        break;
      }
    }
    return result;
  }, [items, showLabels, activeKey, width, height]);

  const clipId = "rrg-plot-clip";

  const xCaption = isIpoMode
    ? "10-Day / LTD excess return vs benchmark"
    : `3-month excess return vs ${benchmark}`;
  const yCaption = isIpoMode
    ? "Turnover intensity vs baseline"
    : "21-day relative-strength momentum";

  const tooltipLeft = activeItem
    ? Math.max(120, Math.min(width - 120, mapX(activeItem.x)))
    : 0;
  const tooltipAbove = activeItem ? mapY(activeItem.y) > 150 : true;

  return (
    <div className="rrg-stage__canvas" ref={containerRef}>
      <svg
        className="rrg-svg"
        width={width}
        height={height}
        role="img"
        aria-label={`Relative rotation graph of ${items.length} themes versus ${benchmark}`}
      >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={PAD.top} width={plotWidth} height={plotHeight} />
            </clipPath>
            {activeItem && focalTrail.length > 1 && (
              <linearGradient
                id="rrg-focal-trail"
                gradientUnits="userSpaceOnUse"
                x1={focalTrail[0].x}
                y1={focalTrail[0].y}
                x2={focalTrail[focalTrail.length - 1].x}
                y2={focalTrail[focalTrail.length - 1].y}
              >
                <stop offset="0%" stopColor={QUADRANT_VAR[activeItem.quadrant]} stopOpacity="0.06" />
                <stop offset="100%" stopColor={QUADRANT_VAR[activeItem.quadrant]} stopOpacity="0.95" />
              </linearGradient>
            )}
            {QUADRANT_ORDER.map((quadrant) => {
              const config = {
                Leading: [originX, originY, originX + halfX, originY - halfY],
                Improving: [originX, originY, originX - halfX, originY - halfY],
                Weakening: [originX, originY, originX + halfX, originY + halfY],
                Lagging: [originX, originY, originX - halfX, originY + halfY],
              }[quadrant];
              return (
                <linearGradient
                  key={quadrant}
                  id={`rrg-quad-${quadrant}`}
                  gradientUnits="userSpaceOnUse"
                  x1={config[0]}
                  y1={config[1]}
                  x2={config[2]}
                  y2={config[3]}
                >
                  <stop offset="0%" stopColor={QUADRANT_VAR[quadrant]} stopOpacity="0.01" />
                  <stop offset="55%" stopColor={QUADRANT_VAR[quadrant]} stopOpacity="0.035" />
                  <stop offset="100%" stopColor={QUADRANT_VAR[quadrant]} stopOpacity="0.085" />
                </linearGradient>
              );
            })}
          </defs>

          {/* quadrant washes */}
          <g clipPath={`url(#${clipId})`}>
            <rect x={PAD.left} y={PAD.top} width={halfX} height={halfY} fill="url(#rrg-quad-Improving)" />
            <rect x={originX} y={PAD.top} width={halfX} height={halfY} fill="url(#rrg-quad-Leading)" />
            <rect x={PAD.left} y={originY} width={halfX} height={halfY} fill="url(#rrg-quad-Lagging)" />
            <rect x={originX} y={originY} width={halfX} height={halfY} fill="url(#rrg-quad-Weakening)" />
          </g>

          {/* grid */}
          <g>
            {GRID_RATIOS.map((ratio) => (
              <g key={ratio}>
                <line
                  className="rrg-grid"
                  x1={originX + ratio * halfX}
                  x2={originX + ratio * halfX}
                  y1={PAD.top}
                  y2={PAD.top + plotHeight}
                />
                <line
                  className="rrg-grid"
                  x2={originX + ratio * halfX}
                  y1={originY - ratio * halfY}
                  y2={originY - ratio * halfY}
                  x1={PAD.left}
                />
              </g>
            ))}
            <line
              className="rrg-axis"
              x1={originX}
              x2={originX}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
            />
            <line
              className="rrg-axis"
              x2={originX}
              y1={originY}
              y2={originY}
              x1={PAD.left}
            />
          </g>

          {/* ticks */}
          <g className="rrg-ticks">
            {GRID_RATIOS.map((ratio) => (
              <g key={ratio}>
                <text x={originX + ratio * halfX} y={PAD.top + plotHeight + 16} textAnchor="middle">
                  {fmtSigned(ratio * limits.x, "%", 0)}
                </text>
                <text x={PAD.left - 10} y={originY - ratio * halfY + 3.5} textAnchor="end">
                  {fmtSigned(ratio * limits.y, isIpoMode ? "%" : "", 0)}
                </text>
              </g>
            ))}
            <text x={originX} y={PAD.top + plotHeight + 16} textAnchor="middle" className="rrg-tick--zero">
              0
            </text>
            <text x={PAD.left - 10} y={originY + 3.5} textAnchor="end" className="rrg-tick--zero">
              0
            </text>
          </g>

          {/* quadrant corner captions */}
          <g className="rrg-quad-label">
            <text x={PAD.left + 12} y={PAD.top + 20} fill={QUADRANT_VAR.Improving}>
              Improving
            </text>
            <text x={PAD.left + plotWidth - 12} y={PAD.top + 20} textAnchor="end" fill={QUADRANT_VAR.Leading}>
              Leading
            </text>
            <text x={PAD.left + 12} y={PAD.top + plotHeight - 12} fill={QUADRANT_VAR.Lagging}>
              Lagging
            </text>
            <text x={PAD.left + plotWidth - 12} y={PAD.top + plotHeight - 12} textAnchor="end" fill={QUADRANT_VAR.Weakening}>
              Weakening
            </text>
          </g>

          {/* trails */}
          <g clipPath={`url(#${clipId})`}>
            {nonFocalTrails.map((trail) => (
              <path
                key={`trail-${trail.key}`}
                d={trail.d}
                className="rrg-trail"
                stroke={trail.color}
              />
            ))}
            {focalPaths.map((d, index) => (
              <path
                key={`focal-trail-${index}`}
                d={d}
                className="rrg-trail rrg-trail--focal"
                stroke="url(#rrg-focal-trail)"
              />
            ))}
          </g>

          {/* crosshair */}
          {activeItem && (
            <g className="rrg-crosshair">
              <line
                x1={mapX(activeItem.x)}
                x2={mapX(activeItem.x)}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
              />
              <line
                x1={PAD.left}
                x2={PAD.left + plotWidth}
                y1={mapY(activeItem.y)}
                y2={mapY(activeItem.y)}
              />
            </g>
          )}

          {/* nodes */}
          <g>
            {items.map((item) => {
              const key = itemKey(item);
              const isFocal = key === activeKey;
              const cx = mapX(item.x);
              const cy = mapY(item.y);
              const color = QUADRANT_VAR[item.quadrant];
              const radius = isIpoItem(item)
                ? 3.25
                : Math.max(2.8, Math.min(5.25, 2.3 + Math.sqrt(item.metrics.constituentCount) * 0.15));

              return (
                <g
                  key={`node-${key}`}
                  className={`rrg-node ${isFocal ? "is-focal" : ""}`}
                  onMouseEnter={() => setHoveredKey(key)}
                  onClick={() => onSelect(item)}
                >
                  {isFocal && (
                    <circle className="rrg-node__halo" cx={cx} cy={cy} r={radius + 7} fill={color} />
                  )}
                  <circle className="rrg-node__ring" cx={cx} cy={cy} r={radius + 1.7} stroke={color} />
                  <circle className="rrg-node__core" cx={cx} cy={cy} r={radius} fill={color} />
                  <circle className="rrg-node__hit" cx={cx} cy={cy} r={radius + 10} />
                </g>
              );
            })}
          </g>

          {/* labels */}
          <g className="rrg-labels">
            {labels.map((label) => (
              <text
                key={`label-${label.key}`}
                x={label.x}
                y={label.y}
                textAnchor={label.anchor}
                className={label.strong ? "rrg-label is-strong" : "rrg-label"}
              >
                {label.text}
              </text>
            ))}
          </g>

          {/* axis captions */}
          <text className="rrg-caption" x={originX} y={height - 10} textAnchor="middle">
            {xCaption} →
          </text>
          <text
            className="rrg-caption"
            transform={`translate(14, ${originY}) rotate(-90)`}
            textAnchor="middle"
          >
            {yCaption} →
          </text>
        </svg>

      {activeItem && (
        <div
          className={`rrg-tip ${tooltipAbove ? "is-above" : "is-below"}`}
          style={{ left: tooltipLeft, top: mapY(activeItem.y) }}
        >
          <div className="rrg-tip__head">
            <span className="rrg-tip__title">{itemKey(activeItem)}</span>
            <span
              className="rrg-tip__quad"
              style={{ color: QUADRANT_VAR[activeItem.quadrant] }}
            >
              {activeItem.quadrant}
            </span>
          </div>
          <div className="rrg-tip__rows">
            <span>{isIpoItem(activeItem) ? "10D / LTD excess" : "3M excess return"}</span>
            <b className={activeItem.x >= 0 ? "rrg-tone-up" : "rrg-tone-down"}>
              {fmtSigned(activeItem.x)}
            </b>
            <span>{isIpoItem(activeItem) ? "Turnover intensity" : "21D RS momentum"}</span>
            <b className={activeItem.y >= 0 ? "rrg-tone-up" : "rrg-tone-down"}>
              {fmtSigned(activeItem.y, isIpoItem(activeItem) ? "%" : " pts")}
            </b>
            {!isIpoItem(activeItem) && (
              <>
                <span>Breadth vs benchmark</span>
                <b>{fmtNum(activeItem.metrics.beatingBenchmarkPct)}%</b>
                <span>Constituents</span>
                <b>{activeItem.metrics.constituentCount}</b>
              </>
            )}
            {isIpoItem(activeItem) && (
              <>
                <span>Gain since listing</span>
                <b className={activeItem.gainSinceListingPct >= 0 ? "rrg-tone-up" : "rrg-tone-down"}>
                  {fmtSigned(activeItem.gainSinceListingPct)}
                </b>
                <span>Daily turnover</span>
                <b>₹{fmtNum(activeItem.turnoverCr)} Cr</b>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
