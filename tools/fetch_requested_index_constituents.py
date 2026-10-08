#!/usr/bin/env python3
"""Build a standalone snapshot of the requested NSE index constituents.

The pipeline invokes this isolated utility without consuming its output in
scanner or publication artifacts. It reads the saved requested-index reference,
discovers official index pages, and writes a mapping under ``reference/``.
"""

from __future__ import annotations

import csv
import gzip
import html
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from difflib import SequenceMatcher
from io import StringIO
from urllib.parse import quote
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "INDEX_UNIVERSE_REFERENCE.md"
OUTPUT = ROOT / "reference" / "index-constituent-mappings.json.gz"
MANIFEST = ROOT / "reference" / "index-constituent-mappings.manifest.json"
BASE = "https://www.niftyindices.com"
SEED_PAGE = BASE + "/indices/equity/broad-based-indices/nifty-smallcap-500"
USER_AGENT = "Mozilla/5.0 (compatible; NexusScannerIndexReference/1.0)"
LEGACY_PUBLIC_DOWNLOADS = {
    "niftyauto": BASE + "/IndexConstituent/ind_niftyautolist.csv",
    "niftybank": BASE + "/IndexConstituent/ind_niftybanklist.csv",
}
PAGE_ALIASES = {
    "niftyadityabirlagroup": "Nifty India Corporate Group Index - Aditya Birla Group",
    "niftymahindragroup": "Nifty India Corporate Group Index - Mahindra Group",
    "niftytatagroup": "Nifty India Corporate Group Index - Tata Group",
    "niftytatagroup25cap": "NIFTY INDIA CORPORATE GROUP INDEX - TATA GROUP 25% CAP",
}


def request(url: str) -> tuple[bytes, dict[str, str]]:
    headers = {"User-Agent": USER_AGENT, "Referer": BASE + "/"}
    with urlopen(Request(url, headers=headers), timeout=30) as response:
        return response.read(), dict(response.headers.items())


def key(value: str) -> str:
    value = value.lower().replace("&", "and")
    value = re.sub(r"\bindex\b", "", value)
    return re.sub(r"[^a-z0-9]+", "", value)


def requested_indices() -> list[dict[str, object]]:
    rows = []
    for line in REFERENCE.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"\| (.*?) \| (.*?) \|", line)
        if not match or match.group(1) == "Index":
            continue
        count = match.group(2)
        rows.append({
            "requested_name": match.group(1),
            "observed_constituent_count": int(count) if count.isdigit() else None,
        })
    return rows


def catalogue() -> list[dict[str, str]]:
    body, _ = request(SEED_PAGE)
    rows = re.findall(r'<li id="HiddenFieldindices" rel="([^"]+)">(.*?)</li>', body.decode("utf-8", "replace"))
    return [{"official_name": html.unescape(name).strip(), "page_url": BASE + path} for path, name in rows]


def choose_page(item: dict[str, object], pages: list[dict[str, str]]) -> dict[str, str] | None:
    wanted = key(str(item["requested_name"]))
    alias = PAGE_ALIASES.get(wanted)
    if alias:
        return next((page for page in pages if page["official_name"] == alias), None)
    exact = [page for page in pages if key(page["official_name"]) == wanted]
    if exact:
        return exact[0]
    required_tokens = set(re.findall(r"[a-z0-9]+", str(item["requested_name"]).lower())) - {"nifty", "index"}
    scored = sorted(
        ((SequenceMatcher(None, wanted, key(page["official_name"])).ratio(), page) for page in pages),
        reverse=True,
        key=lambda candidate: candidate[0],
    )
    if not scored or scored[0][0] < 0.88:
        return None
    if len(scored) > 1 and scored[0][0] - scored[1][0] < 0.04:
        return None
    candidate_tokens = set(re.findall(r"[a-z0-9]+", scored[0][1]["official_name"].lower())) - {"nifty", "index"}
    return scored[0][1] if required_tokens <= candidate_tokens else None


def parse_constituents(page: dict[str, str]) -> dict[str, object]:
    page_body, _ = request(page["page_url"])
    match = re.search(r'href="(https://www\.niftyindices\.com/IndexConstituent/[^"]+)"', page_body.decode("utf-8", "replace"))
    source_url = html.unescape(match.group(1)) if match else LEGACY_PUBLIC_DOWNLOADS.get(key(page["official_name"]))
    if not source_url:
        return {"official_name": page["official_name"], "page_url": page["page_url"], "status": "no_public_constituent_download"}
    source_url = quote(source_url, safe=":/?=&")
    body, headers = request(source_url)
    text = body.decode("utf-8-sig", "replace")
    header = text.splitlines()[0] if text.splitlines() else ""
    if "Symbol" not in header:
        return {"official_name": page["official_name"], "page_url": page["page_url"], "status": "invalid_public_constituent_download", "source_url": source_url}
    rows = []
    for source in csv.DictReader(StringIO(text)):
        clean = {str(name).strip(): str(value or "").strip() for name, value in source.items() if name}
        symbol = clean.get("Symbol")
        if not symbol:
            continue
        rows.append({
            "symbol": symbol,
            "company_name": clean.get("Company Name") or None,
            "isin": clean.get("ISIN Code") or None,
            "series": clean.get("Series") or None,
            "industry": clean.get("Industry") or None,
            "weight": clean.get("Weight") or clean.get("Weightage") or None,
        })
    return {
        "official_name": page["official_name"],
        "page_url": page["page_url"],
        "status": "available" if rows else "empty_public_constituent_download",
        "source_url": source_url,
        "source_last_modified": headers.get("Last-Modified"),
        "constituents": rows,
    }


def main() -> int:
    generated_at = datetime.now(timezone.utc).isoformat()
    requested = requested_indices()
    pages = catalogue()
    mappings = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        tasks = {}
        for item in requested:
            page = choose_page(item, pages)
            if page is None:
                mappings.append({**item, "status": "official_page_not_resolved"})
            else:
                tasks[executor.submit(parse_constituents, page)] = item
        for future in as_completed(tasks):
            item = tasks[future]
            try:
                mappings.append({**item, **future.result()})
            except Exception as error:  # preserve an explicit unavailable state
                mappings.append({**item, "status": "fetch_failed", "error": str(error)})
    mappings.sort(key=lambda row: str(row["requested_name"]).casefold())
    payload = {
        "schema_version": 1,
        "generated_at": generated_at,
        "purpose": "standalone saved reference; not consumed by runtime code",
        "source": "Official public NSE Indices page-specific Index Constituent downloads",
        "indices": mappings,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    previous = None
    if OUTPUT.exists():
        with gzip.open(OUTPUT, "rt", encoding="utf-8") as handle:
            previous = json.load(handle)
    changed = previous is None or previous.get("indices") != mappings
    if changed:
        with gzip.open(OUTPUT, "wt", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    summary = {
        "schema_version": 1,
        "generated_at": generated_at,
        "requested_indices": len(requested),
        "available": sum(item.get("status") == "available" for item in mappings),
        "unavailable": sum(item.get("status") != "available" for item in mappings),
        "file": str(OUTPUT.relative_to(ROOT)),
        "runtime_integration": False,
    }
    summary["changed"] = changed
    if changed:
        MANIFEST.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
