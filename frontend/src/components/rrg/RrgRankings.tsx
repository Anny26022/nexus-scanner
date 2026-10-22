import { ArrowDown, ArrowUp } from "lucide-react";
import {
  QUADRANT_VAR,
  fmtNum,
  fmtSigned,
  isIpoItem,
  itemKey,
  itemSubtitle,
  toneClass,
  type RrgBounds,
  type RrgItem,
  type RrgMode,
} from "./rrgShared";
import { RrgMicroMap } from "./RrgMicroMap";

interface RrgRankingsProps {
  replay?: boolean;
  items: RrgItem[];
  mode: RrgMode;
  sortField: string;
  sortDesc: boolean;
  onSort: (field: string) => void;
  selectedKey: string | null;
  onSelect: (item: RrgItem) => void;
  bounds: RrgBounds;
}

interface Column {
  id: string;
  label: string;
  numeric?: boolean;
  hint?: string;
}

const CLUSTER_COLUMNS: Column[] = [
  { id: "name", label: "Theme" },
  { id: "quadrant", label: "Quadrant" },
  { id: "excessReturn3m", label: "3M excess", numeric: true },
  { id: "rsMomentum21d", label: "21D RS Δ", numeric: true },
  { id: "medianRs", label: "Median RS", numeric: true },
  { id: "beatingBenchmarkPct", label: "Breadth", numeric: true },
  { id: "constituentCount", label: "Stocks", numeric: true },
];

const IPO_COLUMNS: Column[] = [
  { id: "symbol", label: "Company" },
  { id: "quadrant", label: "Quadrant" },
  { id: "excessReturn10d", label: "10D / LTD excess", numeric: true },
  { id: "turnoverIntensity", label: "Turnover int.", numeric: true },
  { id: "gainSinceListingPct", label: "Listing gain", numeric: true },
  { id: "turnoverCr", label: "Daily turnover", numeric: true },
  { id: "listingDate", label: "Listed" },
];

function SortHeader({
  column,
  active,
  desc,
  onSort,
}: {
  column: Column;
  active: boolean;
  desc: boolean;
  onSort: (field: string) => void;
}) {
  return (
    <th
      className={`rrg-th ${column.numeric ? "is-numeric" : ""} ${active ? "is-active" : ""}`}
      onClick={() => onSort(column.id)}
      title={column.hint ?? `Sort by ${column.label}`}
    >
      <span className="rrg-th__label">
        {column.label}
        {active && (desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
      </span>
    </th>
  );
}

export function RrgRankings({
  replay = false,
  items,
  mode,
  sortField,
  sortDesc,
  onSort,
  selectedKey,
  onSelect,
  bounds,
}: RrgRankingsProps) {
  const columns = mode === "ipos" ? IPO_COLUMNS : CLUSTER_COLUMNS.filter(column => !replay || !["medianRs", "beatingBenchmarkPct", "constituentCount"].includes(column.id));

  return (
    <div className="rrg-table-wrap">
      <table className="rrg-table">
        <thead>
          <tr>
            <th className="rrg-th rrg-th--rank">#</th>
            <th className="rrg-th rrg-th--map">Map</th>
            {columns.map((column) => (
              <SortHeader
                key={column.id}
                column={column}
                active={sortField === column.id}
                desc={sortDesc}
                onSort={onSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const key = itemKey(item);
            const selected = key === selectedKey;
            return (
              <tr
                key={key}
                className={selected ? "is-selected" : ""}
                onClick={() => onSelect(item)}
              >
                <td className="rrg-td rrg-td--rank">{index + 1}</td>
                <td className="rrg-td rrg-td--map">
                  <RrgMicroMap item={item} bounds={bounds} />
                </td>
                <td className="rrg-td">
                  <div className="rrg-cell-name">
                    <span className="rrg-cell-name__title">{key}</span>
                    <span className="rrg-cell-name__sub">{itemSubtitle(item)}</span>
                  </div>
                </td>
                <td className="rrg-td">
                  <span className="rrg-quad" style={{ color: QUADRANT_VAR[item.quadrant] }}>
                    <span className="rrg-quad__dot" style={{ background: QUADRANT_VAR[item.quadrant] }} />
                    {item.quadrant}
                  </span>
                </td>
                {isIpoItem(item) ? (
                  <>
                    <td className={`rrg-td is-numeric ${toneClass(item.excessReturn10d)}`}>
                      {fmtSigned(item.excessReturn10d)}
                    </td>
                    <td className={`rrg-td is-numeric ${toneClass(item.turnoverIntensity)}`}>
                      {fmtSigned(item.turnoverIntensity, "%")}
                    </td>
                    <td className={`rrg-td is-numeric ${toneClass(item.gainSinceListingPct)}`}>
                      {fmtSigned(item.gainSinceListingPct)}
                    </td>
                    <td className="rrg-td is-numeric">₹{fmtNum(item.turnoverCr)}</td>
                    <td className="rrg-td is-numeric rrg-td--dim">{item.listingDate}</td>
                  </>
                ) : (
                  <>
                    <td className={`rrg-td is-numeric ${toneClass(item.x)}`}>
                      {fmtSigned(item.x)}
                    </td>
                    <td className={`rrg-td is-numeric ${toneClass(item.y)}`}>
                      {fmtSigned(item.y, " pts")}
                    </td>
                    {!replay && <><td className="rrg-td is-numeric">{fmtNum(item.metrics.medianRs, 0)}</td>
                    <td className="rrg-td is-numeric">{fmtNum(item.metrics.beatingBenchmarkPct)}%</td>
                    <td className="rrg-td is-numeric">{item.metrics.constituentCount}</td></>}
                  </>
                )}
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr className="rrg-empty">
              <td colSpan={columns.length + 3}>No themes match the current filters.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
