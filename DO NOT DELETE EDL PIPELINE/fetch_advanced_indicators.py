"""Fetch standard daily indicators in one TradingView scanner request."""
import math
import sys
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

from pipeline_utils import load_json, post_json, save_json

INPUT_FILE = "master_isin_map.json"
OUTPUT_FILE = "advanced_indicator_data.json"
API_URL = "https://scanner.tradingview.com/india/scan"
PERIODS = (5, 9, 10, 20, 21, 50, 100, 150, 200)
INDICATORS = {"RSI": "RSI(14)", "ATR": "ATR(14)", "ADX": "ADX(14)",
              "MACD.macd": "MACD(12,26)", "MACD.signal": "MACD Signal(9)"}
# Wire field -> (explicit output name, divisor). Reporting periods stay in names.
MARKET_FIELDS = {
    "open": ("open", 1), "high": ("high", 1), "low": ("low", 1),
    "volume": ("volume", 1), "change": ("change_pct", 1), "gap": ("gap_pct", 1),
    "Value.Traded": ("turnover_crore", 1e7),
    "AvgValue.Traded_10d": ("turnover10_crore", 1e7),
    "AvgValue.Traded_30d": ("turnover30_crore", 1e7),
    "AvgValue.Traded_60d": ("turnover60_crore", 1e7),
    "AvgValue.Traded_90d": ("turnover90_crore", 1e7),
    "average_volume_30d_calc": ("average_volume30", 1), "VWAP": ("vwap", 1),
    "price_52_week_high": ("high52w", 1), "price_52_week_low": ("low52w", 1),
    "High.All": ("all_time_high", 1), "Low.All": ("all_time_low", 1),
    "Perf.5D": ("performance_5d_pct", 1), "Perf.1M": ("performance_1m_pct", 1),
    "Perf.3M": ("performance_3m_pct", 1), "Perf.6M": ("performance_6m_pct", 1),
    "Perf.Y": ("performance_1y_pct", 1), "Perf.5Y": ("performance_5y_pct", 1),
    "ADRP": ("adr14_pct", 1), "ATRP": ("atr14_pct", 1),
    "market_cap_basic": ("market_cap_crore", 1e7),
    "float_shares_percent_current": ("free_float_pct", 1),
}
FINANCIAL_FIELDS = {
    "price_earnings_ttm": ("pe_ttm", 1), "price_book_current": ("pb_current", 1),
    "price_earnings_growth_ttm": ("peg_ttm", 1),
    "enterprise_value_ebitda_ttm": ("ev_ebitda_ttm", 1),
    "earnings_per_share_diluted_ttm": ("eps_diluted_ttm", 1),
    "dividends_yield_current": ("dividend_yield_current_pct", 1),
    "return_on_equity_fy": ("roe_fy_pct", 1), "return_on_assets_fy": ("roa_fy_pct", 1),
    "return_on_capital_employed_fy": ("roce_fy_pct", 1),
    "operating_margin": ("operating_margin_ttm_pct", 1),
    "current_ratio_fy": ("current_ratio_fy", 1), "debt_to_equity_fy": ("debt_equity_fy", 1),
    "total_revenue_ttm": ("revenue_ttm_crore", 1e7), "net_income_ttm": ("net_income_ttm_crore", 1e7),
    "total_revenue_yoy_growth_ttm": ("revenue_growth_ttm_pct", 1),
    "net_income_yoy_growth_ttm": ("net_income_growth_ttm_pct", 1),
    "earnings_per_share_diluted_yoy_growth_ttm": ("eps_diluted_growth_ttm_pct", 1),
    "total_assets_fy": ("total_assets_fy_crore", 1e7),
    "total_current_assets_fy": ("current_assets_fy_crore", 1e7),
    "total_current_liabilities_fy": ("current_liabilities_fy_crore", 1e7),
    "total_liabilities_fy": ("total_liabilities_fy_crore", 1e7),
    "free_cash_flow_fy": ("free_cash_flow_fy_crore", 1e7),
    "total_debt_fy": ("total_debt_fy_crore", 1e7),
    "number_of_shareholders": ("shareholder_count", 1),
}
COLUMNS = ["isin", "time", "update_mode", "currency", "fundamental_currency_code", "close",
           *[f"{kind}{period}" for kind in ("SMA", "EMA") for period in PERIODS],
           *INDICATORS, *MARKET_FIELDS, *FINANCIAL_FIELDS]
LIMIT = 10000


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def mapped_values(values, fields, currency):
    # Crore/price outputs are only valid for INR. Do not label other currencies INR.
    return {name: number(values[field]) / divisor if currency == "INR" and number(values[field]) is not None else None
            for field, (name, divisor) in fields.items()}


def normalize_rows(response, master, fetched_at):
    rows = response.get("data")
    if not isinstance(rows, list) or not rows or response.get("totalCount") != len(rows):
        raise ValueError("Incomplete TradingView scanner response")
    by_isin = {}
    for row in rows:
        if not isinstance(row, dict) or not str(row.get("s", "")).startswith("NSE:") or not isinstance(row.get("d"), list) or len(row["d"]) != len(COLUMNS):
            raise ValueError("Unexpected TradingView scanner row/column alignment")
        values = dict(zip(COLUMNS, row["d"]))
        isin = values["isin"]
        if not isin:
            continue
        if isin in by_isin:
            raise ValueError(f"Ambiguous TradingView ISIN: {isin}")
        by_isin[isin] = values
    result = []
    for item in master:
        values = by_isin.get(item.get("ISIN"))
        if values is None:
            continue
        timestamp = number(values["time"])
        if timestamp is None or number(values["close"]) is None:
            continue
        result.append({
            "Symbol": item["Symbol"], "ISIN": item["ISIN"], "source": API_URL,
            "asOfDate": datetime.fromtimestamp(timestamp, ZoneInfo("Asia/Kolkata")).date().isoformat(),
            "fetchedAt": fetched_at, "updateMode": values["update_mode"], "close": values["close"],
            "currency": values["currency"], "financialCurrency": values["fundamental_currency_code"],
            "market": mapped_values(values, MARKET_FIELDS, values["currency"]),
            "financials": mapped_values(values, FINANCIAL_FIELDS, values["fundamental_currency_code"]),
            **{kind: [{"Indicator": f"{period}-{kind}", "Value": number(values[f"{kind}{period}"])}
                      for period in PERIODS] for kind in ("SMA", "EMA")},
            "TechnicalIndicators": [{"Indicator": label, "Value": number(values[field])}
                                    for field, label in INDICATORS.items()],
            # Monthly TradingView pivots are not the old provider's daily pivots.
            "Pivots": [],
        })
    if not result:
        raise ValueError("TradingView returned no indicators for the canonical ISIN universe")
    # Use the observed stock session, never today's calendar date. Suspended
    # stocks may still have older candles in an otherwise current response.
    session = max(row["asOfDate"] for row in result)
    return [row for row in result if row["asOfDate"] == session]


def main():
    started = time.perf_counter()
    try:
        master = load_json(INPUT_FILE)
        if not master:
            raise ValueError("Master ISIN universe is empty")
        payload = {"columns": COLUMNS, "markets": ["india"], "options": {"lang": "en"},
                   "filter": [{"left": "exchange", "operation": "equal", "right": "NSE"},
                              {"left": "type", "operation": "equal", "right": "stock"},
                              {"left": "is_primary", "operation": "equal", "right": True}],
                   "range": [0, LIMIT]}
        response = post_json(API_URL, payload, timeout=20, retries=1)
        result = normalize_rows(response, master, datetime.now(timezone.utc).isoformat())
        save_json(OUTPUT_FILE, result)
        matched = {row["ISIN"] for row in result}
        missing = [item["Symbol"] for item in master if item.get("ISIN") not in matched]
        print(f"TradingView daily indicators: {len(result)}/{len(master)} matched by ISIN; "
              f"{len(missing)} unavailable; session {result[0]['asOfDate']}; "
              f"elapsed {time.perf_counter() - started:.2f}s", flush=True)
        if missing:
            print(f"Unavailable indicator symbols: {', '.join(missing)}", flush=True)
        return True
    except (OSError, ValueError, OverflowError, requests.RequestException) as error:
        print(f"Advanced indicator fetch failed: {error}", flush=True)
        return False


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
