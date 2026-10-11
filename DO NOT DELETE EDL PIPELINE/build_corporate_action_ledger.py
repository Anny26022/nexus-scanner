"""Publish official NSE corporate actions as a traceable event ledger."""

import os
import sys
import re
from decimal import Decimal

from pipeline_utils import BASE_DIR, load_json, save_json


NSE_ACTIONS_FILE = os.path.join(BASE_DIR, "nse_corporate_actions.json")
OUTPUT_FILE = os.path.join(BASE_DIR, "corporate_action_ledger.json")


def dividend_amount(details):
    """Parse explicit rupees per share only. Ambiguous/percentage declarations stay null."""
    text = str(details or "")
    currency = r"(?:rs\.?|re\.?|inr|₹|rupees)"
    # A malformed double marker ("Rs Re 1") is not an unambiguous amount.
    if re.search(rf"(?<![a-z]){currency}\s+{currency}(?![a-z])", text, re.I):
        return None
    amounts = re.findall(rf"(?<![a-z]){currency}\s*-?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:/-)?\s*(?:per|each)\s*(?:equity\s+)?share", text, re.I)
    if len(amounts) != 1:
        return None
    value = Decimal(amounts[0])
    return float(value) if value > 0 else None


def build_ledger(actions):
    """Keep NSE source detail and apply factors only when they are deterministic."""
    records = []
    seen = set()
    for action in actions:
        symbol = action.get("symbol") or action.get("Symbol")
        categories = action.get("categories") or [str(action.get("Type") or "").lower()]
        action_type = ",".join(sorted(category.upper() for category in categories if category))
        ex_date = action.get("exDate") or action.get("ExDate")
        record_date = action.get("recordDate") or action.get("RecordDate")
        details = action.get("subject") or action.get("Details")
        key = (symbol, action_type, ex_date, record_date, details)
        if not symbol or not ex_date or key in seen:
            continue
        seen.add(key)
        adjustment = action.get("adjustment") or {}
        mode = adjustment.get("mode", "manual-review")
        price_factor = adjustment.get("priceFactor") if mode == "deterministic" else None
        share_factor = adjustment.get("shareFactor") if mode == "deterministic" else None
        dividend = dividend_amount(details) if "DIVIDEND" in action_type else None
        records.append({
            "symbol": symbol,
            "name": action.get("company") or action.get("Name"),
            "action_type": action_type,
            "ex_date": ex_date,
            "record_date": record_date,
            "source_details": details,
            "dividend_per_share": dividend,
            "dividend_parse_status": "explicit_per_share" if dividend is not None else "unavailable",
            "isin": action.get("isin"),
            "adjustment_mode": mode,
            "affects_price": mode in {"deterministic", "manual-review"},
            "adjustment_factor": price_factor,
            "share_factor": share_factor,
            "adjustment_status": "verified" if mode == "deterministic" else mode,
        })
    return sorted(records, key=lambda row: (row["ex_date"], row["symbol"], row["action_type"]))


def main():
    try:
        source = load_json(NSE_ACTIONS_FILE)
    except FileNotFoundError:
        print(f"Error: {NSE_ACTIONS_FILE} is missing.")
        return False
    actions = source.get("actions") if isinstance(source, dict) else None
    if not isinstance(actions, list):
        print("Error: official NSE corporate-action source has no actions list.")
        return False
    ledger = {
        "source": source.get("source", "NSE corporate actions"),
        "range": source.get("range"),
        "price_adjusted": False,
        "records": build_ledger(actions),
    }
    save_json(OUTPUT_FILE, ledger, ensure_ascii=False)
    print(f"Saved {len(ledger['records'])} corporate-action ledger records.")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
