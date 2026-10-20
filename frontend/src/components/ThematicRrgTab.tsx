import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Compass,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { screenerApi } from "../api/screenerApi";
import type {
  RrgBlockItem,
  RrgNicheItem,
  RrgIpoItem,
  RrgQuadrant,
  RrgConstituentStock,
} from "../types/thematicRrg";

type Cluster = RrgBlockItem | RrgNicheItem;
type Item = Cluster | RrgIpoItem;
type Mode = "blocks" | "niches" | "ipos";
const quadrants: RrgQuadrant[] = [
  "Leading",
  "Improving",
  "Weakening",
  "Lagging",
];
const colors: Record<RrgQuadrant, string> = {
  Leading: "#21886b",
  Improving: "#5484d6",
  Weakening: "#bc8b2d",
  Lagging: "#cf6175",
};
const isBlock = (item: Item): item is RrgBlockItem => "nicheCount" in item;
const isIpo = (item: Item): item is RrgIpoItem => "symbol" in item;
const keyOf = (item: Item) => (isIpo(item) ? item.symbol : item.name);
const signed = (value: number | null, suffix = "%", digits = 1) =>
  value == null
    ? "—"
    : `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
const number = (value: number) =>
  value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
const tone = (value: number | null) =>
  value == null || value === 0
    ? ""
    : value > 0
      ? "rrg-positive"
      : "rrg-negative";
const setupNames: Record<keyof RrgConstituentStock["setups"], string> = {
  stage2: "Stage 2",
  vcp: "VCP",
  darvas: "Darvas",
  bullFlag: "Bull flag",
  cupHandle: "Cup & handle",
  pocketPivot: "Pocket pivot",
  coiled: "Coiled",
  tightWeeks: "Tight weeks",
};
const clusterColumns = [
  ["name", "Theme"],
  ["quadrant", "Rotation"],
  ["excessReturn3m", "3M excess"],
  ["rsMomentum21d", "RS change"],
  ["medianRs", "Median RS"],
  ["beatingBenchmarkPct", "Breadth"],
  ["constituentCount", "Stocks"],
] as const;
const ipoColumns = [
  ["symbol", "Company"],
  ["quadrant", "Rotation"],
  ["excessReturn10d", "10D / LTD excess"],
  ["turnoverIntensity", "Turnover intensity"],
  ["close", "Price"],
  ["listingDate", "Listed"],
  ["gainSinceListingPct", "Listing gain"],
] as const;
const extraClusterSort = [
  ["improvingRsPct", "Improving RS"],
  ["setupCoveragePct", "Setup coverage"],
  ["totalTurnover20Cr", "20D turnover"],
] as const;
const extraIpoSort = [
  ["turnoverCr", "Daily turnover"],
  ["deliveryPct", "Delivery"],
  ["marketCapCr", "Market cap"],
] as const;
function valueOf(item: Item, field: string): number | string | null {
  if (isIpo(item))
    return (
      (item as unknown as Record<string, number | string | null>)[field] ?? null
    );
  if (field === "name" || field === "quadrant") return item[field];
  return (item.metrics as unknown as Record<string, number>)[field] ?? null;
}
function compare(
  a: number | string | null,
  b: number | string | null,
  desc: boolean,
) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return (
    (typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b)
      : Number(a) - Number(b)) * (desc ? -1 : 1)
  );
}
function Badge({ quadrant }: { quadrant: RrgQuadrant }) {
  return (
    <span className="rrg-badge" style={{ color: colors[quadrant] }}>
      <i style={{ background: colors[quadrant] }} />
      {quadrant}
    </span>
  );
}
function Metric({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: number | null;
}) {
  return (
    <div className="rrg-metric">
      <dt>{label}</dt>
      <dd className={tone(positive ?? null)}>{value}</dd>
    </div>
  );
}

function RotationChart({
  items,
  scope,
  selected,
  onSelect,
  weeks,
  ipo,
  labels,
}: {
  items: Item[];
  scope: Item[];
  selected: Item | null;
  onSelect: (item: Item) => void;
  weeks: number;
  ipo: boolean;
  labels: boolean;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const geometry = useMemo(() => {
    let maxX = 5,
      maxY = 3;
    scope.forEach((item) => {
      [
        { x: item.x, y: item.y },
        ...item.trail.filter((p) => ipo || p.week <= weeks),
      ].forEach((p) => {
        maxX = Math.max(maxX, Math.abs(p.x));
        maxY = Math.max(maxY, Math.abs(p.y));
      });
    });
    return { x: Math.ceil(maxX * 1.15), y: Math.ceil(maxY * 1.15) };
  }, [scope, weeks, ipo]);
  const px = (x: number) => 454 + (x / geometry.x) * 382;
  const py = (y: number) => 258 - (y / geometry.y) * 208;
  const focusKey = hovered ?? (selected ? keyOf(selected) : null);
  return (
    <svg
      className="rrg-plot"
      viewBox="0 0 900 550"
      role="group"
      aria-label={
        ipo
          ? "IPO relative return and turnover rotation chart"
          : "Theme relative return and RS momentum rotation chart"
      }
      onMouseLeave={() => setHovered(null)}
    >
      <defs>
        <clipPath id="rrg-plot-clip">
          <rect x="70" y="48" width="768" height="420" />
        </clipPath>
      </defs>
      {(
        [
          { q: "Improving", x: 70, y: 48 },
          { q: "Leading", x: 454, y: 48 },
          { q: "Lagging", x: 70, y: 258 },
          { q: "Weakening", x: 454, y: 258 },
        ] as const
      ).map(({ q, x, y }) => (
        <g key={q}>
          <rect
            x={x}
            y={y}
            width="384"
            height="210"
            fill={colors[q]}
            opacity=".035"
          />
          <text
            x={q === "Leading" || q === "Weakening" ? 820 : 88}
            y={y === 48 ? 74 : 449}
            textAnchor={x === 454 ? "end" : "start"}
            fill={colors[q]}
            className="rrg-quadrant-name"
          >
            {q}
          </text>
        </g>
      ))}
      {[-1, -0.5, 0, 0.5, 1].map((n) => (
        <g key={n}>
          <line
            x1={px(n * geometry.x)}
            x2={px(n * geometry.x)}
            y1="48"
            y2="468"
            className={n === 0 ? "rrg-origin" : "rrg-grid"}
          />
          <line
            y1={py(n * geometry.y)}
            y2={py(n * geometry.y)}
            x1="70"
            x2="838"
            className={n === 0 ? "rrg-origin" : "rrg-grid"}
          />
          <text
            x={px(n * geometry.x)}
            y="491"
            textAnchor="middle"
            className="rrg-tick"
          >
            {signed(n * geometry.x, "%", 0)}
          </text>
          <text
            x="57"
            y={py(n * geometry.y) + 4}
            textAnchor="end"
            className="rrg-tick"
          >
            {signed(n * geometry.y, ipo ? "%" : "", 0)}
          </text>
        </g>
      ))}
      <text x="454" y="528" textAnchor="middle" className="rrg-axis-title">
        {ipo
          ? "10-day / listing-to-date excess return"
          : "3-month median excess return"}{" "}
        →
      </text>
      <text
        transform="translate(19 258) rotate(-90)"
        textAnchor="middle"
        className="rrg-axis-title"
      >
        {ipo
          ? "Turnover intensity vs baseline (%)"
          : "21-day RS rating change (points)"}{" "}
        →
      </text>
      <g clipPath="url(#rrg-plot-clip)">
        {items.map((item) => {
          const active = keyOf(item) === focusKey;
          const trail = [...item.trail]
            .filter((p) => ipo || p.week <= weeks)
            .sort((a, b) => b.week - a.week);
          return (
            <polyline
              key={keyOf(item)}
              points={trail.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")}
              fill="none"
              stroke={colors[item.quadrant]}
              strokeWidth={active ? 2.3 : 1.2}
              opacity={active ? 0.85 : focusKey ? 0.08 : 0.2}
            />
          );
        })}
        {items.map((item) => {
          const active = keyOf(item) === focusKey;
          const radius = isIpo(item)
            ? 5
            : Math.min(9, 4 + Math.sqrt(item.metrics.constituentCount) * 0.35);
          return (
            <g
              key={keyOf(item)}
              role="button"
              tabIndex={0}
              aria-label={`Inspect ${keyOf(item)}, ${item.quadrant}`}
              className="rrg-node"
              onMouseEnter={() => setHovered(keyOf(item))}
              onFocus={() => setHovered(keyOf(item))}
              onBlur={() => setHovered(null)}
              onClick={() => onSelect(item)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(item);
                }
              }}
            >
              <title>
                {keyOf(item)} · {item.quadrant} · {signed(item.x)} excess ·{" "}
                {signed(item.y, ipo ? "%" : " pts")} momentum
              </title>
              {active && (
                <circle
                  cx={px(item.x)}
                  cy={py(item.y)}
                  r={radius + 5}
                  fill={colors[item.quadrant]}
                  opacity=".15"
                />
              )}
              <circle
                cx={px(item.x)}
                cy={py(item.y)}
                r={radius + 5}
                fill="transparent"
              />
              <circle
                cx={px(item.x)}
                cy={py(item.y)}
                r={radius}
                fill={colors[item.quadrant]}
                className="rrg-node-core"
                opacity={focusKey && !active ? 0.5 : 0.95}
              />
            </g>
          );
        })}
      </g>
      {items
        .filter((item) => keyOf(item) === focusKey || (labels && !focusKey))
        .map((item) => (
          <text
            key={keyOf(item)}
            x={px(item.x) + (item.x > geometry.x * 0.6 ? -13 : 13)}
            y={py(item.y) - 11}
            textAnchor={item.x > geometry.x * 0.6 ? "end" : "start"}
            className="rrg-node-caption"
          >
            {keyOf(item)}
          </text>
        ))}
    </svg>
  );
}

export function ThematicRrgTab({
  datasetRevision,
}: {
  datasetRevision?: string;
}) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["thematicRrg", datasetRevision],
    queryFn: () => screenerApi.getThematicRrg(datasetRevision),
    staleTime: 5 * 60 * 1000,
  });
  const [mode, setMode] = useState<Mode>("blocks");
  const [block, setBlock] = useState<string | null>(null);
  const [quadrant, setQuadrant] = useState<RrgQuadrant | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [weeks, setWeeks] = useState(12);
  const [labels, setLabels] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [sort, setSort] = useState("excessReturn3m");
  const [desc, setDesc] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [stockSort, setStockSort] = useState("excessReturn3m");
  const [stockDesc, setStockDesc] = useState(true);
  const scope = useMemo<Item[]>(
    () =>
      !data
        ? []
        : mode === "ipos"
          ? (data.ipoTactical ?? [])
          : block
            ? data.niches.filter((item) => item.parentBlock === block)
            : data[mode],
    [data, mode, block],
  );
  const items = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scope
      .filter(
        (item) =>
          (quadrant === "ALL" || item.quadrant === quadrant) &&
          (!query ||
            (isIpo(item)
              ? [item.symbol, item.name, item.theme, item.block]
              : [
                  item.name,
                  item.macro,
                  ...item.constituents.flatMap((s) => [s.symbol, s.name]),
                ]
            ).some((v) => v?.toLowerCase().includes(query))),
      )
      .sort((a, b) => compare(valueOf(a, sort), valueOf(b, sort), desc));
  }, [scope, quadrant, search, sort, desc]);
  const selected = items.find((item) => keyOf(item) === selection) ?? null;
  const stocks = useMemo(
    () =>
      selected && !isIpo(selected)
        ? [...selected.constituents].sort((a, b) =>
            compare(
              a[stockSort as keyof RrgConstituentStock] as
                number | string | null,
              b[stockSort as keyof RrgConstituentStock] as
                number | string | null,
              stockDesc,
            ),
          )
        : [],
    [selected, stockSort, stockDesc],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        quadrants.map((q) => [
          q,
          scope.filter((item) => item.quadrant === q).length,
        ]),
      ),
    [scope],
  );
  const changeMode = (next: Mode) => {
    setMode(next);
    setBlock(null);
    setSelection(null);
    setQuadrant("ALL");
    setSearch("");
    setSort(next === "ipos" ? "excessReturn10d" : "excessReturn3m");
    setDesc(true);
    setDialog(false);
  };
  const drill = (name: string | null) => {
    setBlock(name);
    setSelection(null);
    setSearch("");
    setQuadrant("ALL");
  };
  const sortBy = (field: string) => {
    setSort(field);
    setDesc(sort === field ? !desc : true);
  };
  const columns = mode === "ipos" ? ipoColumns : clusterColumns;
  if (isLoading)
    return (
      <div className="rrg-workspace rrg-loading" role="status">
        <div className="rrg-skeleton rrg-skeleton-title" />
        <div className="rrg-skeleton rrg-skeleton-chart" />
        <span>Loading market rotation…</span>
      </div>
    );
  if (isError || !data)
    return (
      <div className="rrg-workspace rrg-error">
        <Compass size={32} />
        <h2>Rotation data is unavailable</h2>
        <p>
          {error instanceof Error
            ? error.message
            : "Please try loading the dataset again."}
        </p>
        <button className="rrg-primary" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  const date = new Date(`${data.asOfDate}T00:00:00`).toLocaleDateString(
    "en-IN",
    { day: "numeric", month: "short", year: "numeric" },
  );
  return (
    <div className="rrg-workspace">
      <header className="rrg-page-header">
        <div>
          <div className="rrg-eyebrow">
            <Compass size={14} /> MARKET ROTATION
          </div>
          <h1>
            Thematic RRG<span className="rrg-title-dot">.</span>
          </h1>
          <p>Follow strength. Find what’s moving next.</p>
        </div>
        <div className="rrg-dataset">
          <span className="rrg-date-dot" />
          As of {date}
          <span>Relative to {data.benchmark}</span>
        </div>
      </header>
      <div className="rrg-navigation">
        <div className="rrg-segments" aria-label="Rotation universe">
          {(["blocks", "niches", "ipos"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              onClick={() => changeMode(m)}
            >
              {m === "blocks"
                ? "Thematic blocks"
                : m === "niches"
                  ? "All niches"
                  : "Tactical IPOs"}
              <span>
                {m === "blocks"
                  ? data.totalBlocks
                  : m === "niches"
                    ? data.totalNiches
                    : (data.ipoTactical ?? []).length}
              </span>
            </button>
          ))}
        </div>
        <span className="rrg-universe-note">
          {mode === "ipos"
            ? "5–64 trading sessions · daily trails"
            : `${number(data.totalEquities)} equities · weekly trails`}
        </span>
      </div>
      <div className="rrg-workbench">
        <section className="rrg-chart-panel" aria-label="Rotation map">
          <div className="rrg-panel-heading">
            <div>
              {block ? (
                <button className="rrg-back" onClick={() => drill(null)}>
                  <ChevronLeft size={14} />
                  All blocks
                </button>
              ) : (
                <span className="rrg-eyebrow">ROTATION MAP</span>
              )}
              <h2>
                {block ??
                  (mode === "blocks"
                    ? "The bigger picture"
                    : mode === "niches"
                      ? "Inside the themes"
                      : "The next generation")}
              </h2>
            </div>
            <div className="rrg-chart-options">
              <label className="rrg-label-toggle">
                <input
                  type="checkbox"
                  checked={labels}
                  onChange={(e) => setLabels(e.target.checked)}
                />
                Labels
              </label>
              {mode !== "ipos" && (
                <div className="rrg-trail-control" aria-label="Trail length">
                  {[4, 8, 12].map((w) => (
                    <button
                      key={w}
                      aria-pressed={weeks === w}
                      onClick={() => setWeeks(w)}
                    >
                      {w}W
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="rrg-quadrant-filters" aria-label="Filter by rotation">
            <button
              aria-pressed={quadrant === "ALL"}
              onClick={() => setQuadrant("ALL")}
            >
              All<span>{scope.length}</span>
            </button>
            {quadrants.map((q) => (
              <button
                key={q}
                aria-pressed={quadrant === q}
                onClick={() => setQuadrant(quadrant === q ? "ALL" : q)}
              >
                <i style={{ background: colors[q] }} />
                {q}
                <span>{counts[q]}</span>
              </button>
            ))}
          </div>
          <RotationChart
            items={items}
            scope={scope}
            selected={selected}
            onSelect={(item) => setSelection(keyOf(item))}
            weeks={weeks}
            ipo={mode === "ipos"}
            labels={labels}
          />
          <div className="rrg-chart-foot">
            <span>
              <span className="rrg-trail-sample" />
              {mode === "ipos" ? "Daily" : `${weeks}-week`} history
            </span>
            <span>
              {items.length} of {scope.length} visible · Select a dot to explore
            </span>
          </div>
        </section>
        <aside
          className="rrg-inspector"
          aria-label="Rotation details"
          
        >
          {selected ? (
            <>
              <div className="rrg-inspector-top">
                <span className="rrg-eyebrow">
                  {isIpo(selected) ? "IPO SPOTLIGHT" : "THEME SPOTLIGHT"}
                </span>
                <button
                  className="rrg-icon-button"
                  aria-label="Clear selection"
                  onClick={() => setSelection(null)}
                >
                  <X size={16} />
                </button>
              </div>
              <Badge quadrant={selected.quadrant} />
              <h2>{keyOf(selected)}</h2>
              <p className="rrg-inspector-subtitle">
                {isIpo(selected)
                  ? selected.name
                  : (selected.parentBlock ??
                    selected.macro ??
                    "Thematic block")}
              </p>
              <dl className="rrg-hero-metrics">
                <Metric
                  label={
                    isIpo(selected) ? "10D / LTD excess" : "3M excess return"
                  }
                  value={signed(selected.x)}
                  positive={selected.x}
                />
                <Metric
                  label={
                    isIpo(selected) ? "Turnover intensity" : "21D RS change"
                  }
                  value={signed(selected.y, isIpo(selected) ? "%" : " pts")}
                  positive={selected.y}
                />
              </dl>
              {isIpo(selected) ? (
                <dl className="rrg-detail-list">
                  <Metric label="Price" value={`₹${number(selected.close)}`} />
                  <Metric
                    label="Daily change"
                    value={signed(selected.changePct)}
                    positive={selected.changePct}
                  />
                  <Metric
                    label="Since listing"
                    value={signed(selected.gainSinceListingPct)}
                    positive={selected.gainSinceListingPct}
                  />
                  <Metric label="Listed" value={selected.listingDate} />
                  <Metric
                    label="Trading sessions"
                    value={number(selected.sessions)}
                  />
                  <Metric
                    label="Listing age"
                    value={`${selected.listingAgeDays} days`}
                  />
                  <Metric
                    label="Daily turnover"
                    value={`₹${number(selected.turnoverCr)} Cr`}
                  />
                  <Metric
                    label="Delivery"
                    value={
                      selected.deliveryPct == null
                        ? "—"
                        : `${number(selected.deliveryPct)}%`
                    }
                  />
                  <Metric
                    label="Market cap"
                    value={`₹${number(selected.marketCapCr)} Cr`}
                  />
                  <Metric label="Theme" value={selected.theme ?? "—"} />
                  <Metric label="Block" value={selected.block ?? "—"} />
                </dl>
              ) : (
                <>
                  <div className="rrg-breadth">
                    <div>
                      <span>Beating benchmark</span>
                      <strong>
                        {number(selected.metrics.beatingBenchmarkPct)}%
                      </strong>
                    </div>
                    <meter
                      min="0"
                      max="100"
                      value={selected.metrics.beatingBenchmarkPct}
                      aria-label="Stocks beating benchmark"
                    />
                  </div>
                  <dl className="rrg-detail-list">
                    <Metric
                      label="Median RS"
                      value={number(selected.metrics.medianRs)}
                    />
                    <Metric
                      label="Improving RS"
                      value={`${number(selected.metrics.improvingRsPct)}%`}
                    />
                    <Metric
                      label="Setup coverage"
                      value={`${number(selected.metrics.setupCoveragePct)}%`}
                    />
                    <Metric
                      label="1M / 6M excess"
                      value={`${signed(selected.metrics.excessReturn1m)} / ${signed(selected.metrics.excessReturn6m)}`}
                    />
                    <Metric
                      label="20D turnover"
                      value={`₹${number(selected.metrics.totalTurnover20Cr)} Cr`}
                    />
                    <Metric
                      label="Top 3 concentration"
                      value={`${number(selected.metrics.concentrationTop3Pct)}%`}
                    />
                  </dl>
                  <div className="rrg-contributors">
                    <span className="rrg-eyebrow">TOP CONTRIBUTORS</span>
                    <p>
                      {selected.metrics.topContributors.join(" · ") ||
                        "No contributors available"}
                    </p>
                  </div>
                  <button
                    className="rrg-primary"
                    onClick={() => setDialog(true)}
                  >
                    Explore {selected.metrics.constituentCount} stocks
                    <ArrowUpRight size={15} />
                  </button>
                  {isBlock(selected) && (
                    <button
                      className="rrg-secondary-button"
                      onClick={() => drill(selected.name)}
                    >
                      View {selected.nicheCount} niches
                      <ChevronRight size={15} />
                    </button>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <span className="rrg-eyebrow">MARKET PULSE</span>
              <h2>
                Where strength
                <br />
                is shifting.
              </h2>
              <p className="rrg-inspector-subtitle">
                Explore the map to trace rotation across{" "}
                {block
                  ? "this block’s niches"
                  : mode === "ipos"
                    ? "recent listings"
                    : "the market"}
                .
              </p>
              <div className="rrg-pulse">
                {quadrants.map((q) => (
                  <button
                    key={q}
                    onClick={() => setQuadrant(quadrant === q ? "ALL" : q)}
                    aria-pressed={quadrant === q}
                  >
                    <Badge quadrant={q} />
                    <strong>{counts[q]}</strong>
                    <span className="rrg-pulse-track">
                      <i
                        style={{
                          width: `${scope.length ? (counts[q] / scope.length) * 100 : 0}%`,
                          background: colors[q],
                        }}
                      />
                    </span>
                  </button>
                ))}
              </div>
              <div className="rrg-map-guide">
                <SlidersHorizontal size={17} />
                <h3>Read the rotation</h3>
                <p>
                  Right means outperforming {data.benchmark}. Up means{" "}
                  {mode === "ipos"
                    ? "rising turnover intensity"
                    : "strengthening relative strength"}
                  .
                </p>
                <p>Select a theme in the map or rankings to see its story.</p>
              </div>
            </>
          )}
        </aside>
      </div>
      <section className="rrg-rankings">
        <div className="rrg-ranking-heading">
          <div>
            <span className="rrg-eyebrow">THE DETAILS</span>
            <h2>
              {block
                ? "Niche rankings"
                : mode === "blocks"
                  ? "Block rankings"
                  : mode === "niches"
                    ? "Niche rankings"
                    : "IPO rankings"}
              <span>{items.length}</span>
            </h2>
          </div>
          <div className="rrg-table-controls">
            <label className="rrg-search">
              <Search size={15} />
              <input
                aria-label="Search rotation universe"
                placeholder={
                  mode === "ipos"
                    ? "Search company or theme…"
                    : "Search theme or stock…"
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button aria-label="Clear search" onClick={() => setSearch("")}>
                  <X size={14} />
                </button>
              )}
            </label>
            <label className="rrg-sort-select">
              <SlidersHorizontal size={14} />
              <select
                aria-label="Sort rankings"
                value={sort}
                onChange={(e) => sortBy(e.target.value)}
              >
                {[
                  ...columns,
                  ...(mode === "ipos" ? extraIpoSort : extraClusterSort),
                ].map(([field, label]) => (
                  <option key={field} value={field}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="rrg-icon-button"
              aria-label={desc ? "Sort ascending" : "Sort descending"}
              onClick={() => setDesc(!desc)}
            >
              {desc ? <ArrowDown size={16} /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
        {items.length === 0 ? (
          <div className="rrg-empty">
            <Search size={25} />
            <h3>No matches in this view</h3>
            <p>Try another theme, stock, or rotation filter.</p>
            <button
              className="rrg-secondary-button"
              onClick={() => {
                setSearch("");
                setQuadrant("ALL");
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="rrg-table-scroll">
            <table className="rrg-ranking-table">
              <thead>
                <tr>
                  <th className="rrg-row-number">#</th>
                  {columns.map(([field, label]) => (
                    <th
                      key={field}
                      aria-sort={
                        sort === field
                          ? desc
                            ? "descending"
                            : "ascending"
                          : "none"
                      }
                    >
                      <button onClick={() => sortBy(field)}>
                        {label}
                        {sort === field &&
                          (desc ? (
                            <ArrowDown size={12} />
                          ) : (
                            <ArrowUp size={12} />
                          ))}
                      </button>
                    </th>
                  ))}
                  <th>
                    <span className="rrg-sr-only">Explore</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr
                    key={keyOf(item)}
                    data-selected={selected === item}
                    onClick={() => setSelection(keyOf(item))}
                  >
                    <td className="rrg-row-number">
                      {String(index + 1).padStart(2, "0")}
                    </td>
                    <td>
                      <button
                        className="rrg-row-name"
                        onClick={() => setSelection(keyOf(item))}
                      >
                        {keyOf(item)}
                      </button>
                      <small>
                        {isIpo(item)
                          ? item.name
                          : `${item.metrics.constituentCount} stocks${isBlock(item) ? ` · ${item.nicheCount} niches` : item.parentBlock ? ` · ${item.parentBlock}` : ""}`}
                      </small>
                    </td>
                    <td>
                      <Badge quadrant={item.quadrant} />
                    </td>
                    <td className={tone(item.x)}>{signed(item.x)}</td>
                    <td className={tone(item.y)}>
                      {signed(item.y, isIpo(item) ? "%" : " pts")}
                    </td>
                    {isIpo(item) ? (
                      <>
                        <td>₹{number(item.close)}</td>
                        <td>{item.listingDate}</td>
                        <td className={tone(item.gainSinceListingPct)}>
                          {signed(item.gainSinceListingPct)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{number(item.metrics.medianRs)}</td>
                        <td>{number(item.metrics.beatingBenchmarkPct)}%</td>
                        <td>{item.metrics.constituentCount}</td>
                      </>
                    )}
                    <td>
                      {!isIpo(item) && isBlock(item) ? (
                        <button
                          className="rrg-table-action"
                          aria-label={`View niches in ${item.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            drill(item.name);
                          }}
                        >
                          Niches
                          <ChevronRight size={14} />
                        </button>
                      ) : (
                        <button
                          className="rrg-table-action"
                          aria-label={`Inspect ${keyOf(item)}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelection(keyOf(item));
                          }}
                        >
                          Inspect
                          <ArrowUpRight size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <footer className="rrg-page-foot">
        {data.benchmark} benchmark<span>Snapshot · {date}</span>
      </footer>
      <Dialog.Root
        open={dialog && !!selected && !isIpo(selected)}
        onOpenChange={setDialog}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="rrg-dialog-overlay" />
          <Dialog.Content className="rrg-dialog">
            <header>
              <div>
                <span className="rrg-eyebrow">CONSTITUENTS</span>
                <Dialog.Title>{selected?.name}</Dialog.Title>
                <Dialog.Description>
                  {stocks.length} stocks · Price, relative strength, and active
                  setups
                </Dialog.Description>
              </div>
              <Dialog.Close
                className="rrg-icon-button"
                aria-label="Close constituents"
              >
                <X size={20} />
              </Dialog.Close>
            </header>
            <div className="rrg-table-scroll">
              <table className="rrg-ranking-table">
                <thead>
                  <tr>
                    {[
                      ["symbol", "Stock"],
                      ["close", "Price / 1D"],
                      ["rsRating", "RS / 21D Δ"],
                      ["return1m", "1M return"],
                      ["excessReturn3m", "3M excess"],
                      ["turnover20Cr", "20D turnover ₹Cr"],
                      ["marketCapCr", "Market cap ₹Cr"],
                    ].map(([field, label]) => (
                      <th
                        key={field}
                        aria-sort={
                          stockSort === field
                            ? stockDesc
                              ? "descending"
                              : "ascending"
                            : "none"
                        }
                      >
                        <button
                          onClick={() => {
                            setStockSort(field);
                            setStockDesc(
                              stockSort === field ? !stockDesc : true,
                            );
                          }}
                        >
                          {label}
                          {stockSort === field &&
                            (stockDesc ? (
                              <ArrowDown size={12} />
                            ) : (
                              <ArrowUp size={12} />
                            ))}
                        </button>
                      </th>
                    ))}
                    <th>Active setups</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.map((stock) => (
                    <tr key={stock.symbol}>
                      <td>
                        <strong>{stock.symbol}</strong>
                        <small>{stock.name}</small>
                      </td>
                      <td>
                        ₹{number(stock.close)}
                        <small className={tone(stock.changePct)}>
                          {signed(stock.changePct)}
                        </small>
                      </td>
                      <td>
                        {stock.rsRating ?? "—"}
                        <small className={tone(stock.rsChange21d)}>
                          {signed(stock.rsChange21d, " pts")}
                        </small>
                      </td>
                      <td className={tone(stock.return1m)}>
                        {signed(stock.return1m)}
                      </td>
                      <td className={tone(stock.excessReturn3m)}>
                        {signed(stock.excessReturn3m)}
                      </td>
                      <td>{number(stock.turnover20Cr)}</td>
                      <td>{number(stock.marketCapCr)}</td>
                      <td>
                        <div className="rrg-setups">
                          {(
                            Object.keys(
                              setupNames,
                            ) as (keyof typeof setupNames)[]
                          )
                            .filter((key) => stock.setups[key])
                            .map((key) => (
                              <span key={key}>{setupNames[key]}</span>
                            ))}
                          {!Object.values(stock.setups).some(Boolean) && (
                            <span>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
export default ThematicRrgTab;
