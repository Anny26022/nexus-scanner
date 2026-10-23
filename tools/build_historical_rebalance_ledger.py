#!/usr/bin/env python3
"""Build and maintain audited historical index reconstitution ledger from official NSE circulars.

Extracts point-in-time inclusions and exclusions across broad benchmark and
sectoral/thematic indices from October 2021 through 2026.
"""

from datetime import datetime
import io
import json
import os
from pathlib import Path
import re
from urllib.request import Request, urlopen

import pypdf

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_FILE = REPO_ROOT / "reference" / "historical_index_rebalance_events.json"
CACHE_DIR = Path.home() / ".scanner_cache" / "rebalance_circulars"

# Official circular documents from niftyindices.com
CIRCULARS = [
    {"file": "ind_prs15092021.pdf", "default_date": "2021-09-30"},
    {"file": "ind_prs20092021.pdf", "default_date": "2021-09-30"},
    {"file": "ind_prs24022022_1.pdf", "default_date": "2022-03-31"},
    {"file": "ind_prs08032022.pdf", "default_date": "2022-03-31"},
    {"file": "ind_prs01092022.pdf", "default_date": "2022-09-30"},
    {"file": "ind_prs16092022.pdf", "default_date": "2022-09-30"},
    {"file": "ind_prs17022023_1.pdf", "default_date": "2023-03-31"},
    {"file": "ind_prs06032023.pdf", "default_date": "2023-03-31"},
    {"file": "ind_prs17082023.pdf", "default_date": "2023-09-29"},
    {"file": "ind_prs15092023.pdf", "default_date": "2023-09-29"},
    {"file": "ind_prs28022024.pdf", "default_date": "2024-03-28"},
    {"file": "ind_prs14032024.pdf", "default_date": "2024-03-28"},
    {"file": "ind_prs19032024.pdf", "default_date": "2024-03-28"},
    {"file": "ind_prs23082024.pdf", "default_date": "2024-09-30"},
    {"file": "ind_prs23092024.pdf", "default_date": "2024-09-30"},
    {"file": "ind_prs25092024.pdf", "default_date": "2024-09-30"},
    {"file": "ind_prs21022025.pdf", "default_date": "2025-03-28"},
    {"file": "ind_prs13032025.pdf", "default_date": "2025-03-28"},
    {"file": "ind_prs22082025.pdf", "default_date": "2025-03-30"},
    {"file": "ind_prs15092025.pdf", "default_date": "2025-09-30"},
    {"file": "ind_prs23022026.pdf", "default_date": "2026-03-30"},
    {"file": "ind_prs12032026.pdf", "default_date": "2026-03-30"},
    {"file": "ind_prs10082026.pdf", "default_date": "2026-09-30"},
    {"file": "ind_prs15092026.pdf", "default_date": "2026-09-30"},
]

# Manual corporate action events not covered in semi-annual review circulars
AD_HOC_EVENTS = [
    {
        "date": "2023-07-13",
        "index": "NIFTY 50",
        "inclusions": ["LTIM"],
        "exclusions": ["HDFC"],
        "remarks": "HDFC Ltd. merger into HDFC Bank Ltd.",
    },
    {
        "date": "2021-09-30",
        "index": "NIFTY 50",
        "inclusions": [],
        "exclusions": [],
        "remarks": "No reconstitution changes in NIFTY 50 in Sep 2021 review",
    },
]

STOPWORDS = {
    "AND",
    "THE",
    "LTD",
    "CORP",
    "COMPANY",
    "INC",
    "NOTE",
    "NOTES",
    "SR",
    "NO",
    "SYMBOL",
    "NAME",
    "INDEX",
    "INDICES",
    "OF",
    "IN",
    "IS",
    "ARE",
}


def get_pdf_bytes(filename: str) -> bytes:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    local_path = CACHE_DIR / filename
    if local_path.exists() and local_path.stat().st_size > 0:
        return local_path.read_bytes()

    url = f"https://www.niftyindices.com/Press_Release/{filename}"
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    with urlopen(req, timeout=20) as resp:
        data = resp.read()

    local_path.write_bytes(data)
    return data


def canonical_index_name(raw: str) -> str:
    s = re.sub(r"[\*\#\^\$]", "", raw)
    s = re.sub(r"^(?:[0-9]+|[a-zA-Z])[\.\)]\s*", "", s)
    s = s.strip().upper()

    mapping = {
        "NIFTY HEALTHCARE INDEX": "NIFTY HEALTHCARE",
        "NIFTY MIDCAP SELECT INDEX": "NIFTY MIDCAP SELECT",
        "NIFTY SME EMERGE INDEX": "NIFTY SME EMERGE",
        "NIFTY FINANCIAL SERVICES 25/50 INDEX": "NIFTY FINANCIAL SERVICES 25/50",
        "NIFTY FINANCIAL SERVICES EX-BANK": "NIFTY FINANCIAL SERVICES EX-BANK",
        "NIFTY MIDSMALL FINANCIAL": "NIFTY MIDSMALL FINANCIAL SERVICES",
        "NIFTY MIDSMALL INDIA": "NIFTY MIDSMALL INDIA CONSUMPTION",
        "NIFTY TATA GROUP": "NIFTY INDIA CORPORATE GROUP INDEX - TATA GROUP",
        "NIFTY TATA GROUP 25% CAP": "NIFTY INDIA CORPORATE GROUP INDEX - TATA GROUP 25% CAP",
    }
    return mapping.get(s, s)


def parse_date_str(date_text: str) -> str:
    date_text = date_text.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date_text):
        return date_text
    try:
        dt = datetime.strptime(date_text, "%B %d, %Y")
        return dt.strftime("%Y-%m-%d")
    except Exception:
        pass
    try:
        dt = datetime.strptime(date_text, "%B %d %Y")
        return dt.strftime("%Y-%m-%d")
    except Exception:
        pass
    return date_text


def parse_circular(filename: str, default_date: str) -> tuple[str, list[dict]]:
    data = get_pdf_bytes(filename)
    reader = pypdf.PdfReader(io.BytesIO(data))
    full_text = "\n".join(p.extract_text() or "" for p in reader.pages)

    m_eff = re.search(
        r"effective\s+(?:from|w\.e\.f\.?)\s+([A-Za-z]+ \d{1,2}, \d{4})", full_text, re.I
    )
    eff_date = parse_date_str(m_eff.group(1)) if m_eff else default_date

    pattern = r"(?:\n\s*(?:[0-9]+|[a-zA-Z])[\.\)]\s*(Nifty[^\n\r]+))"
    splits = list(re.finditer(pattern, full_text, re.I))

    events = []
    for i, m in enumerate(splits):
        idx_raw = m.group(1).strip()
        idx_name = canonical_index_name(idx_raw)
        start = m.end()
        end = splits[i + 1].start() if i + 1 < len(splits) else len(full_text)
        block = full_text[start:end]

        # Stop parsing table before footnotes, notes, or next section markers
        delim = r"(?=The following compan|\n\s*Note:|\n\s*Notes:|\n\s*About\s+|\Z)"
        exc_match = re.search(
            rf"compan(?:y|ies)\s+(?:is|are)\s+being\s+excluded:?(.*?){delim}",
            block,
            re.I | re.S,
        )
        inc_match = re.search(
            rf"compan(?:y|ies)\s+(?:is|are)\s+being\s+included:?(.*?){delim}",
            block,
            re.I | re.S,
        )

        exclusions = []
        if exc_match:
            for line in exc_match.group(1).strip().splitlines():
                parts = line.strip().split()
                if len(parts) >= 3 and parts[0].rstrip(".").isdigit():
                    sym = parts[-1].strip().upper()
                    if sym not in STOPWORDS and re.match(r"^[A-Z][A-Z0-9\-]{1,19}$", sym):
                        exclusions.append(sym)

        inclusions = []
        if inc_match:
            for line in inc_match.group(1).strip().splitlines():
                parts = line.strip().split()
                if len(parts) >= 3 and parts[0].rstrip(".").isdigit():
                    sym = parts[-1].strip().upper()
                    if sym not in STOPWORDS and re.match(r"^[A-Z][A-Z0-9\-]{1,19}$", sym):
                        inclusions.append(sym)

        if exclusions or inclusions:
            events.append(
                {
                    "date": eff_date,
                    "index": idx_name,
                    "inclusions": sorted(list(set(inclusions))),
                    "exclusions": sorted(list(set(exclusions))),
                    "source_file": filename,
                }
            )

    return eff_date, events


def build_ledger() -> dict:
    aggregated: dict[tuple[str, str], dict] = {}

    for c in CIRCULARS:
        eff_date, events = parse_circular(c["file"], c["default_date"])
        for ev in events:
            key = (ev["date"], ev["index"])
            if key not in aggregated:
                aggregated[key] = {
                    "date": ev["date"],
                    "index": ev["index"],
                    "inclusions": set(ev["inclusions"]),
                    "exclusions": set(ev["exclusions"]),
                    "sources": [ev["source_file"]],
                }
            else:
                aggregated[key]["inclusions"].update(ev["inclusions"])
                aggregated[key]["exclusions"].update(ev["exclusions"])
                aggregated[key]["sources"].append(ev["source_file"])

    for ad in AD_HOC_EVENTS:
        key = (ad["date"], ad["index"])
        if key not in aggregated:
            aggregated[key] = {
                "date": ad["date"],
                "index": ad["index"],
                "inclusions": set(ad["inclusions"]),
                "exclusions": set(ad["exclusions"]),
                "sources": [ad.get("remarks", "ad-hoc corporate action")],
            }
        else:
            aggregated[key]["inclusions"].update(ad["inclusions"])
            aggregated[key]["exclusions"].update(ad["exclusions"])

    final_rebalances = []
    for (d, idx), item in sorted(aggregated.items(), key=lambda x: (x[0][0], x[0][1])):
        inc = sorted(list(item["inclusions"]))
        exc = sorted(list(item["exclusions"]))
        if not inc and not exc:
            continue
        final_rebalances.append(
            {
                "date": d,
                "index": idx,
                "inclusions": inc,
                "exclusions": exc,
            }
        )

    return {
        "schema_version": 1,
        "description": "Audited point-in-time NSE broad benchmark, sectoral, and thematic reconstitution ledger (2021-2026)",
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "total_events": len(final_rebalances),
        "rebalances": final_rebalances,
    }


def main():
    ledger = build_ledger()
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2)

    print(f"Successfully generated {len(ledger['rebalances'])} index rebalance events.")
    print(f"Output written to: {OUTPUT_FILE}")

    by_index = {}
    for ev in ledger["rebalances"]:
        by_index[ev["index"]] = by_index.get(ev["index"], 0) + 1

    print("\nSummary of events per index:")
    for idx, count in sorted(by_index.items(), key=lambda x: -x[1])[:25]:
        print(f"  {idx:<35}: {count} rebalance events")


if __name__ == "__main__":
    main()
