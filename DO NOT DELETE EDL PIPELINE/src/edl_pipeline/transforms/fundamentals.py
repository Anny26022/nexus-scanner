"""Build the base stock analysis artifact from Dhan fundamental and scan data."""

import csv
import os
import sys
import math

from pipeline_utils import BASE_DIR, load_json, save_json
from edl_pipeline.schemas import SCREEN_METRICS
from edl_pipeline.scanner.financials import normalize_statement_history, statement_summary


FUNDAMENTAL_FILE = os.path.join(BASE_DIR, "fundamental_data.json")
ADVANCED_FILE = os.path.join(BASE_DIR, "advanced_indicator_data.json")
DHAN_DATA_FILE = os.path.join(BASE_DIR, "dhan_data_response.json")
SME_DATA_FILE = os.path.join(BASE_DIR, "sme_market_data.json")
LISTING_DATES_FILE = os.path.join(BASE_DIR, "nse_equity_list.csv")
OUTPUT_FILE = os.path.join(BASE_DIR, "all_stocks_fundamental_analysis.json")

def get_float(value_str):
    return get_optional_float(value_str)


def get_optional_float(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def unavailable_session_candle(row):
    """Whether provider data cannot establish a session candle."""
    volume = row.get("Volume", row.get("volume"))
    return (all(row.get(key) is None for key in ("Open", "High", "Low"))
            and (volume is None or get_optional_float(volume) == 0))


def unavailable_candle(row):
    """A positive retained LTP may be kept only when its session candle is unavailable."""
    ltp = get_optional_float(row.get("Ltp"))
    return unavailable_session_candle(row) and ltp is not None and ltp > 0


def calculate_change(current, previous):
    if current is None or previous in (None, 0):
        return None
    return ((current - previous) / abs(previous)) * 100


def calculate_cagr(current, previous, years):
    """Return CAGR only when both endpoints are positive."""
    if current is None or previous is None or current <= 0 or previous <= 0 or years <= 0:
        return None
    return ((current / previous) ** (1 / years) - 1) * 100


def get_value_from_pipe_string(pipe_string, index):
    if not pipe_string:
        return None
    parts = pipe_string.split("|")
    if index < len(parts):
        return get_float(parts[index])
    return None


def rounded(value, digits=2):
    return round(value, digits) if value is not None and math.isfinite(value) else None


def positive(value):
    return value is not None and value > 0


def load_listing_dates(path=LISTING_DATES_FILE):
    listing_date_map = {}
    try:
        with open(path, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                symbol = row.get("SYMBOL")
                date_list = row.get(" DATE OF LISTING") or row.get("DATE OF LISTING")
                if symbol:
                    listing_date_map[symbol] = {
                        "listing_date": date_list,
                        "series": row.get(" SERIES") or row.get("SERIES"),
                    }
        print(f"Loaded listing dates for {len(listing_date_map)} symbols.")
    except FileNotFoundError:
        print("Warning: nse_equity_list.csv not found.")
    return listing_date_map


def map_scan_rows_by_symbol(path, symbol_key, label, missing_warning):
    mapped = {}
    try:
        for item in load_json(path):
            symbol = item.get(symbol_key)
            if symbol:
                mapped[symbol] = item
        print(f"Loaded {label} for {len(mapped)} symbols.")
    except FileNotFoundError:
        print(missing_warning)
    return mapped


def load_sme_map(path=SME_DATA_FILE):
    try:
        rows = load_json(path)
    except FileNotFoundError:
        print(f"Warning: {path} not found. SME classification unavailable.")
        return None
    return {row.get("Symbol"): row for row in rows if row.get("Symbol")}


def quarterly_metric_fields(prefix, source, pipe_name):
    latest = get_value_from_pipe_string(source.get(pipe_name), 0)
    previous = get_value_from_pipe_string(source.get(pipe_name), 1)
    two_back = get_value_from_pipe_string(source.get(pipe_name), 2)
    three_back = get_value_from_pipe_string(source.get(pipe_name), 3)
    last_year = get_value_from_pipe_string(source.get(pipe_name), 4)
    return {
        f"{prefix} Latest Quarter": latest,
        f"{prefix} Previous Quarter": previous,
        f"{prefix} 2 Quarters Back": two_back,
        f"{prefix} 3 Quarters Back": three_back,
        f"{prefix} Last Year Quarter": last_year,
        f"QoQ % {prefix} Latest": rounded(calculate_change(latest, previous)),
        f"YoY % {prefix} Latest": rounded(calculate_change(latest, last_year)),
    }


def _has_complete_quarterly_series(source):
    """Require one coherent latest quarter before selecting a statement type."""
    return all(get_value_from_pipe_string((source or {}).get(metric), 0) is not None
               for metric in ("NET_PROFIT", "SALES", "EPS"))


def select_quarterly_statement(consolidated):
    """Use complete ScanX consolidated data only.

    Standalone reports remain visible in raw source data but cannot satisfy a
    consolidated earnings condition.  This avoids a silent change in the
    meaning of scanner results when a company has no group statement.
    """
    if _has_complete_quarterly_series(consolidated):
        return consolidated, "CONSOLIDATED", "SCANX"
    return {}, "UNAVAILABLE", "UNAVAILABLE"


def lakhs(series):
    """ScanX statement amounts are ₹ crore; scanner amount fields are ₹ lakh."""
    value = get_value_from_pipe_string(series, 0)
    return value * 100 if value is not None else None


def published_financial_fields(quarterly, annual, balance):
    assets = get_value_from_pipe_string(balance.get("TOTAL_ASSETS"), 0)
    current = get_value_from_pipe_string(balance.get("CURRENT_ASSETS"), 0)
    current_liab = get_value_from_pipe_string(balance.get("CURRENT_LIABILITIES"), 0)
    non_current_liab = get_value_from_pipe_string(balance.get("NON_CURRENT_LIABILITIES"), 0)
    pbt = get_value_from_pipe_string(annual.get("PROFIT_BEFORE_TAX"), 0)
    interest = get_value_from_pipe_string(annual.get("INTEREST"), 0)
    return {
        "total_revenue_in_lakhs": lakhs(quarterly.get("REVENUE")),
        "non_current_assets_in_lakhs": (assets - current) * 100 if assets is not None and current is not None and assets >= current else None,
        "total_liabilities_in_lakhs": (current_liab + non_current_liab) * 100 if current_liab is not None and non_current_liab is not None else None,
        "interest_coverage": (pbt + interest) / interest if pbt is not None and positive(interest) else None,
        "financial_metadata": {
            "source": "ScanX", "basis": "CONSOLIDATED", "amount_unit": "INR_LAKH",
            "quarter": (quarterly.get("YEAR") or "").split("|")[0] or None,
            "balance_sheet_year": (balance.get("YEAR") or "").split("|")[0] or None,
            "interest_coverage_year": (annual.get("YEAR") or "").split("|")[0] or None,
            "interest_coverage_formula": "(annual profit before tax + interest) / interest",
            "non_current_assets_formula": "total assets - current assets",
            "total_liabilities_formula": "current liabilities + non-current liabilities",
            "debt_to_equity_formula": "ScanX Debt2Eq, otherwise reported total borrowings / total equity",
        },
    }


def valuation_fields(cv, ttm_cy, roce_roe, bs_c, eps_latest, yoy_eps, tech=None):
    roe = get_float(roce_roe.get("ROE"))
    roce = get_float(roce_roe.get("ROCE"))
    pe = get_float(cv.get("STOCK_PE"))

    borrowings = get_value_from_pipe_string(bs_c.get("TOTAL_BORROWINGS"), 0)
    total_equity = get_value_from_pipe_string(bs_c.get("TOTAL_EQUITY"), 0)
    de_ratio = borrowings / total_equity if borrowings is not None and borrowings >= 0 and positive(total_equity) else None
    reported = get_optional_float((tech or {}).get("Debt2Eq"))
    if reported is not None:
        de_ratio = reported

    peg = pe / yoy_eps if positive(yoy_eps) and positive(pe) else None

    forward_pe = None
    if positive(eps_latest) and positive(pe):
        annualized_eps = eps_latest * 4
        ttm_eps = get_float(ttm_cy.get("EPS"))
        if ttm_eps is not None:
            forward_pe = pe * (ttm_eps / annualized_eps)

    return {
        "ROE(%)": roe,
        "ROCE(%)": roce,
        "D/E": de_ratio if reported is not None else rounded(de_ratio),
        "debt_to_equity_source": "SCANX_Debt2Eq" if reported is not None else ("TOTAL_BORROWINGS/TOTAL_EQUITY" if de_ratio is not None else None),
        "OPM TTM(%)": get_float(ttm_cy.get("OPM")),
        "P/E": pe,
        "PEG": rounded(peg),
        "Forward P/E": rounded(forward_pe),
        "Historical P/E 5": None,
    }


def ownership_fields(shp, market_cap_cr, ltp, total_shares):
    fii_latest = get_value_from_pipe_string(shp.get("FII"), 0)
    fii_prev = get_value_from_pipe_string(shp.get("FII"), 1)
    dii_latest = get_value_from_pipe_string(shp.get("DII"), 0)
    dii_prev = get_value_from_pipe_string(shp.get("DII"), 1)

    promoter_history = shp.get("PROMOTER")
    promoter_latest = get_value_from_pipe_string(promoter_history, 0) if promoter_history else None
    free_float_pct = 100.0 - promoter_latest if promoter_latest is not None and promoter_latest >= 0 else None

    total_shares_cr = total_shares / 10_000_000 if positive(total_shares) else None
    if total_shares_cr is None and positive(market_cap_cr) and positive(ltp):
        total_shares_cr = market_cap_cr / ltp
    float_shares_cr = total_shares_cr * (free_float_pct / 100.0) if free_float_pct is not None and total_shares_cr is not None else None

    return {
        "FII % change QoQ": rounded(fii_latest - fii_prev) if None not in (fii_latest, fii_prev) else None,
        "DII % change QoQ": rounded(dii_latest - dii_prev) if None not in (dii_latest, dii_prev) else None,
        "Free Float(%)": round(free_float_pct, 2) if free_float_pct is not None else None,
        "Float Shares(Cr.)": round(float_shares_cr, 2) if float_shares_cr is not None else None,
        "Promoter Holding(%)": rounded(promoter_latest),
        "Public Holding(%)": rounded(get_value_from_pipe_string(shp.get("PUBLIC"), 0)),
        "Number of Shareholders": get_value_from_pipe_string(shp.get("NO_OF_SHARE_HOLDERS"), 0),
    }


def index_memberships(tech):
    """Preserve every current provider membership; historical dates are not implied."""
    indices_found = []
    idx_list_raw = tech.get("idxlist", [])
    if isinstance(idx_list_raw, list):
        for idx_obj in idx_list_raw:
            idx_name = idx_obj.get("Name")
            if idx_name:
                indices_found.append(idx_name)
    return sorted(set(indices_found))


def average_status(items, suffix, ltp):
    signals = []
    for item in items:
        indicator_name = item.get("Indicator", "").replace(suffix, "")
        value = get_float(item.get("Value"))
        if indicator_name in {"20", "50", "200"} and positive(value) and positive(ltp):
            diff = ((ltp - value) / value) * 100
            status = "Above" if diff > 0 else "Below"
            signals.append(f"{suffix.replace('-', '')} {indicator_name}: {status} ({round(diff, 1)}%)")
    return signals


def technical_sentiment(advanced_tech):
    sentiment_summary = []
    for item in advanced_tech.get("TechnicalIndicators", []):
        name = item.get("Indicator", "")
        action = item.get("Action", "")
        if "RSI" in name:
            sentiment_summary.append(f"RSI: {action}")
        elif "MACD" in name:
            sentiment_summary.append(f"MACD: {action}")
    return " | ".join(sentiment_summary)


def classic_pivot(advanced_tech):
    pivots = advanced_tech.get("Pivots", [])
    if pivots and isinstance(pivots, list):
        return pivots[0].get("Classic", {}).get("PP", "N/A")
    return "N/A"


def analyze_stock(item, tech, advanced_tech, listing_date_map, sme_map=None):
    symbol = item.get("Symbol", "UNKNOWN")
    cq, earnings_report_type, earnings_source = select_quarterly_statement(item.get("incomeStat_cq", {}))
    cy = item.get("incomeStat_cy", {})
    ttm_cy = item.get("TTM_cy", {})
    cv = item.get("CV", {})
    roce_roe = item.get("roce_roe", {})
    shp = item.get("sHp", {})
    bs_c = item.get("bs_c", {})
    cf_c = item.get("cF_c", {})

    industry = cv.get("INDUSTRY_NAME", "N/A")
    sector = cv.get("SECTOR", "N/A")
    market_cap_cr = get_float(tech.get("Mcap") or cv.get("MARKET_CAP"))
    ltp = get_float(tech.get("Ltp"))
    total_shares = get_optional_float(tech.get("TotalShares")) or 0.0
    volume = get_optional_float(tech.get("Volume", tech.get("volume")))
    # Missing/zero volume with absent OHLC cannot establish a session close.
    session_close = None if unavailable_session_candle(tech) else ltp
    sme_record = sme_map.get(symbol) if sme_map is not None else None

    net_profit = quarterly_metric_fields("Net Profit", cq, "NET_PROFIT")
    eps = quarterly_metric_fields("EPS", cq, "EPS")
    sales = quarterly_metric_fields("Sales", cq, "SALES")
    opm = quarterly_metric_fields("OPM", cq, "OPM")

    sales_current_annual = get_value_from_pipe_string(cy.get("SALES"), 0)
    sales_5_years_ago = get_value_from_pipe_string(cy.get("SALES"), 5)

    high_52w = get_float(tech.get("High1Yr"))
    pct_from_52w_high = ((ltp - high_52w) / high_52w) * 100 if positive(high_52w) and positive(ltp) else None

    ownership = ownership_fields(shp, market_cap_cr, ltp, total_shares)
    free_float_pct = ownership["Free Float(%)"]

    listing = listing_date_map.get(symbol, {})
    # Keep the public helper compatible with older callers/tests that pass a
    # simple symbol -> listing-date map.
    if not isinstance(listing, dict):
        listing = {"listing_date": listing}

    stock_analysis = {
        "Symbol": symbol,
        "Name": item.get("Name", ""),
        "Listing Date": listing.get("listing_date", "N/A"),
        "ISIN": item.get("ISIN") or item.get("isin"),
        "Security ID": item.get("Sid") or item.get("security_id"),
        "Basic Industry": industry,
        "Sector": sector,
        "Market Cap(Cr.)": market_cap_cr,
        "Latest Quarter": cq.get("YEAR", "").split("|")[0] if cq.get("YEAR") else "N/A",
        "Earnings Report Type": earnings_report_type,
        "Earnings Data Source": earnings_source,
        **net_profit,
        **eps,
        "EPS Last Year": get_value_from_pipe_string(cy.get("EPS"), 0),
        "EPS 2 Years Back": get_value_from_pipe_string(cy.get("EPS"), 1),
        **sales,
        **quarterly_metric_fields("PBT", cq, "PROFIT_BEFORE_TAX"),
        "Sales Growth 5 Years(%)": rounded(calculate_cagr(sales_current_annual, sales_5_years_ago, 5)),
        **opm,
        **valuation_fields(cv, ttm_cy, roce_roe, bs_c, eps["EPS Latest Quarter"], eps["YoY % EPS Latest"], tech),
        **ownership,
        "financial_units_version": 1,
        **published_financial_fields(cq, cy, bs_c),
        # ScanX statement amounts are ₹ crore. Convert them to the advertised
        # ₹ lakh units; retain null when the source amount is missing.
        "EPS TTM": get_float(ttm_cy.get("EPS")),
        "Dividend Yield(%)": get_float(cv.get("DIVIDEND_YEILD")),
        "Face Value": get_float(cv.get("FACE_VALUE")),
        "Total Income(in Lakhs)": lakhs(cq.get("REVENUE")),
        "Total Expense(in Lakhs)": lakhs(cq.get("EXPENSES")),
        "Profit Before Tax(in Lakhs)": lakhs(cq.get("PROFIT_BEFORE_TAX")),
        "Total Tax Expenses(in Lakhs)": lakhs(cq.get("TAX_PAYMENT_ABSOLUTE")),
        "Net Profit(in Lakhs)": lakhs(cq.get("NET_PROFIT")),
        "Total Equity(in Lakhs)": lakhs(bs_c.get("TOTAL_EQUITY")),
        "Total Assets(in Lakhs)": lakhs(bs_c.get("TOTAL_ASSETS")),
        "Current Assets(in Lakhs)": lakhs(bs_c.get("CURRENT_ASSETS")),
        "Current Liabilities(in Lakhs)": lakhs(bs_c.get("CURRENT_LIABILITIES")),
        "Non-Current Liabilities(in Lakhs)": lakhs(bs_c.get("NON_CURRENT_LIABILITIES")),
        "Operating Cash Flow(in Lakhs)": lakhs(cf_c.get("OPERATING_ACTIVITIES")),
        "Investing Cash Flow(in Lakhs)": lakhs(cf_c.get("INVESTING_ACTIVITIES")),
        "Net Cash Flow(in Lakhs)": lakhs(cf_c.get("NET_CASH_FLOW")),
        "% from 52W High": rounded(pct_from_52w_high),
    }

    for tag, (canonical, _public) in SCREEN_METRICS.items():
        stock_analysis[canonical] = stock_analysis["D/E"] if canonical == "debt_to_equity" else get_optional_float(tech.get(tag))
    statement_history = normalize_statement_history(item, item.get("financial_observed_on"))
    stock_analysis["financial_statement_history"] = statement_history
    stock_analysis.update(statement_summary(statement_history))
    # These annual amounts are also available in the fundamental response.
    for canonical, source in (("cwip_crore", "CWIP"), ("fixed_assets_crore", "FIXED_ASSETS"), ("borrowings_crore", "TOTAL_BORROWINGS")):
        if stock_analysis[canonical] is None:
            stock_analysis[canonical] = get_value_from_pipe_string(bs_c.get(source), 0)
    if stock_analysis["financing_cash_flow_crore"] is None:
        stock_analysis["financing_cash_flow_crore"] = get_value_from_pipe_string(cf_c.get("FINANCING_ACTIVITIES"), 0)
    for canonical, source in (("fii_holding_percent", "FII"), ("dii_holding_percent", "DII")):
        if stock_analysis[canonical] is None:
            stock_analysis[canonical] = get_value_from_pipe_string(shp.get(source), 0)

    rsi_14 = get_float(tech.get("DayRSI14CurrentCandle"))
    sma_signals = average_status(advanced_tech.get("SMA", []), "-SMA", ltp)
    ema_signals = average_status(advanced_tech.get("EMA", []), "-EMA", ltp)

    stock_analysis.update(
        {
            "scanner_schema_version": "2.0",
            "Stock Price(₹)": ltp,
            "exchange": tech.get("Exch", "NSE"),
            "instrument": tech.get("Inst", "EQUITY"),
            "segment": tech.get("Seg", "E"),
            "listing_board": "SME" if sme_record else "MAINBOARD" if sme_map is not None else "UNKNOWN",
            "is_sme": True if sme_record else False if sme_map is not None else None,
            "listing_series": sme_record.get("Series") if sme_record else listing.get("series"),
            "close": session_close,
            "open": get_optional_float(tech.get("Open")),
            "high": get_optional_float(tech.get("High")),
            "low": get_optional_float(tech.get("Low")),
            "volume": volume,
            "rupee_volume": round(session_close * volume, 2) if positive(session_close) and volume is not None else None,
            "change_percent": get_optional_float(tech.get("PPerchange")),
            "market_cap_crore": market_cap_cr,
            "shares_outstanding": int(total_shares) if total_shares > 0 else None,
            "share_capital": get_float(tech.get("ShareCapital", 0)) or None,
            "sector": tech.get("Sector") or sector,
            "industry": industry,
            "free_float_percent": free_float_pct,
            "float_shares": round(total_shares * (free_float_pct / 100.0))
            if total_shares > 0 and free_float_pct is not None else None,
            "perf_1w": get_optional_float(tech.get("PricePerchng1week")),
            "perf_1m": get_optional_float(tech.get("PricePerchng1mon")),
            "perf_3m": get_optional_float(tech.get("PricePerchng3mon")),
            "perf_6m": get_optional_float(tech.get("PricePerchng6mon")),
            "perf_12m": get_optional_float(tech.get("PricePerchng1year")),
            "sma10": get_optional_float(tech.get("DaySMA10CurrentCandle")),
            "sma20": get_optional_float(tech.get("DaySMA20CurrentCandle")),
            "sma50": get_optional_float(tech.get("DaySMA50CurrentCandle")),
            "sma200": get_optional_float(tech.get("DaySMA200CurrentCandle")),
            "rsi14": rounded(rsi_14),
            "Index": ", ".join(index_memberships(tech)) or "N/A",
            "Index Memberships": index_memberships(tech),
            "Index Membership As Of": "current_snapshot",
            "1 Day Returns(%)": get_float(tech.get("PPerchange")),
            "1 Week Returns(%)": get_float(tech.get("PricePerchng1week")),
            "1 Month Returns(%)": get_float(tech.get("PricePerchng1mon")),
            "3 Month Returns(%)": get_float(tech.get("PricePerchng3mon")),
            "1 Year Returns(%)": get_float(tech.get("PricePerchng1year")),
            "RSI (14)": rounded(rsi_14),
            "Gap Up %": None,
            "SMA Status": " | ".join(sma_signals),
            "EMA Status": " | ".join(ema_signals),
            "Technical Sentiment": technical_sentiment(advanced_tech),
            "Pivot Point": classic_pivot(advanced_tech),
        }
    )
    return stock_analysis


def analyze_all_stocks():
    print("Loading fundamental data...")
    try:
        data = load_json(FUNDAMENTAL_FILE)
    except FileNotFoundError:
        print(f"Error: {FUNDAMENTAL_FILE} not found.")
        return False

    listing_date_map = load_listing_dates()
    sme_map = load_sme_map()
    dhan_tech_map = map_scan_rows_by_symbol(DHAN_DATA_FILE, "Sym", "technical data", f"Warning: {DHAN_DATA_FILE} not found.")
    advanced_tech_map = map_scan_rows_by_symbol(
        ADVANCED_FILE,
        "Symbol",
        "advanced indicators",
        f"Warning: {ADVANCED_FILE} not found. Running without advanced indicators.",
    )
    # Missing fundamental responses must not silently remove a security.
    fundamental_map = {item['Symbol']: item for item in data if item.get('Symbol')}
    master = load_json(os.path.join(BASE_DIR, 'master_isin_map.json'))
    data = [{**item, **fundamental_map.get(item['Symbol'], {})} for item in master]
    print(f"Analyzing {len(data)} stocks...")
    final_data = [
        analyze_stock(
            item,
            dhan_tech_map.get(item.get("Symbol", "UNKNOWN"), {}),
            advanced_tech_map.get(item.get("Symbol", "UNKNOWN"), {}),
            listing_date_map,
            sme_map,
        )
        for item in data
    ]

    save_json(OUTPUT_FILE, final_data)
    print(f"Successfully saved analysis for {len(final_data)} stocks (filtered from {len(final_data)}) to {OUTPUT_FILE}")
    return True


if __name__ == "__main__":
    sys.exit(0 if analyze_all_stocks() else 1)
