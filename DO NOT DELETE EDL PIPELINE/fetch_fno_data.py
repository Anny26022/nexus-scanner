import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
from edl_pipeline.schemas import SCREEN_METRICS

from pipeline_utils import SCANX_FETCH_URL, fetch_scanx_data, save_json


OUTPUT_FILE = "fno_stocks_response.json"
FNO_FIELDS = [
    "Isin", "DispSym", "Mcap", "Pe", "DivYeild", "Revenue", "Year1RevenueGrowth", "NetProfitMargin",
    "YoYLastQtrlyProfitGrowth", "EBIDTAMargin", "volume", "PricePerchng1year", "PricePerchng3year",
    "PricePerchng5year", "Ind_Pe", "Pb", "DivYeild", "Eps", "DaySMA50CurrentCandle", "DaySMA200CurrentCandle",
    "DayRSI14CurrentCandle", "ROCE", "Ltp", "Roe", "RtAwayFrom5YearHigh", "RtAwayFrom1MonthHigh",
    "High5yr", "High3Yr", "High1Yr", "High1Wk", "Sym", "PricePerchng1mon", "PricePerchng1week",
    "PricePerchng3mon", "YearlyEarningPerShare", "OCFGrowthOnYr", "Year1CAGREPSGrowth", "NetChangeInCash",
    "FreeCashFlow", "PricePerchng2week", "DayBbUpper_Sub_BbLower", "DayATR14CurrentCandleMul_2",
    "Min5HighCurrentCandle", "Min15HighCurrentCandle", "Min5EMA50CurrentCandle", "Min15EMA50CurrentCandle",
    "Min15SMA100CurrentCandle", "Open", "BcClose", "Rmp", "PledgeBenefit"
]
FNO_FIELDS = list(dict.fromkeys([*FNO_FIELDS, *SCREEN_METRICS]))


def build_payload():
    # Payload as specified by the user with FnoFlag: 1.
    return {
        "data": {
            "sort": "Mcap",
            "sorder": "desc",
            "count": 500,
            "fields": FNO_FIELDS,
            "params": [
                {"field": "FnoFlag", "op": "", "val": "1"},
                {"field": "OgInst", "op": "", "val": "ES"}
            ],
            "pgno": 0,
            "sorder": "desc",
            "sort": "Mcap"
        }
    }


def fetch_fno_flag_data():
    print(f"Fetching F&O data (FnoFlag: 1) from {SCANX_FETCH_URL}...")
    try:
        cleaned_stocks = fetch_scanx_data(build_payload())
        if not cleaned_stocks:
            print("Response structure might be different than expected.")
            return False

        save_json(OUTPUT_FILE, cleaned_stocks)
        print(f"Successfully fetched {len(cleaned_stocks)} F&O stocks. Saved to {OUTPUT_FILE}")
        return True
            
    except Exception as e:
        print(f"Error fetching data: {e}")
        return False

if __name__ == "__main__":
    sys.exit(0 if fetch_fno_flag_data() else 1)
