"""Dated NSE price-band history rebuilt from the archived daily scanner snapshots.

Every published session stores each stock's `circuitLimit` for that date, so the
band history is a fold over the sessions in date order: a stock's first observed
band starts its list, and a new entry is added only when the band differs from
the last one. A day where a stock is missing or its band is blank changes nothing.

Ledger shape (also the published `price-band-history.json.gz`):
    {"version": 1, "from": "2021-10-01", "through": "2026-10-22",
     "bands": {"PCJEWELLER": [["2021-10-01", "20"], ["2023-01-19", "5"], ...]}}

    python price_band_history.py rebuild [--output public/data] [--workers 8]
downloads every archived snapshot once and writes `<output>/price-band-history.json`;
daily publication then folds in just that session (see publish_snapshot.py).
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from packed_snapshot import snapshot_stocks

LEDGER_NAME = "price-band-history.json"
VERSION = 1
_NUMERIC = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*%?\s*$")


def normalize_band(value) -> str | None:
    """'20', '10', '5', '2' (no trailing zeros) or 'No Band'; None when unknown."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in {"-", "N/A", "NA"}:
        return None
    if text.upper() in {"NO BAND", "NONE", "NOBAND"}:
        return "No Band"
    match = _NUMERIC.match(text)
    if not match:
        return None
    number = float(match.group(1))
    return str(int(number)) if number.is_integer() else str(number)


def empty_ledger() -> dict:
    return {"version": VERSION, "from": None, "through": None, "bands": {}}


def apply_session(ledger: dict, session: str, rows) -> dict:
    """Fold one session's rows ({symbol, circuitLimit}) into the ledger, in place. Sessions must arrive in date order."""
    if ledger.get("through") and session <= ledger["through"]:
        return ledger  # Already folded; reruns of a published date are no-ops.
    bands = ledger["bands"]
    for row in rows:
        symbol = row.get("symbol")
        band = normalize_band(row.get("circuitLimit", row.get("circuit_limit")))
        if not symbol or band is None:
            continue
        history = bands.setdefault(symbol, [])
        if not history or history[-1][1] != band:
            history.append([session, band])
    ledger["from"] = ledger.get("from") or session
    ledger["through"] = session
    return ledger


def load_ledger(path: Path) -> dict:
    if not path.exists():
        return empty_ledger()
    data = json.loads(path.read_text())
    if data.get("version") != VERSION or not isinstance(data.get("bands"), dict):
        raise RuntimeError(f"Unrecognised price-band ledger: {path}")
    return data


def write_ledger(path: Path, ledger: dict) -> bytes:
    """Write the persistent ledger and return its compact JSON bytes for publication.

    The ledger is committed with each daily refresh, so it is written one symbol per
    line: a day's commit then only touches the symbols whose band changed.
    """
    head = {key: ledger[key] for key in ("version", "from", "through")}
    lines = [f"  {json.dumps(symbol)}: {json.dumps(history, separators=(',', ':'))}" for symbol, history in sorted(ledger["bands"].items())]
    text = json.dumps(head, sort_keys=True)[:-1] + ', "bands": {\n' + ",\n".join(lines) + "\n}}\n"
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text)
    temporary.replace(path)
    return json.dumps(ledger, separators=(",", ":"), sort_keys=True).encode()


def _snapshot_rows(base_url: str, session: str, revision: str, attempts: int = 5):
    """Rows for one archived session, or None after repeated download failures (that day is then skipped)."""
    url = f"{base_url}/snapshots/{session}.json.gz?v={revision[:16]}"
    request = urllib.request.Request(url, headers={"User-Agent": "nexus-price-band-history"})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = json.loads(gzip.decompress(response.read()))
            break
        except (OSError, ValueError) as error:
            if attempt == attempts - 1:
                print(f"  skipped {session}: {error}", flush=True)
                return None
            time.sleep(2 ** attempt)
    return [{"symbol": stock.get("symbol"), "circuitLimit": stock.get("circuitLimit")} for stock in snapshot_stocks(data)]


def rebuild(output: Path, base_url: str, workers: int = 8) -> dict:
    """Recreate the ledger from every archived session listed in `<output>/sessions.json`."""
    sessions = sorted(json.loads((output / "sessions.json").read_text())["sessions"], key=lambda item: item["date"])
    ledger = empty_ledger()
    skipped = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        # map() keeps date order, so folding stays sequential while downloads run in parallel.
        for index, rows in enumerate(pool.map(lambda item: _snapshot_rows(base_url, item["date"], item["revision"]), sessions)):
            if rows is None:
                skipped.append(sessions[index]["date"])
                continue
            apply_session(ledger, sessions[index]["date"], rows)
            if index % 100 == 0:
                print(f"  {sessions[index]['date']}: {len(ledger['bands'])} symbols", flush=True)
    write_ledger(output / LEDGER_NAME, ledger)
    changes = sum(len(history) - 1 for history in ledger["bands"].values())
    print(f"Price-band history {ledger['from']}..{ledger['through']}: {len(ledger['bands'])} symbols, {changes} changes"
          f"{f'; skipped {len(skipped)} sessions: {skipped}' if skipped else ''}", flush=True)
    return ledger


def _default_base_url(output: Path) -> str:
    template = json.loads((output / "current.json").read_text()).get("objectUrlTemplate", "")
    return re.sub(r"/objects/\{hash\}\.json\.gz$", "", template)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["rebuild"])
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "public" / "data")
    parser.add_argument("--base-url", default=os.environ.get("EDL_SNAPSHOT_BASE_URL"))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    rebuild(args.output, args.base_url or _default_base_url(args.output), args.workers)
