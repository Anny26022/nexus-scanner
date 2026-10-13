"""Publish quarterly fundamentals with independently verified filing references.

ScanX's fundamental response supplies the numeric quarterly series while its
LODR/company-filings feeds supply the time a result was disclosed.  Neither
source alone proves when current numeric revisions became public. Keep numeric
quarters even when a result disclosure cannot be verified. The statement type is
kept explicit: a standalone figure never silently substitutes for a missing
consolidated figure.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from pipeline_utils import BASE_DIR, load_json, save_json
from edl_pipeline.scanner.financials import normalize_statement_history


RESULT_TERMS = ("financial results", "financial result", "unaudited financial", "audited financial")
DATE_PATTERNS = (
    re.compile(r"(?:quarter|quarterly|results?).{0,120}?(?:ended|ending)\s*(?:on\s*)?"
               r"([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2})", re.I),
    re.compile(r"(?:ended|ending)\s*(?:on\s*)?"
               r"([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2})", re.I),
)


def _quarter_end(text: str) -> str | None:
    for pattern in DATE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        value = re.sub(r"\s+", " ", match.group(1).replace(",", " ")).strip()
        for fmt in ("%B %d %Y", "%b %d %Y", "%d %B %Y", "%d %b %Y", "%Y-%m-%d"):
            try:
                return datetime.strptime(value, fmt).date().isoformat()
            except ValueError:
                pass
    return None


def _is_result(filing: dict) -> bool:
    text = " ".join(str(filing.get(key) or "") for key in ("descriptor", "caption", "news_body")).lower()
    title = " ".join(str(filing.get(key) or "") for key in ("descriptor", "caption")).lower()
    excluded = ("trading window", "intimation", "newspaper", "presentation", "conference call",
                "earnings call", "notice of board", "board meeting notice", "will consider",
                "to consider", "scheduled to", "proposes to", "prior intimation")
    if any(term in title for term in excluded) or not any(term in text for term in RESULT_TERMS):
        return False
    if "outcome" in title:
        return re.search(r"\b(?:approved|adopted|taken on record)\b", text) is not None
    return any(term in title for term in RESULT_TERMS)


def _filing_candidates(filings: list[dict]) -> dict[tuple[str, str], list[dict]]:
    """Keep actual disclosures by quarter/basis; multiple documents are ambiguous."""
    candidates = defaultdict(list)
    seen = set()
    for filing in sorted((row for row in filings if isinstance(row, dict)),
                         key=lambda row: str(row.get("news_date") or "")):
        if not _is_result(filing):
            continue
        text = " ".join(str(filing.get(key) or "") for key in ("descriptor", "caption", "news_body"))
        quarter_end = _quarter_end(text)
        published = str(filing.get("news_date") or "")
        try:
            disclosed = datetime.fromisoformat(published.replace("Z", "+00:00")).date()
        except ValueError:
            continue
        if not quarter_end or disclosed.isoformat() < quarter_end:
            continue
        # LODR and the legacy feed frequently expose the same attachment under
        # different ids.  Its URL is the strongest available duplicate key.
        key = str(filing.get("file_url") or "").strip() or (quarter_end, published[:10], text[:160])
        if key in seen:
            continue
        seen.add(key)
        # A shared quarter/date does not prove the PDF contains both statements.
        for basis in ("CONSOLIDATED", "STANDALONE"):
            if basis.lower() in text.lower() and str(filing.get("file_url") or "").startswith("https://"):
                candidates[quarter_end, basis].append(filing)
    return candidates


def main() -> int:
    root = Path(BASE_DIR)
    fundamentals = load_json(root / "fundamental_data.json", default=[])
    filing_cache = load_json(root / "filing_history_data" / "filing_history.json", default={})
    symbols = filing_cache.get("symbols", {}) if isinstance(filing_cache, dict) else {}
    if not isinstance(fundamentals, list) or not isinstance(symbols, dict):
        print("Cannot build quarterly financial ledger without fundamentals and filing history.")
        return 1

    records = []
    unmatched_quarters = 0
    for item in fundamentals:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("Symbol") or "").upper()
        filing_entry = symbols.get(symbol, {})
        matches = _filing_candidates(filing_entry.get("filings", []) if isinstance(filing_entry, dict) else [])
        history = normalize_statement_history(item, item.get("financial_observed_on"))
        for report_type, statement in (("CONSOLIDATED", history),
                                       ("STANDALONE", history.get("standalone", {}))):
            for row in statement.get("quarterly", []):
                quarter_end = row["period_end"]
                candidates = matches.get((quarter_end, report_type), [])
                # Prefer a results filing over its accompanying board outcome.
                primary = [candidate for candidate in candidates
                           if "outcome" not in " ".join(str(candidate.get(key) or "")
                               for key in ("descriptor", "caption")).lower()]
                primary = primary or candidates
                filing = primary[0] if len(primary) == 1 else {}
                if not filing:
                    unmatched_quarters += 1
                values = {key: value for key, value in row.items() if key != "period_end"}
                if all(value is None for value in values.values()):
                    continue
                records.append({
                    "symbol": symbol,
                    "isin": item.get("isin") or item.get("ISIN"),
                    "quarter_end": quarter_end,
                    "filing_date": filing.get("news_date"),
                    "report_type": report_type,
                    **values,
                    "filing_descriptor": filing.get("descriptor"),
                    "filing_caption": filing.get("caption"),
                    "filing_url": filing.get("file_url"),
                    "result_disclosures": [{"date": candidate.get("news_date"),
                                            "url": candidate.get("file_url"),
                                            "caption": candidate.get("caption")}
                                           for candidate in candidates],
                    "observed_on": history["observed_on"],
                    "amount_unit": "INR_CRORE",
                    "metric_units": history["metric_units"],
                    "numeric_source": "ScanX fundamental quarterly statement",
                    "filing_source": "ScanX LODR/company_filings",
                })

    records.sort(key=lambda row: (row["symbol"], row["quarter_end"], row["report_type"]))
    coverage = {
        "symbols_with_rows": len({row["symbol"] for row in records}),
        "records": len(records),
        "consolidated_records": sum(row["report_type"] == "CONSOLIDATED" for row in records),
        "standalone_records": sum(row["report_type"] == "STANDALONE" for row in records),
        "unmatched_numeric_quarters": unmatched_quarters,
    }
    save_json(root / "quarterly_financial_history.json", {
        "schema_version": 2,
        "source": "ScanX quarterly statements joined to dated ScanX LODR/company-filings disclosures",
        "temporal_contract": "Filing dates are source disclosure timestamps. Numeric values are current provider series matched by quarter; consumers must not back-project them without accepting that source-observation limitation.",
        "coverage": coverage,
        "records": records,
    }, ensure_ascii=False)
    print(f"Published {len(records)} quarterly financial rows for {coverage['symbols_with_rows']} symbols; "
          f"{unmatched_quarters} without an unambiguous result disclosure.")
    # Filing metadata can be present before a result notice has a parseable
    # quarter end.  Publish that coverage state instead of failing an otherwise
    # healthy market-data refresh.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
