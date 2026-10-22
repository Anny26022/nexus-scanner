import type {
  RrgBlockItem,
  RrgIpoItem,
  RrgNicheItem,
  RrgThematicIndexItem,
  RrgQuadrant,
  RrgTrailPoint,
} from "../../types/thematicRrg";

export type RrgItem = RrgBlockItem | RrgNicheItem | RrgThematicIndexItem | RrgIpoItem;
export type RrgMode = "blocks" | "niches" | "indices" | "ipos";

export const QUADRANT_ORDER: RrgQuadrant[] = [
  "Leading",
  "Improving",
  "Weakening",
  "Lagging",
];

/** CSS custom property per quadrant so the SVG inherits the active theme. */
export const QUADRANT_VAR: Record<RrgQuadrant, string> = {
  Leading: "var(--rrg-leading)",
  Improving: "var(--rrg-improving)",
  Weakening: "var(--rrg-weakening)",
  Lagging: "var(--rrg-lagging)",
};

export const QUADRANT_BLURB: Record<RrgQuadrant, string> = {
  Leading: "Outperforming the benchmark with improving relative strength",
  Improving: "Gaining relative strength from an underperforming base",
  Weakening: "Still ahead of the benchmark, but momentum is fading",
  Lagging: "Underperforming the benchmark and still deteriorating",
};

export const isIpoItem = (item: RrgItem): item is RrgIpoItem => "symbol" in item;
export const isThematicIndexItem = (item: RrgItem): item is RrgThematicIndexItem => "indexSymbol" in item;
export const isBlockItem = (item: RrgItem): item is RrgBlockItem =>
  !isThematicIndexItem(item) && "nicheCount" in item;

export const itemKey = (item: RrgItem): string =>
  isIpoItem(item) ? item.symbol : item.name;

export const itemSubtitle = (item: RrgItem): string => {
  if (isIpoItem(item)) return item.theme ?? item.block ?? "Tactical IPO";
  if (isThematicIndexItem(item)) return "Official NSE index";
  return item.parentBlock ?? item.macro ?? "Macro pillar";
};

export interface RrgBounds {
  x: number;
  y: number;
}

/** Rounds a raw limit up to a readable axis maximum. */
const niceLimit = (value: number) => {
  const ladder = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const exponent = Math.floor(Math.log10(Math.max(value, 1)));
  const base = Math.pow(10, exponent);
  const scaled = value / base;
  const step = ladder.find((candidate) => candidate >= scaled) ?? 10;
  return step * base;
};

/**
 * Axis limits derived from the universe itself so IPOs with very different
 * scales still fill the plot without clamping to the frame.
 */
export const computeBounds = (scope: RrgItem[], isIpo: boolean): RrgBounds => {
  const xs: number[] = [];
  const ys: number[] = [];
  scope.forEach((item) => {
    xs.push(Math.abs(item.x));
    ys.push(Math.abs(item.y));
    if (!isIpo) {
      item.trail.forEach((point) => {
        xs.push(Math.abs(point.x));
        ys.push(Math.abs(point.y));
      });
    }
  });
  const percentile = (values: number[], quantile: number) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
  };
  const quantile = isIpo ? 0.9 : 0.95;
  return {
    x: Math.max(isIpo ? 10 : 5, niceLimit(percentile(xs, quantile) * 1.12)),
    y: Math.max(isIpo ? 10 : 4, niceLimit(percentile(ys, quantile) * 1.12)),
  };
};

export const fmtSigned = (
  value: number | null | undefined,
  suffix = "%",
  digits = 1,
): string => {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
};

export const fmtNum = (
  value: number | null | undefined,
  digits = 1,
): string => {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

export const fmtCompact = (value: number | null | undefined): string => {
  if (value == null || Number.isNaN(value)) return "—";
  if (value >= 100000) return `${(value / 100000).toFixed(1)}L Cr`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K Cr`;
  return `${value.toFixed(0)} Cr`;
};

export const toneClass = (value: number | null | undefined): string => {
  if (value == null || Number.isNaN(value) || value === 0) return "";
  return value > 0 ? "rrg-tone-up" : "rrg-tone-down";
};

/**
 * Trails are stored oldest -> newest with a descending `week` index, so the
 * newest point always carries week 0 and mirrors the item's live x/y.
 */
export const trailFor = (
  item: RrgItem,
  weeks: number,
  isIpo: boolean,
  replayWeek = 0,
): RrgTrailPoint[] => {
  const points = isIpo
    ? item.trail
    : item.trail.filter((point) => point.week <= weeks && point.week >= replayWeek);
  if (points.length < 2) return [];
  const trimmed = points.slice();
  const last = trimmed[trimmed.length - 1];
  if (replayWeek === 0) {
    trimmed[trimmed.length - 1] = {
      ...last,
      x: item.x,
      y: item.y,
      quadrant: item.quadrant,
    };
  }
  return trimmed;
};
