import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
from edl_pipeline.schemas import SCREEN_METRICS

from pipeline_utils import SCANX_FETCH_URL, fetch_scanx_data, resolve_path, save_json


DASHBOARD_FIELDS = [
    "Isin", "DispSym", "Mcap", "Pe", "DivYeild", "Revenue", "Year1RevenueGrowth", "NetProfitMargin",
    "YoYLastQtrlyProfitGrowth", "EBIDTAMargin", "volume", "PricePerchng1year", "PricePerchng3year",
    "PricePerchng5year", "Ind_Pe", "Pb", "DivYeild", "Eps", "DaySMA10CurrentCandle", "DaySMA20CurrentCandle",
    "DaySMA50CurrentCandle", "DaySMA200CurrentCandle",
    "DayRSI14CurrentCandle", "ROCE", "Ltp", "Roe", "RtAwayFrom5YearHigh", "RtAwayFrom1MonthHigh",
    "High5yr", "High3Yr", "High1Yr", "High1Wk", "Sym", "PricePerchng1mon", "PricePerchng1week",
    "PricePerchng3mon", "YearlyEarningPerShare", "OCFGrowthOnYr", "Year1CAGREPSGrowth", "NetChangeInCash",
    "FreeCashFlow", "PricePerchng2week", "DayBbUpper_Sub_BbLower", "DayATR14CurrentCandleMul_2",
    "Min5HighCurrentCandle", "Min15HighCurrentCandle", "Min5EMA50CurrentCandle", "Min15EMA50CurrentCandle",
    "Min15SMA100CurrentCandle", "Open", "High", "Low", "Volume", "BcClose", "Rmp", "PledgeBenefit",
    "PricePerchng6mon", "Sector", "TotalShares", "ShareCapital", "Exch", "Inst", "Seg", "idxlist", "Sid", "FnoFlag"
]
DASHBOARD_FIELDS = list(dict.fromkeys([*DASHBOARD_FIELDS, *SCREEN_METRICS]))


def build_master_map(stocks):
    master_map = []
    for item in stocks:
        symbol = item.get("Sym")
        isin = item.get("Isin")
        security_id = item.get("Sid")
        try:
            price = float(item.get("Ltp"))
        except (TypeError, ValueError):
            price = 0
        if symbol and isin and security_id is not None and math.isfinite(price) and price > 0:
            master_map.append({
                "Symbol": symbol,
                "ISIN": isin,
                "Name": item.get("DispSym"),
                "Exchange": item.get("Exch", "NSE"),
                "Instrument": item.get("Inst", "EQUITY"),
                "Segment": item.get("Seg", "E"),
                "Sid": security_id,
                "FnoFlag": item.get("FnoFlag", 0),
            })
    return sorted(master_map, key=lambda x: x["Symbol"])

def fetch_all_dhan_data():
    output_file = resolve_path("dhan_data_response.json")
    master_map_file = resolve_path("master_isin_map.json")

    # Payload as specified by the user
    # Trying a large count to get "all available" in one call as requested
    payload = {
        "data": {
            "sort": "Mcap",
            "sorder": "desc",
            "count": 5000, # Large count to try and get everything
            "fields": DASHBOARD_FIELDS,
            "params": [
                {"field": "OgInst", "op": "", "val": "ES"},
                {"field": "Exch", "op": "", "val": "NSE"}
            ],
            "pgno": 0,
            "sorder": "desc",
            "sort": "Mcap"
        }
    }

    print(f"Fetching data from {SCANX_FETCH_URL}...")
    try:
        cleaned_data = fetch_scanx_data(payload, timeout=30)

        if cleaned_data:
            save_json(output_file, cleaned_data)
            print(f"Successfully fetched {len(cleaned_data)} items. Saved to {output_file}")
            
            print("Creating Master ISIN Map...")
            master_map = build_master_map(cleaned_data)
            save_json(master_map_file, master_map)
            print(f"Successfully saved {len(master_map)} symbols (with security ID and price) to {master_map_file}")
            return True
        else:
            print("Response structure might be different than expected.")
            return False
            
    except Exception as e:
        print(f"Error fetching data: {e}")
        return False

if __name__ == "__main__":
    sys.exit(0 if fetch_all_dhan_data() else 1)
