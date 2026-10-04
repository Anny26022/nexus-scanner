"""Collect authorised Screener.in company pages into one resumable JSON artifact.

The collector intentionally stores the tables as labelled text rather than
guessing financial units or silently mapping provider-specific labels.  A later
normaliser can map audited fields into the canonical financial and
shareholding ledgers with an explicit, tested contract.

Run only under the data-access permission held for this project:

    python fetch_screener_company_data.py --confirmed-permission
"""

from __future__ import annotations

import argparse
import gzip
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

from pipeline_utils import BASE_DIR, atomic_replace_text, load_json


SOURCE = "https://www.screener.in"
REPORT_TYPES = ("consolidated", "standalone")
DEFAULT_DELAY_SECONDS = 1.0


def _text(node) -> str:
    return " ".join(node.get_text(" ", strip=True).split()) if node else ""


def _table_context(table) -> dict[str, str | None]:
    section = table.find_parent("section")
    heading = None
    if section:
        heading = section.find(["h2", "h3"])
    return {
        "section_id": section.get("id") if section else None,
        "title": _text(heading) or _text(table.find("caption")) or None,
    }


def _parse_table(table) -> dict[str, Any] | None:
    header_row = table.find("thead")
    headers = [_text(cell) for cell in header_row.find_all("th")] if header_row else []
    body = table.find("tbody") or table
    rows = []
    for tr in body.find_all("tr"):
        if tr.find_parent("thead"):
            continue
        cells = [_text(cell) for cell in tr.find_all(["th", "td"], recursive=False)]
        if cells:
            rows.append(cells)
    if not headers and not rows:
        return None
    return {**_table_context(table), "headers": headers, "rows": rows}


def parse_company_page(html: str, url: str, symbol: str, report_type: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    main = soup.find("main") or soup
    info = soup.select_one("#company-info")
    ratios = {}
    for item in soup.select("#top-ratios li"):
        name = _text(item.select_one(".name"))
        value = _text(item.select_one(".value"))
        if name and value:
            ratios[name] = value
    tables = [parsed for table in main.find_all("table") if (parsed := _parse_table(table))]
    links = []
    seen = set()
    for anchor in main.find_all("a", href=True):
        href = requests.compat.urljoin(SOURCE, anchor["href"])
        label = _text(anchor)
        key = (href, label)
        if key not in seen:
            seen.add(key)
            links.append({"label": label or None, "url": href})
    return {
        "symbol": symbol,
        "report_type": report_type.upper(),
        "source_url": url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "company_id": info.get("data-company-id") if info else None,
        "warehouse_id": info.get("data-warehouse-id") if info else None,
        "name": _text(main.find("h1")) or None,
        "ratios": ratios,
        "tables": tables,
        "links": links,
    }


def _read_json_or_gzip(path: Path, default: Any) -> Any:
    if path.exists():
        return load_json(path, default=default)
    gzip_path = path.with_suffix(path.suffix + ".gz")
    if gzip_path.exists():
        with gzip.open(gzip_path, "rt", encoding="utf-8") as handle:
            return json.load(handle)
    return default


def symbols_from_artifact(path: Path) -> list[str]:
    data = _read_json_or_gzip(path, [])
    rows = data if isinstance(data, list) else data.get("records", []) if isinstance(data, dict) else []
    return sorted({str(row.get("Symbol") or row.get("symbol") or "").upper() for row in rows if isinstance(row, dict)} - {""})


def save_artifact(path: Path, artifact: dict[str, Any]) -> None:
    atomic_replace_text(path, json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def collect(symbols: list[str], output: Path, delay_seconds: float, checkpoint_every: int, limit: int | None = None) -> dict[str, Any]:
    artifact = _read_json_or_gzip(output, {})
    if not isinstance(artifact, dict):
        artifact = {}
    artifact.setdefault("schema_version", 1)
    artifact["source"] = "Screener.in authorised company-page collection"
    artifact["report_types"] = [item.upper() for item in REPORT_TYPES]
    artifact.setdefault("records", {})
    artifact.setdefault("failures", {})
    artifact["started_at"] = artifact.get("started_at") or datetime.now(timezone.utc).isoformat()

    session = requests.Session()
    session.headers.update({"User-Agent": "Nexus Scanner authorised data collector/1.0", "Accept": "text/html,application/xhtml+xml"})
    selected = symbols[:limit] if limit else symbols
    completed = 0
    for symbol in selected:
        current = artifact["records"].get(symbol, {})
        if all(report_type.upper() in current for report_type in REPORT_TYPES):
            continue
        record = dict(current)
        for report_type in REPORT_TYPES:
            key = report_type.upper()
            if key in record:
                continue
            # Screener's bare company page is standalone; consolidated is an
            # explicit path segment.  There is no ``/standalone/`` route.
            url = (
                f"{SOURCE}/company/{symbol}/consolidated/"
                if report_type == "consolidated"
                else f"{SOURCE}/company/{symbol}/"
            )
            try:
                response = session.get(url, timeout=30)
                response.raise_for_status()
                record[key] = parse_company_page(response.text, url, symbol, report_type)
                artifact["failures"].pop(f"{symbol}:{key}", None)
            except requests.RequestException as exc:
                artifact["failures"][f"{symbol}:{key}"] = {"url": url, "failed_at": datetime.now(timezone.utc).isoformat(), "error": str(exc)}
            time.sleep(delay_seconds)
        if record:
            artifact["records"][symbol] = record
        completed += 1
        if completed % checkpoint_every == 0:
            artifact["updated_at"] = datetime.now(timezone.utc).isoformat()
            save_artifact(output, artifact)
            print(f"Checkpoint: {completed}/{len(selected)} symbols; {len(artifact['records'])} saved.", flush=True)
    artifact["updated_at"] = datetime.now(timezone.utc).isoformat()
    artifact["coverage"] = {
        "requested_symbols": len(selected),
        "symbols_with_any_record": len(artifact["records"]),
        "consolidated_records": sum("CONSOLIDATED" in row for row in artifact["records"].values()),
        "standalone_records": sum("STANDALONE" in row for row in artifact["records"].values()),
        "failed_requests": len(artifact["failures"]),
    }
    save_artifact(output, artifact)
    return artifact


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirmed-permission", action="store_true", help="Required acknowledgement of the granted Screener.in access permission.")
    parser.add_argument("--universe", default="master_isin_map.json", help="Pipeline-relative JSON or JSON.GZ universe artifact.")
    parser.add_argument("--output", default="screener_company_data.json", help="Pipeline-relative output JSON artifact.")
    parser.add_argument("--delay-seconds", type=float, default=DEFAULT_DELAY_SECONDS)
    parser.add_argument("--checkpoint-every", type=int, default=10)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if not args.confirmed_permission:
        parser.error("--confirmed-permission is required")
    if args.delay_seconds < 0:
        parser.error("--delay-seconds must be non-negative")
    root = Path(BASE_DIR)
    symbols = symbols_from_artifact(root / args.universe)
    if not symbols and args.universe == "master_isin_map.json":
        # Published local checkouts commonly retain only the compressed
        # canonical stock artifact after Phase 5 cleanup.
        symbols = symbols_from_artifact(root / "all_stocks_fundamental_analysis.json")
    if not symbols:
        raise SystemExit(f"No symbols found in {root / args.universe}")
    artifact = collect(symbols, root / args.output, args.delay_seconds, max(1, args.checkpoint_every), args.limit)
    print(json.dumps(artifact["coverage"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
