import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import {
  fmtNum,
  fmtSigned,
  toneClass,
  type RrgItem,
} from "./rrgShared";
import type { RrgConstituentStock } from "../../types/thematicRrg";

interface RrgConstituentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: RrgItem | null;
  stocks: RrgConstituentStock[];
  sortField: keyof RrgConstituentStock;
  sortDesc: boolean;
  onSort: (field: keyof RrgConstituentStock) => void;
}

const COLUMNS: { id: keyof RrgConstituentStock; label: string; numeric?: boolean }[] = [
  { id: "symbol", label: "Symbol" },
  { id: "name", label: "Name" },
  { id: "close", label: "Price", numeric: true },
  { id: "changePct", label: "Change %", numeric: true },
  { id: "return3m", label: "3M Return", numeric: true },
  { id: "excessReturn3m", label: "3M Excess", numeric: true },
  { id: "rsRating", label: "RS Rating", numeric: true },
  { id: "rsChange21d", label: "21D RS Δ", numeric: true },
  { id: "turnover20Cr", label: "20D Turnover (Cr)", numeric: true },
];

export function RrgConstituentsDialog({
  open,
  onOpenChange,
  item,
  stocks,
  sortField,
  sortDesc,
  onSort,
}: RrgConstituentsDialogProps) {
  const title = item ? `${item.name} Constituent Stocks` : "Constituent Stocks";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="rrg-overlay" />
        <Dialog.Content className="rrg-dialog">
          <div className="rrg-dialog__head">
            <div>
              <Dialog.Title className="rrg-dialog__title">{title}</Dialog.Title>
              <Dialog.Description className="rrg-dialog__sub">
                Ranked by relative strength, excess return and setup coverage.
              </Dialog.Description>
            </div>
            <button className="rrg-icon-btn" onClick={() => onOpenChange(false)} aria-label="Close">
              <X size={14} />
            </button>
          </div>
          <div className="rrg-dialog__body">
            <table className="rrg-table rrg-table--dialog">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={String(column.id)}
                      className={`rrg-th ${column.numeric ? "is-numeric" : ""} ${sortField === column.id ? "is-active" : ""}`}
                      onClick={() => onSort(column.id)}
                    >
                      <span className="rrg-th__label">
                        {column.label}
                        {sortField === column.id && (sortDesc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                      </span>
                    </th>
                  ))}
                  <th className="rrg-th">Setups</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((stock) => (
                  <tr key={stock.symbol}>
                    <td className="rrg-td rrg-td--symbol">{stock.symbol}</td>
                    <td className="rrg-td">{stock.name}</td>
                    <td className="rrg-td is-numeric">₹{fmtNum(stock.close)}</td>
                    <td className={`rrg-td is-numeric ${toneClass(stock.changePct)}`}>
                      {fmtSigned(stock.changePct)}
                    </td>
                    <td className={`rrg-td is-numeric ${toneClass(stock.return3m)}`}>
                      {fmtSigned(stock.return3m)}
                    </td>
                    <td className={`rrg-td is-numeric ${toneClass(stock.excessReturn3m)}`}>
                      {fmtSigned(stock.excessReturn3m)}
                    </td>
                    <td className="rrg-td is-numeric">{stock.rsRating ?? "—"}</td>
                    <td className={`rrg-td is-numeric ${toneClass(stock.rsChange21d)}`}>
                      {fmtSigned(stock.rsChange21d, " pts")}
                    </td>
                    <td className="rrg-td is-numeric">{fmtNum(stock.turnover20Cr, 0)}</td>
                    <td className="rrg-td">
                      <div className="rrg-chips">
                        {Object.entries(stock.setups)
                          .filter(([, active]) => active)
                          .map(([setup]) => (
                            <span key={setup} className="rrg-chip rrg-chip--setup">
                              {setup.replace(/([A-Z])/g, " $1").trim()}
                            </span>
                          ))}
                        {Object.values(stock.setups).every((active) => !active) && (
                          <span className="rrg-td--dim">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {stocks.length === 0 && (
                  <tr className="rrg-empty">
                    <td colSpan={COLUMNS.length + 1}>No constituents available.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
