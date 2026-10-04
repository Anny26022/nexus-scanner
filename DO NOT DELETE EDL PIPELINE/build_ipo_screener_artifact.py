"""Publish an NSE mainboard IPO catalogue with permitted provider enrichment.

NSE listing dates and canonical stock identity remain authoritative. The provider
fills issue and subscription facts only when its matching record is
available; unavailable inputs remain null rather than being inferred.
"""

from __future__ import annotations

import csv
from datetime import date, datetime
from pathlib import Path

from pipeline_utils import BASE_DIR, load_json, save_json


def _clean_row(row):
    return {str(key).strip(): value for key, value in row.items()}


def _listing_date(value):
    if not value:
        return None
    text = str(value).strip()
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        pass
    for pattern in ("%d-%b-%Y", "%Y-%m-%d", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            pass
    return None


def _reference_session(root: Path):
    path = root / "indices_ohlcv_data" / "NIFTY.csv"
    if not path.exists():
        return None
    with path.open(newline="", encoding="utf-8") as handle:
        dates = [_listing_date(row.get("Date")) for row in csv.DictReader(handle)]
    return max((item for item in dates if item), default=None)


def _provider_by_symbol(payload):
    by_symbol = {}
    rows = sorted(payload.get("records", []), key=lambda row: str(row.get("listing_date_iso") or ""), reverse=True)
    for row in rows:
        if row.get("symbol") and str(row.get("exchange") or "").upper() == "NSE" \
                and str(row.get("ipo_type") or "").upper() == "MAINBOARD":
            by_symbol.setdefault(str(row["symbol"]).upper(), row)
    return by_symbol


def _provider_details_by_symbol(payload):
    details = payload.get("details", {})
    by_symbol = {}
    rows = sorted(payload.get("records", []), key=lambda row: str(row.get("listing_date_iso") or ""), reverse=True)
    for row in rows:
        if row.get("symbol") and row.get("id") and str(row.get("exchange") or "").upper() == "NSE" \
                and str(row.get("ipo_type") or "").upper() == "MAINBOARD":
            by_symbol.setdefault(str(row["symbol"]).upper(), details.get(str(row["id"]), {}).get("data"))
    return by_symbol


def _provider_payload(root: Path):
    payload = load_json(root / "ipo_provider_data.json", default={})
    return payload if isinstance(payload, dict) else {}


def _provider_catalogue_data(payload):
    """Keep every fetched provider field in the compressed IPO catalogue."""
    if not payload:
        return {"available": False, "listed_archive": [], "feeds": {}, "analytics": {}, "details": {}, "errors": []}
    return {
        "schema_version": payload.get("schema_version"),
        "source": payload.get("source"),
        "available": bool(payload.get("available")),
        "recent_feed_available": bool(payload.get("recent_feed_available")),
        "fetched_at": payload.get("fetched_at"),
        "listed_archive": payload.get("records", []),
        "feeds": payload.get("feeds", {}),
        "analytics": payload.get("analytics", {}),
        "details": payload.get("details", {}),
        "errors": payload.get("errors", []),
    }


def _anchor_lockins_by_symbol(payload):
    """Group provider lock-in events by listed symbol for catalogue rows."""
    lockins = {}
    analytics = payload.get("analytics", {}) if isinstance(payload, dict) else {}
    for name in ("lockin_upcoming", "lockin_recent"):
        feed = analytics.get(name, {})
        for item in feed.get("items", []) if isinstance(feed, dict) else []:
            if not isinstance(item, dict) or not item.get("symbol"):
                continue
            lockins.setdefault(str(item["symbol"]).upper(), []).append(item)
    return lockins


def build_ipo_catalog(stocks, equity_rows, as_of_date, provider=None, provider_details=None, anchor_lockins=None):
    """Join NSE EQ listings to scanner-eligible canonical securities."""
    canonical = {
        str(item.get("symbol", "")).upper(): item
        for item in stocks
        if item.get("symbol") and item.get("default_screener_eligible") is not False
    }
    records, pending = [], []
    for raw in equity_rows:
        row = _clean_row(raw)
        symbol = str(row.get("SYMBOL") or "").strip().upper()
        listed = _listing_date(row.get("DATE OF LISTING"))
        if not symbol or str(row.get("SERIES") or "").strip().upper() != "EQ" or listed is None:
            continue
        if as_of_date and listed > as_of_date:
            continue
        stock = canonical.get(symbol)
        if stock is None:
            pending.append({"symbol": symbol, "listing_date": listed.isoformat(), "reason": "pending_canonical_enrichment"})
            continue
        provider_issue = (provider or {}).get(symbol, {})
        provider_issue_details = (provider_details or {}).get(symbol)
        if provider_issue and _listing_date(provider_issue.get("listing_date_iso")) != listed:
            provider_issue = {}
            provider_issue_details = None
        lockin_calendar = [
            item for item in (anchor_lockins or {}).get(symbol, [])
            if _listing_date(item.get("listing_date")) == listed
        ]
        upcoming_unlock_dates = sorted(
            unlock.isoformat() for item in lockin_calendar
            if as_of_date and (unlock := _listing_date(item.get("unlock_date"))) and unlock >= as_of_date
        )
        records.append({
            "symbol": symbol, "name": stock.get("name"), "isin": stock.get("isin"),
            "security_id": stock.get("security_id"), "listing_date": listed.isoformat(),
            "listing_age_calendar_days": (as_of_date - listed).days if as_of_date else None,
            "close": stock.get("close"), "market_cap_crore": stock.get("market_cap_crore"),
            "sector": stock.get("sector"), "industry": stock.get("industry"),
            "rupee_volume": stock.get("rupee_volume"), "delivery_percent": stock.get("delivery_percent"),
            # Missing provider values remain null; no issue fact is derived
            # from market prices or OHLCV.
            "issue_price": provider_issue.get("price_band_high"),
            "offer_structure": {
                "issue_size_crore": provider_issue.get("issue_size_cr"),
                "fresh_issue_crore": provider_issue.get("fresh_issue_cr"),
                "offer_for_sale_crore": provider_issue.get("ofs_cr"),
            } if provider_issue else None,
            "retail_subscription_multiple": provider_issue.get("retail_subscription"),
            "institutional_subscription_multiple": provider_issue.get("qib_subscription"),
            # Provider lock-in feeds are rolling windows, not a complete
            # lifetime schedule, so their furthest date is not an "end" date.
            "anchor_lock_in_end": None,
            "anchor_lock_in_calendar": lockin_calendar or None,
            "next_anchor_lock_in_date": upcoming_unlock_dates[0] if upcoming_unlock_dates else None,
            "provider": {
                "id": provider_issue.get("id"),
                "listing_price": provider_issue.get("listing_price"),
                "listing_gain_percent": provider_issue.get("listing_gain_pct"),
                "total_subscription_multiple": provider_issue.get("total_subscription"),
                "nii_subscription_multiple": provider_issue.get("nii_subscription"),
                "gmp": provider_issue.get("gmp"),
                "gmp_percent": provider_issue.get("gmp_pct"),
                "details": provider_issue_details,
            } if provider_issue else None,
        })
    return sorted(records, key=lambda item: (item["listing_date"], item["symbol"]), reverse=True), sorted(pending, key=lambda item: item["symbol"])


def main():
    root = Path(BASE_DIR)
    listing_path = root / "nse_equity_list.csv"
    if not listing_path.exists():
        print("NSE listing-date CSV is unavailable.")
        return 1
    stocks = load_json(root / "all_stocks_fundamental_analysis.json", default=[])
    as_of = _reference_session(root)
    if not stocks:
        print("Canonical stock artifact is unavailable.")
        return 1
    if as_of is None:
        print("NIFTY reference session is unavailable.")
        return 1
    provider_payload = _provider_payload(root)
    provider = _provider_by_symbol(provider_payload)
    provider_details = _provider_details_by_symbol(provider_payload)
    anchor_lockins = _anchor_lockins_by_symbol(provider_payload)
    with listing_path.open(newline="", encoding="utf-8-sig") as handle:
        records, pending = build_ipo_catalog(stocks, csv.DictReader(handle), as_of, provider, provider_details, anchor_lockins)
    save_json(root / "ipo_screener.json", {
        "schema_version": 2,
        "source": "NSE EQUITY_L.csv joined to the canonical mainboard scanner universe; permitted provider enrichment when available",
        "as_of_date": as_of.isoformat(),
        "records": records,
        "provider_data": _provider_catalogue_data(provider_payload),
        "pending_canonical_enrichment": pending,
        "capabilities": {
            "listing_date_filter": True,
            "normal_scanner_conditions": True,
            "issue_terms": bool(provider),
            "subscription_multiples": bool(provider),
            "anchor_lock_in": bool(anchor_lockins),
            "provider_issue_details": any(provider_details.values()),
        },
    }, ensure_ascii=False)
    print(f"Published {len(records)} canonical EQ listings; {len(pending)} await enrichment.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
