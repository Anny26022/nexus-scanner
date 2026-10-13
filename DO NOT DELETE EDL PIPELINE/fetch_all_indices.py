import sys
from ohlcv_utils import nse_now

from pipeline_utils import fetch_scanx_data, save_json


OUTPUT_FILE = "all_indices_list.json"


def build_payload():
    return {
        "data": {
            "sort": "Sym", "sorder": "asc", "count": 500,
            "fields": [
                "Sym", "DispSym", "Sid", "Exch", "Seg", "Inst", 
                "Open", "High", "Low", "Ltp", "Pchange", "PPerchange", 
                "High1Yr", "Low1Yr", "Min1TotalVolPrevCandle" # <--- Cumulative Today Volume
            ],
            "params": [
                {"field": "Inst", "op": "", "val": "IDX"},
                {"field": "Exch", "op": "", "val": "IDX"}
            ],
            "pgno": 1
        }
    }


def clean_index(item):
    volume = item.get("Min1TotalVolPrevCandle", 0)
    if isinstance(volume, (int, float)) and volume < 0:
        volume = 0

    return {
        "IndexName": item.get("DispSym"),
        "Symbol": item.get("Sym"),
        "IndexID": item.get("Sid"),
        "Exchange": item.get("Exch"),
        "Segment": item.get("Seg"),
        "Instrument": item.get("Inst"),
        "Open": item.get("Open"),
        "High": item.get("High"),
        "Low": item.get("Low"),
        "Ltp": item.get("Ltp"),
        "Chng": item.get("Pchange"),
        "PChng": item.get("PPerchange"),
        "Volume": volume,
        "52W_High": item.get("High1Yr"),
        "52W_Low": item.get("Low1Yr"),
    }


def fetch_all_indices():
    """
    Fetches strictly NSE Indices using ScanX Pro API.
    Captures live LTP, OHLC, and today's cumulative volume.
    """
    print("Fetching NSE Indices & Today's Volume via ScanX Pro API...")

    try:
        items = fetch_scanx_data(build_payload(), timeout=15)
        fetched_at = nse_now().isoformat()
        final_indices = [{**clean_index(item), 'SnapshotFetchedAt': fetched_at} for item in items]
        if not final_indices:
            print("No indices returned from ScanX.")
            return False

        print(f"Successfully identified {len(final_indices)} Indices with Today's Volume.")
        save_json(OUTPUT_FILE, final_indices)
        return True
    except Exception as e:
        print(f"Critical API Failure: {e}")
        return False

if __name__ == "__main__":
    sys.exit(0 if fetch_all_indices() else 1)
