"""Versioned, point-in-time inputs for the local scanner."""

from __future__ import annotations

import gzip
import json
from datetime import date
from pathlib import Path
from tempfile import NamedTemporaryFile

from .earnings import EARNINGS_FIELDS, select_observation
from .shareholding import SHAREHOLDING_FIELDS, select_observation as select_shareholding_observation


SCANNER_SNAPSHOT_FIELDS = (
    "total_revenue_in_lakhs", "non_current_assets_in_lakhs", "total_liabilities_in_lakhs", "interest_coverage", "dividend_per_share_latest", "vwap", "all_time_high", "all_time_low", "return_5y",
    "financial_metadata", "history_metadata", "vwap_as_of_date", "dividend_ex_date", "dividend_basis", "dividend_source_range", "percent_from_ath",
    "symbol", "as_of_date", "close", "market_cap_crore", "free_float_percent",
    "pe_ratio", "latest_earnings_date", "sector", "industry", "circuit_limit",
    "earnings_report_type",
    "listing_date", "listing_series", "delivery_series", "index_memberships",
    "qoq_percent_net_profit_latest", "yoy_percent_net_profit_latest",
    "qoq_percent_sales_latest", "yoy_percent_sales_latest",
    "qoq_percent_pbt_latest", "yoy_percent_pbt_latest",
    "qoq_percent_eps_latest", "yoy_percent_eps_latest",
    "debt_to_equity", "eps_ttm", "promoter_holding_percent", "fii_holding_percent", "dii_holding_percent", "public_holding_percent",
    "number_of_shareholders", "dividend_yield_percent", "face_value",
    "total_income_in_lakhs", "total_expense_in_lakhs", "profit_before_tax_in_lakhs",
    "total_tax_expenses_in_lakhs", "net_profit_in_lakhs", "total_equity_in_lakhs",
    "total_assets_in_lakhs", "current_assets_in_lakhs", "current_liabilities_in_lakhs",
    "non_current_liabilities_in_lakhs", "operating_cash_flow_in_lakhs",
    "investing_cash_flow_in_lakhs", "net_cash_flow_in_lakhs",
)


def _write_gzip_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with gzip.open(temporary, "wt", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def build_snapshot(cache_dir: Path, stocks: list[dict], breadth: dict, fno_ban: dict, as_of_date: str,
                   earnings_observations=None, shareholding_observations=None) -> Path:
    """Persist only fields that influence scanner conditions for one session."""
    session = date.fromisoformat(as_of_date).isoformat()
    record = next((item for item in breadth.get("records", []) if item.get("date") == session), None)
    breadth_universes = {}
    for key, payload in (breadth.get("universes") or {}).items():
        candidate = next((item for item in payload.get("records", []) if item.get("date") == session), None)
        if candidate: breadth_universes[key] = candidate
    snapshot_stocks = []
    for stock in stocks:
        if not stock.get("symbol"):
            continue
        item = {field: stock.get(field) for field in SCANNER_SNAPSHOT_FIELDS}
        observation = select_observation(earnings_observations or [], stock["symbol"], session)
        if observation:
            # The selected values are now truly date-bounded, even if the
            # current provider snapshot has advanced to a newer quarter.
            item.update({field: observation.get(field) for field in EARNINGS_FIELDS})
            item["latest_earnings_date"] = observation["announcement_date"]
            item["earnings_observed_on"] = observation.get("observed_on")
        holding = select_shareholding_observation(shareholding_observations or [], stock["symbol"], session)
        if holding:
            item.update({field: holding.get(field) for field in SHAREHOLDING_FIELDS.values()})
            promoter = holding.get("promoter_holding_percent")
            if isinstance(promoter, (int, float)) and 0 <= promoter <= 100:
                item["free_float_percent"] = 100.0 - promoter
            item["shareholding_period_end"] = holding["period_end"]
            item["shareholding_observed_on"] = holding["observed_on"]
        snapshot_stocks.append(item)
    payload = {
        "schema_version": 4,
        "as_of_date": session,
        "stocks": snapshot_stocks,
        "breadth": record,
        "breadth_universes": breadth_universes,
        "fno_ban": {
            "available": bool(fno_ban.get("available")),
            "trade_date": fno_ban.get("trade_date"),
            "symbols": fno_ban.get("symbols", []),
        },
    }
    path = cache_dir / f"{session}.json.gz"
    _write_gzip_json(path, payload)
    return path


def load_snapshot(cache_dir: Path, as_of_date: str | None) -> dict | None:
    if not as_of_date:
        return None
    path = cache_dir / f"{as_of_date}.json.gz"
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return None
    return payload if payload.get("as_of_date") == as_of_date else None
