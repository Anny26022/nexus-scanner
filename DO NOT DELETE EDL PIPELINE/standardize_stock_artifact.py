"""Publish the internal master JSON as a stable scanner-native schema."""

import os
import re
from functools import lru_cache

from pipeline_utils import BASE_DIR, apply_sma_fields, load_json, save_json


INPUT_FILE = os.path.join(BASE_DIR, "all_stocks_fundamental_analysis.json")
EXCLUDED_FIELDS = {
    "RS Rating", "1M RS Rating", "3M RS Rating", "Industry RS Rank",
    "Industry 1W Rank", "Industry 3W Rank", "SMA Status", "EMA Status",
    "Technical Sentiment", "Historical P/E 5",
}
REPLACED_LEGACY_FIELDS = {
    "Symbol", "Name", "Listing Date", "Basic Industry", "Sector", "Index",
    "Market Cap(Cr.)", "Stock Price(₹)", "1 Day Returns(%)", "1 Week Returns(%)",
    "1 Month Returns(%)", "3 Month Returns(%)", "6 Month Returns(%)", "1 Year Returns(%)",
    "RSI (14)", "Gap Up %", "Day Range(%)", "RVOL", "Float Shares(Cr.)", "Free Float(%)",
    "P/E", "Forward P/E", "PEG", "D/E", "ROE(%)", "ROCE(%)", "OPM TTM(%)",
    "F&O", "Lot Size", "Next Expiry", "Circuit Limit", "Quarterly Results Date",
    "Returns since Earnings(%)", "Max Returns since Earnings(%)",
    "5 Days MA ADR(%)", "14 Days MA ADR(%)", "20 Days MA ADR(%)", "30 Days MA ADR(%)",
    "200 Days EMA Volume", "30 Days Average Rupee Volume(Cr.)",
}


@lru_cache(maxsize=4096)
def snake_case(name):
    name = name.replace("%", " percent ").replace("₹", " rupee ").replace("&", " and ")
    name = re.sub(r"\(([^)]*)\)", r" \1 ", name)
    name = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
    return re.sub(r"_+", "_", name)


def normalize_object(value):
    if isinstance(value, list):
        return [normalize_object(item) for item in value]
    if isinstance(value, dict):
        return {snake_case(key): normalize_object(item) for key, item in value.items()}
    if value == "N/A" or value == "":
        return None
    if value == "Yes":
        return True
    if value == "No":
        return False
    return value


def canonicalize_stock(stock):
    # Local repair and republish operations may start from the already
    # canonical gzip artifact. Keep that representation intact instead of
    # treating its snake_case keys as absent legacy display fields.
    if "symbol" in stock and "Symbol" not in stock:
        result = normalize_object(dict(stock))
        result["schema_version"] = "3.0"
        return result
    result = {
        "schema_version": "3.0",
        "symbol": stock.get("Symbol"),
        "name": stock.get("Name"),
        "listing_date": stock.get("Listing Date"),
        "isin": stock.get("ISIN"),
        "security_id": stock.get("Security ID"),
        "exchange": stock.get("exchange"),
        "instrument": stock.get("instrument"),
        "segment": stock.get("segment"),
        "listing_board": stock.get("listing_board", "UNKNOWN"),
        "is_sme": stock.get("is_sme"),
        "listing_series": stock.get("listing_series"),
        "default_screener_eligible": stock.get("is_sme") is not True,
        "sector": stock.get("sector", stock.get("Sector")),
        "industry": stock.get("industry", stock.get("Basic Industry")),
        "index_memberships": stock.get("Index Memberships") or [item.strip() for item in (stock.get("Index") or "").split(",") if item.strip() and item.strip() != "N/A"],
        "index_memberships_as_of": stock.get("Index Membership As Of"),
        "as_of_date": stock.get("as_of_date"),
    }

    for key, value in stock.items():
        if key in EXCLUDED_FIELDS or key in REPLACED_LEGACY_FIELDS or key == "scanner_schema_version":
            continue
        normalized_key = snake_case(key)
        if normalized_key not in result:
            result[normalized_key] = normalize_object(value)

    # Canonical aliases always take precedence over legacy display fields.
    aliases = {
        "close": stock.get("close", stock.get("Stock Price(₹)")),
        "open": stock.get("open"),
        "high": stock.get("high"),
        "low": stock.get("low"),
        "volume": stock.get("volume"),
        "rupee_volume": stock.get("rupee_volume"),
        "change_percent": stock.get("change_percent", stock.get("1 Day Returns(%)")),
        "market_cap_crore": stock.get("market_cap_crore", stock.get("Market Cap(Cr.)")),
        "shares_outstanding": stock.get("shares_outstanding"),
        "share_capital": stock.get("share_capital"),
        "free_float_percent": stock.get("free_float_percent", stock.get("Free Float(%)")),
        "float_shares": stock.get("float_shares"),
        "rsi14": stock.get("rsi14", stock.get("RSI (14)")),
        "gap_percent": stock.get("gap_percent", stock.get("Gap Up %")),
        "range_percent": stock.get("range_percent", stock.get("Day Range(%)")),
        "relative_volume_20": stock.get("relative_volume_20", stock.get("RVOL")),
        "adr_percent_5": stock.get("5 Days MA ADR(%)"),
        "adr_percent_14": stock.get("14 Days MA ADR(%)"),
        "adr_percent_20": stock.get("adr_percent_20", stock.get("20 Days MA ADR(%)")),
        "adr_percent_30": stock.get("30 Days MA ADR(%)"),
        "volume_ema_200": stock.get("200 Days EMA Volume"),
        "avg_rupee_volume_30_crore": stock.get("30 Days Average Rupee Volume(Cr.)"),
        "perf_1w": stock.get("perf_1w", stock.get("1 Week Returns(%)")),
        "perf_1m": stock.get("perf_1m", stock.get("1 Month Returns(%)")),
        "perf_3m": stock.get("perf_3m", stock.get("3 Month Returns(%)")),
        "perf_6m": stock.get("perf_6m", stock.get("6 Month Returns(%)")),
        "perf_12m": stock.get("perf_12m", stock.get("1 Year Returns(%)")),
        "pe_ratio": stock.get("P/E"),
        "forward_pe_ratio": stock.get("Forward P/E"),
        "peg_ratio": stock.get("PEG"),
        "debt_to_equity": stock.get("D/E"),
        "roe_percent": stock.get("ROE(%)"),
        "roce_percent": stock.get("ROCE(%)"),
        "operating_margin_ttm_percent": stock.get("OPM TTM(%)"),
        "fno_eligible": stock.get("F&O"),
        "fno_lot_size": stock.get("Lot Size"),
        "fno_next_expiry": stock.get("Next Expiry"),
        "circuit_limit": stock.get("Circuit Limit"),
        "latest_earnings_date": stock.get("Quarterly Results Date"),
        "earnings_report_type": stock.get("Earnings Report Type"),
        "returns_since_earnings_percent": stock.get("Returns since Earnings(%)"),
        "max_returns_since_earnings_percent": stock.get("Max Returns since Earnings(%)"),
        "event_markers": [item.strip() for item in (stock.get("Event Markers") or "").split("|") if item.strip() and item.strip() != "N/A"],
        "recent_announcements": normalize_object(stock.get("Recent Announcements", [])),
        "news_feed": normalize_object(stock.get("News Feed", [])),
        "delivery_percent": stock.get("Delivery %"),
        "deliverable_quantity": stock.get("Deliverable Quantity"),
        "delivery_traded_quantity": stock.get("Delivery Traded Quantity"),
        "delivery_as_of_date": stock.get("Delivery As Of Date"),
        "delivery_series": stock.get("Delivery Series"),
    }
    result.update({key: normalize_object(value) for key, value in aliases.items()})
    apply_sma_fields(result)
    return normalize_object(result)


def main():
    try:
        stocks = load_json(INPUT_FILE)
    except FileNotFoundError:
        print(f"Error: {INPUT_FILE} not found.")
        return False

    save_json(INPUT_FILE, [canonicalize_stock(stock) for stock in stocks], ensure_ascii=False)
    print(f"Standardized {len(stocks)} stocks into scanner schema v3.")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
