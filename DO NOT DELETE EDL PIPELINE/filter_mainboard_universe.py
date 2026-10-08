"""Make the canonical scanner universe mainboard-only.

The Dhan/ScanX response is retained as a source snapshot because it contains
both mainboard and SME securities.  Downstream pipeline stages must instead
use ``master_isin_map.json`` after this filter has removed the current NSE SME
market-watch symbols.
"""

from datetime import datetime, timezone
import csv

from pipeline_utils import load_json, resolve_path, save_json


MASTER_FILE = "master_isin_map.json"
SME_FILE = "sme_market_data.json"
RAW_SCANX_FILE = "dhan_data_response.json"
MAINBOARD_SCANX_FILE = "mainboard_scanx_data.json"
REPORT_FILE = "mainboard_universe_report.json"


def normalise_symbol(value):
    return str(value or "").strip().upper()


def filter_mainboard_universe(master_rows, sme_rows):
    """Return current mainboard rows and the set of NSE SME symbols removed."""
    sme_symbols = {
        normalise_symbol(row.get("Symbol"))
        for row in sme_rows
        if isinstance(row, dict) and normalise_symbol(row.get("Symbol"))
    }
    mainboard_rows = [
        row for row in master_rows
        if normalise_symbol(row.get("Symbol")) not in sme_symbols
    ]
    return mainboard_rows, sme_symbols


def filter_rows_by_symbol(rows, allowed_symbols, symbol_key):
    """Keep raw source rows represented by the filtered canonical universe."""
    return [
        row for row in rows
        if normalise_symbol(row.get(symbol_key)) in allowed_symbols
    ]


def reconcile_listed_universe(master_rows, nse_rows):
    """Require a matching NSE symbol and ISIN; report unsupported provider rows."""
    listings = {normalise_symbol(row.get('SYMBOL')): normalise_symbol(row.get('ISIN NUMBER'))
                for raw in nse_rows for row in [{key.strip(): value for key, value in raw.items()}]
                if row.get('SYMBOL') and row.get('ISIN NUMBER')}
    if not listings:
        raise ValueError('NSE equity list has no usable symbol/ISIN pairs')
    retained, excluded = [], []
    for row in master_rows:
        symbol, isin = normalise_symbol(row.get('Symbol')), normalise_symbol(row.get('ISIN'))
        if symbol in listings and isin and listings[symbol] == isin:
            retained.append(row)
        else:
            excluded.append({'symbol': symbol, 'isin': isin, 'nse_isin': listings.get(symbol),
                             'reason': 'absent_from_nse_equity_list' if symbol not in listings else 'isin_mismatch'})
    if not retained:
        raise ValueError('NSE listing reconciliation removed every canonical security')
    return retained, excluded


def main():
    master_rows = load_json(MASTER_FILE)
    sme_rows = load_json(SME_FILE)
    raw_scanx_rows = load_json(RAW_SCANX_FILE)
    if not all(isinstance(rows, list) for rows in (master_rows, sme_rows, raw_scanx_rows)):
        raise ValueError("master, SME, and raw ScanX source artifacts must be JSON arrays")

    mainboard_rows, sme_symbols = filter_mainboard_universe(master_rows, sme_rows)
    if not mainboard_rows:
        raise ValueError("mainboard filter removed every canonical security")

    excluded_rows = len(master_rows) - len(mainboard_rows)
    if excluded_rows == 0:
        raise ValueError("NSE SME source did not match any canonical securities")

    with resolve_path('nse_equity_list.csv').open(encoding='utf-8-sig', newline='') as handle:
        mainboard_rows, unsupported = reconcile_listed_universe(mainboard_rows, list(csv.DictReader(handle)))

    canonical_symbols = {normalise_symbol(row.get("Symbol")) for row in mainboard_rows}
    mainboard_scanx_rows = filter_rows_by_symbol(raw_scanx_rows, canonical_symbols, "Sym")
    if not mainboard_scanx_rows:
        raise ValueError("mainboard filter removed every raw ScanX security")

    save_json(MASTER_FILE, mainboard_rows)
    save_json(MAINBOARD_SCANX_FILE, mainboard_scanx_rows)
    save_json(REPORT_FILE, {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "NSE SME market watch and EQUITY_L symbol/ISIN reconciliation",
        "excluded_unlisted_or_mismatched": unsupported,
        "excluded_unlisted_or_mismatched_count": len(unsupported),
        "raw_scanx_count": len(master_rows),
        "nse_sme_symbol_count": len(sme_symbols),
        "excluded_sme_count": excluded_rows,
        "mainboard_count": len(mainboard_rows),
        "mainboard_scanx_count": len(mainboard_scanx_rows),
        "excluded_sme_symbols": sorted(
            normalise_symbol(row.get("Symbol"))
            for row in master_rows
            if normalise_symbol(row.get("Symbol")) in sme_symbols
        ),
    })
    print(
        f"Canonical universe: {len(mainboard_rows)} mainboard symbols "
        f"({excluded_rows} current SME symbols excluded)."
    )
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
