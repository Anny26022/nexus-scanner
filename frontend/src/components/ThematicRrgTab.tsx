import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { screenerApi } from "../api/screenerApi";
import type { RrgConstituentStock, RrgQuadrant } from "../types/thematicRrg";
import { RrgChart } from "./rrg/RrgChart";
import { RrgConstituentsDialog } from "./rrg/RrgConstituentsDialog";
import { RrgInspector } from "./rrg/RrgInspector";
import { RrgRankings } from "./rrg/RrgRankings";
import { QUADRANT_ORDER, computeBounds, isIpoItem, itemKey, type RrgItem, type RrgMode } from "./rrg/rrgShared";

type SortDirection = "asc" | "desc";

const formatDate = (date: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const compareValues = (left: unknown, right: unknown) => typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
const valueFor = (item: RrgItem, field: string): string | number => {
  if (field === "name") return itemKey(item);
  if (field === "symbol" && isIpoItem(item)) return item.symbol;
  if (field === "quadrant") return item.quadrant;
  if (field === "x") return item.x;
  if (field === "y") return item.y;
  if (!isIpoItem(item) && field === "excessReturn3m") return item.x;
  if (!isIpoItem(item) && field === "rsMomentum21d") return item.y;
  if (isIpoItem(item)) return item[field as keyof typeof item] as string | number;
  return item.metrics[field as keyof typeof item.metrics] as number;
};

export function ThematicRrgTab({ datasetRevision }: { datasetRevision?: string }) {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["thematicRrg", datasetRevision], queryFn: () => screenerApi.getThematicRrg(datasetRevision), staleTime: 5 * 60 * 1000 });
  const [selectedMode, setMode] = useState<RrgMode>("blocks");
  const mode = selectedMode === "indices" && data && !data.thematicIndices?.length ? "blocks" : selectedMode;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [quadrant, setQuadrant] = useState<RrgQuadrant | "All">("All");
  const [search, setSearch] = useState("");
  const showLabels = true;
  const [showTrails, setShowTrails] = useState(false);
  const [weeks, setWeeks] = useState(8);
  const [replayWeek, setReplayWeek] = useState(0);
  const [sortField, setSortField] = useState("excessReturn3m");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [constituentsOpen, setConstituentsOpen] = useState(false);
  const [constituentSortField, setConstituentSortField] = useState<keyof RrgConstituentStock>("excessReturn3m");
  const [constituentSortDesc, setConstituentSortDesc] = useState(true);
  const [drilledBlock, setDrilledBlock] = useState<string | null>(null);

  const scope = useMemo<RrgItem[]>(() => {
    if (!data) return [];
    if (mode === "blocks") return data.blocks;
    if (mode === "niches") return drilledBlock ? data.niches.filter((item) => item.parentBlock === drilledBlock) : data.niches;
    if (mode === "indices") return data.thematicIndices ?? [];
    return data.ipoTactical ?? [];
  }, [data, mode, drilledBlock]);
  const replayScope = useMemo<RrgItem[]>(() => {
    if (mode === "ipos" || replayWeek === 0) return scope;
    return scope.flatMap((item) => {
      const point = item.trail.find((entry) => entry.week === replayWeek);
      return point ? [{ ...item, x: point.x, y: point.y, quadrant: point.quadrant,
        trail: item.trail.filter(entry => entry.week >= replayWeek) }] : [];
    });
  }, [scope, mode, replayWeek]);
  const effectiveSortField = replayWeek > 0 && mode !== "ipos"
    && ["medianRs", "beatingBenchmarkPct", "constituentCount", "excessReturn1m", "excessReturn6m"].includes(sortField)
    ? "excessReturn3m" : sortField;
  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const visible = replayScope.filter((item) => (!needle || `${itemKey(item)} ${isIpoItem(item) ? item.name : item.macro ?? ""}`.toLowerCase().includes(needle)) && (quadrant === "All" || item.quadrant === quadrant));
    return [...visible].sort((left, right) => {
      const delta = compareValues(valueFor(left, effectiveSortField), valueFor(right, effectiveSortField));
      return sortDirection === "desc" ? -delta : delta;
    });
  }, [replayScope, search, quadrant, effectiveSortField, sortDirection]);
  const selectedItem = useMemo(() => replayScope.find((item) => itemKey(item) === selectedKey) ?? null, [replayScope, selectedKey]);
  const isIpoMode = mode === "ipos";
  const isIndexMode = mode === "indices";
  const bounds = useMemo(() => computeBounds(scope, isIpoMode), [scope, isIpoMode]);
  const trailWeeks = data ? Math.min(weeks, data.trailWeeks) : weeks;
  const constituentStocks = useMemo(() => {
    if (!selectedItem || isIpoItem(selectedItem)) return [];
    return [...selectedItem.constituents].sort((left, right) => (constituentSortDesc ? -1 : 1) * compareValues(left[constituentSortField], right[constituentSortField]));
  }, [selectedItem, constituentSortField, constituentSortDesc]);

  const chooseMode = (nextMode: RrgMode) => { setMode(nextMode); setReplayWeek(0); setSelectedKey(null); setDrilledBlock(null); setQuadrant("All"); setSearch(""); setSortField(nextMode === "ipos" ? "excessReturn10d" : "excessReturn3m"); };
  const selectItem = (item: RrgItem) => setSelectedKey(itemKey(item));
  const changeSort = (field: string) => { if (field === sortField) setSortDirection((direction) => direction === "desc" ? "asc" : "desc"); else { setSortField(field); setSortDirection("desc"); } };
  const drillIntoBlock = (block: string) => { setMode("niches"); setDrilledBlock(block); setSelectedKey(null); setQuadrant("All"); setSearch(""); setSortField("excessReturn3m"); setSortDirection("desc"); };

  if (isLoading) return <div className="rrg-state">Loading thematic rotation data…</div>;
  if (isError || !data) return <div className="rrg-state">Unable to load thematic rotation data. <button onClick={() => void refetch()}>Try again</button></div>;

  const eligibleEquities = data.constituentEligibility?.eligibleSymbols;
  const earliestTrailDate = scope.flatMap((item) => item.trail).at(0)?.date ?? data.asOfDate;
  const replayDate = replayScope.flatMap((item) => item.trail).find((point) => point.week === replayWeek)?.date;
  const replayLabel = replayDate ? formatDate(replayDate) : "Unavailable";
  const counts = Object.fromEntries(QUADRANT_ORDER.map((entry) => [entry, replayScope.filter((item) => item.quadrant === entry).length]));

  return <section className="rrg-shell" aria-label="Thematic relative rotation graph">
    <header className="rrg-header"><div><p className="rrg-kicker">THEMATIC ROTATION</p><h1>Where leadership is moving</h1><p className="rrg-subtitle">{isIndexMode ? "Official index 3-month excess return" : "Median 3-month excess return"} versus {data.benchmark} and 21-day relative-strength momentum.</p></div><div className="rrg-asof"><span>AS OF</span><strong>{formatDate(data.asOfDate)}</strong><small>{isIndexMode ? `${scope.length} NSE indices` : eligibleEquities === undefined ? `${data.totalEquities.toLocaleString("en-IN")} equities` : `${eligibleEquities.toLocaleString("en-IN")} institutional equities`}</small></div></header>
    <div className="rrg-controlbar"><div className="rrg-mode-tabs" role="tablist" aria-label="RRG universe">{([["blocks", `Blocks ${data.totalBlocks}`], ["niches", `Niches ${data.totalNiches}`], ...(data.thematicIndices?.length ? [["indices", `NSE indices ${data.thematicIndices.length}`] as const] : []), ["ipos", `New listings ${(data.ipoTactical ?? []).length}`]] as const).map(([entry, label]) => <button key={entry} type="button" role="tab" aria-selected={mode === entry} className={mode === entry ? "is-active" : ""} onClick={() => chooseMode(entry)}>{label}</button>)}</div><div className="rrg-controlbar__right"><label className="rrg-search"><Search size={14} /><span className="sr-only">Search themes</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={isIpoMode ? "Search company" : isIndexMode ? "Search NSE index" : "Search theme"} />{search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")}><X size={12} /></button>}</label></div></div>
    {!isIpoMode && !isIndexMode && data.rsCoverage?.momentumAvailable === false && <p className="notice" role="status">Rotation history is unavailable. Backfill dated RS universes to populate this map.</p>}
    {isIndexMode && <p className="rrg-method">Index RS ranks 63-session returns across available aligned indices; it differs from stock RS. {data.thematicIndexCoverage && `${data.thematicIndexCoverage.available} of ${data.thematicIndexCoverage.requested} available.`}</p>}
    {drilledBlock && <div className="rrg-breadcrumb"><button type="button" onClick={() => setDrilledBlock(null)}>All niches</button><span>/</span><strong>{drilledBlock}</strong></div>}
    <div className="rrg-filterbar"><div className="rrg-filterbar__label"><SlidersHorizontal size={14} /> Quadrants</div><button type="button" className={quadrant === "All" ? "is-active" : ""} onClick={() => { setQuadrant("All"); setSelectedKey(null); }}>All <span>{scope.length}</span></button>{QUADRANT_ORDER.map((entry) => <button key={entry} type="button" className={quadrant === entry ? `is-active is-${entry.toLowerCase()}` : ""} onClick={() => { setQuadrant(entry); setSelectedKey(null); }}><i className={`rrg-dot rrg-dot--${entry.toLowerCase()}`} />{entry} <span>{counts[entry]}</span></button>)}{!isIpoMode && <div className="rrg-trails"><button type="button" className={showTrails ? "is-active" : ""} onClick={() => setShowTrails((value) => !value)}>Trails</button>{showTrails && [4, 8, 12].filter((entry) => entry <= data.trailWeeks).map((entry) => <button key={entry} type="button" className={trailWeeks === entry ? "is-active" : ""} onClick={() => setWeeks(entry)}>{entry}W</button>)}<label className="rrg-replay"><span>Replay</span><input aria-label="RRG replay date" type="range" min="0" max={data.trailWeeks} value={data.trailWeeks - replayWeek} onChange={(event) => { setReplayWeek(data.trailWeeks - Number(event.target.value)); setSelectedKey(null); }} /><output>{replayWeek === 0 ? "Live" : replayLabel}</output></label></div>}</div>
    <div className="rrg-workspace"><div className="rrg-stage"><div className="rrg-stage__meta"><span>{replayWeek === 0 ? `${formatDate(earliestTrailDate)} → ${formatDate(data.asOfDate)}` : `Snapshot · ${replayLabel}`}</span><span>{items.length} of {scope.length} shown</span></div><RrgChart items={items} scope={replayScope} selectedKey={selectedKey} onSelect={selectItem} weeks={trailWeeks} showTrails={showTrails} replayWeek={replayWeek} isIpoMode={isIpoMode} showLabels={showLabels} benchmark={data.benchmark} bounds={bounds} /></div><RrgInspector replay={replayWeek > 0 && !isIpoMode} item={selectedItem} scope={replayScope} weeks={trailWeeks} onClose={() => setSelectedKey(null)} onDrillIntoBlock={drillIntoBlock} onOpenConstituents={() => setConstituentsOpen(true)} bounds={bounds} /></div>
    <section className="rrg-ranking-section"><div className="rrg-ranking-section__head"><div><p className="rrg-kicker">ROTATION RANKINGS</p><h2>{isIpoMode ? "Recent listings" : isIndexMode ? "NSE thematic indices" : drilledBlock ?? (mode === "blocks" ? "Thematic blocks" : "All niches")}</h2></div><span>Click a row to inspect its rotation file</span></div><RrgRankings replay={replayWeek > 0 && !isIpoMode} items={items} mode={mode} sortField={effectiveSortField} sortDesc={sortDirection === "desc"} onSort={changeSort} selectedKey={selectedKey} onSelect={selectItem} bounds={bounds} /></section>
    <RrgConstituentsDialog open={constituentsOpen} onOpenChange={setConstituentsOpen} item={selectedItem} stocks={constituentStocks} sortField={constituentSortField} sortDesc={constituentSortDesc} onSort={(field) => { if (field === constituentSortField) setConstituentSortDesc((value) => !value); else { setConstituentSortField(field); setConstituentSortDesc(true); } }} />
    <div className="rrg-method"><Check size={13} /><span><b>Method:</b> quadrant boundaries are 0% excess return and 0 RS-rating points. This is a thematic rotation map, not a normalized JdK RS-Ratio / RS-Momentum chart.</span></div>
  </section>;
}

export default ThematicRrgTab;
