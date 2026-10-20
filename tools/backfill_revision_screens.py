#!/usr/bin/env python3
"""Batch backfill past revisions in .scanner_cache/revisions with setup_geometry and trend_template.

Creates derived backend revisions without changing published revision inputs.
Frontend historical datasets must be republished separately using the existing publisher.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

# Ensure pipeline root is importable
ROOT_DIR = Path(__file__).resolve().parent.parent
PIPELINE_DIR = ROOT_DIR / "DO NOT DELETE EDL PIPELINE"
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from build_market_screens import enrich_snapshot_directory, load_json_or_gz


REVISIONS_DIR = PIPELINE_DIR / ".scanner_cache" / "revisions"


def is_revision_enriched(rev_dir: Path) -> bool:
    """Check if a revision already contains setup_geometry in its stock snapshot."""
    stocks_gz = rev_dir / "all_stocks_fundamental_analysis.json.gz"
    stocks_json = rev_dir / "all_stocks_fundamental_analysis.json"

    if not stocks_gz.exists() and not stocks_json.exists():
        return False

    try:
        stocks = load_json_or_gz(stocks_json)
        stock_list = stocks if isinstance(stocks, list) else stocks.get("stocks", [])
        screens = load_json_or_gz(rev_dir / "market_screens_snapshot.json") or {}
        first = stock_list[0] if stock_list else {}
        as_of = first.get("as_of_date") or first.get("date") or first.get("session_date")
        if not as_of:
            as_of = (load_json_or_gz(rev_dir / "rs_rating_daily.json") or {}).get("as_of_date")
        return bool(stock_list) and all(
            all(key in stock for key in ("setup_geometry", "trend_template", "stage_status", "upcoming_earnings", "is_liquid_screen"))
            for stock in stock_list
        ) and as_of is not None and screens.get("as_of_date") == as_of
    except Exception:
        return False
    return False


def get_revision_as_of_date(rev_dir: Path) -> str:
    """Extract as-of date from a revision's stock snapshot or RS file."""
    try:
        stocks = load_json_or_gz(rev_dir / "all_stocks_fundamental_analysis.json") or []
        stock_list = stocks if isinstance(stocks, list) else stocks.get("stocks", [])
        if stock_list:
            first = stock_list[0]
            as_of = first.get("as_of_date") or first.get("date") or first.get("session_date")
            if as_of:
                return as_of
        rs = load_json_or_gz(rev_dir / "rs_rating_daily.json") or {}
        return rs.get("as_of_date") or "unknown"
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return "unknown"


def list_available_revisions(rev_root: Path = REVISIONS_DIR) -> list[Path]:
    """List all valid revision directories sorted by name."""
    if not rev_root.exists():
        return []
    revisions = []
    for item in sorted(rev_root.iterdir()):
        if item.is_dir() and any((item / name).exists() for name in ("all_stocks_fundamental_analysis.json.gz", "all_stocks_fundamental_analysis.json")):
            if not (item / "screen_backfill.json").exists():
                revisions.append(item)
    return revisions


def process_revision(
    rev_dir: Path,
    force: bool = False,
    dry_run: bool = False,
    ohlcv_dir: Path | None = None,
    earnings_root: Path | None = None,
) -> dict:
    """Enrich a single revision folder."""
    as_of = get_revision_as_of_date(rev_dir)
    rev_id = rev_dir.name

    already_done = is_revision_enriched(rev_dir)
    if already_done and not force:
        return {
            "revision": rev_id,
            "as_of_date": as_of,
            "status": "SKIPPED",
            "message": "Already enriched (use --force to derive a revised result)",
            "duration": 0.0,
        }

    if dry_run:
        return {
            "revision": rev_id,
            "as_of_date": as_of,
            "status": "DRY_RUN",
            "message": "Would enrich setup_geometry and trend_template",
            "duration": 0.0,
        }

    t0 = time.time()
    try:
        # Work on a private copy: frozen revision IDs are also scanner cache keys.
        # Updating their inputs in place would leave cached/backend/browser results inconsistent.
        with tempfile.TemporaryDirectory(prefix=".screen-backfill-", dir=rev_dir.parent) as temp:
            staged = Path(temp) / "revision"
            shutil.copytree(rev_dir, staged)
            marker = staged / "scanner_revision.json"
            metadata = json.loads(marker.read_text()) if marker.exists() else {}
            prices = Path(ohlcv_dir) if ohlcv_dir is not None else staged / "ohlcv_data"
            exported_history = False
            if ohlcv_dir is None and not any(prices.glob("*.csv")):
                packed = staged / ".scanner_cache" / "history.npz"
                if not packed.exists():
                    raise ValueError("Revision has no frozen OHLCV history; pass --ohlcv-dir explicitly to use another history source")
                import numpy as np
                import pandas as pd
                prices.mkdir(exist_ok=True)
                exported_history = True
                with np.load(packed, allow_pickle=False) as history:
                    history_revision = str(history["revision"])
                    if metadata.get("historyRevision") not in (None, history_revision):
                        raise ValueError("Frozen history does not match the revision's historyRevision")
                    metadata["historyRevision"] = history_revision
                    for index, symbol in enumerate(history["symbols"]):
                        symbol = str(symbol)
                        if Path(symbol).name != symbol or any(c in symbol for c in ("/", "\\")):
                            raise ValueError("Invalid symbol in frozen history")
                        start, end = history["offsets"][index:index + 2]
                        frame = pd.DataFrame(history["values"][start:end], columns=["Open", "High", "Low", "Close", "Volume"])
                        frame.insert(0, "Date", pd.to_datetime(history["dates"][start:end]))
                        frame.to_csv(prices / f"{symbol}.csv", index=False)
            success = enrich_snapshot_directory(
                root=staged,
                ohlcv_dir=prices,
                # A current calendar contains future knowledge about an old revision.
                earnings_root=Path(earnings_root) if earnings_root is not None else staged,
                generate_gallery=False,
            )
            if success:
                if ohlcv_dir is not None:
                    # The derived backend must retain the same history used for its signals.
                    retained_prices = staged / "ohlcv_data"
                    if retained_prices.exists():
                        shutil.rmtree(retained_prices)
                    retained_prices.mkdir()
                    stocks = load_json_or_gz(staged / "all_stocks_fundamental_analysis.json")
                    for stock in stocks:
                        symbol = stock.get("symbol") or stock.get("Symbol")
                        if not symbol or Path(symbol).name != symbol:
                            continue
                        filename = f"{symbol.upper()}.csv"
                        if (prices / filename).exists():
                            shutil.copy2(prices / filename, retained_prices / filename)
                    (staged / ".scanner_cache/history.npz").unlink(missing_ok=True)
                    metadata.pop("historyRevision", None)
                if exported_history:
                    # Keep the existing packed history; CSVs were only an adapter for enrichment.
                    shutil.rmtree(prices)
                    prices.mkdir()
                digest = hashlib.sha256(rev_id.encode())
                for filename in ("all_stocks_fundamental_analysis.json", "market_screens_snapshot.json"):
                    digest.update((staged / filename).read_bytes())
                new_revision = digest.hexdigest()
                metadata["revision"] = new_revision
                marker.write_text(json.dumps(metadata))
                (staged / "screen_backfill.json").write_text(json.dumps({"source_revision": rev_id, "as_of_date": as_of}))
                destination = rev_dir.parent / new_revision
                if not destination.exists():
                    staged.rename(destination)
        t_dur = round(time.time() - t0, 2)
        if success:
            return {
                "revision": rev_id,
                "as_of_date": as_of,
                "status": "SUCCESS",
                "message": f"Derived backend revision {new_revision} available after {t_dur}s; frontend publication is separate",
                "output_revision": new_revision,
                "duration": t_dur,
            }
        else:
            return {
                "revision": rev_id,
                "as_of_date": as_of,
                "status": "FAILED",
                "message": "enrich_snapshot_directory returned False",
                "duration": t_dur,
            }
    except Exception as exc:
        t_dur = round(time.time() - t0, 2)
        return {
            "revision": rev_id,
            "as_of_date": as_of,
            "status": "ERROR",
            "message": str(exc),
            "duration": t_dur,
        }


def main():
    parser = argparse.ArgumentParser(description="Backfill past scanner revisions with setup geometry & trend templates.")
    parser.add_argument("--all", action="store_true", help="Backfill all discovered revisions.")
    parser.add_argument("--revision", "-r", type=str, nargs="+", help="Specific revision ID(s) or folder name(s) to process.")
    parser.add_argument("--force", "-f", action="store_true", help="Re-process revisions even if already enriched.")
    parser.add_argument("--dry-run", action="store_true", help="Inspect and display status without modifying files.")
    parser.add_argument("--limit", "-n", type=int, default=None, help="Limit number of revisions to process.")
    parser.add_argument("--revisions-dir", type=str, default=str(REVISIONS_DIR), help="Path to revisions directory.")
    parser.add_argument("--ohlcv-dir", type=str, help="Explicit alternate history source; defaults to each revision's frozen history.")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")

    rev_root = Path(args.revisions_dir)
    all_revs = list_available_revisions(rev_root)

    if not all_revs:
        if args.revision:
            parser.error("no matching revisions found")
        print(f"No revisions found in {rev_root}")
        return 0

    targets: list[Path] = []
    if args.revision:
        for r_name in args.revision:
            matching = [p for p in all_revs if p.name.startswith(r_name)]
            if len(matching) == 1:
                targets.extend(matching)
            elif len(matching) > 1:
                parser.error(f"revision prefix '{r_name}' is ambiguous")
            else:
                parser.error(f"revision '{r_name}' not found")
    elif args.all:
        targets = all_revs
    else:
        print(f"Found {len(all_revs)} revisions in {rev_root.name}:")
        for r in all_revs:
            as_of = get_revision_as_of_date(r)
            enriched = is_revision_enriched(r)
            status_tag = "[ENRICHED]" if enriched else "[PENDING]"
            print(f"  {r.name[:16]}... (as_of: {as_of}) {status_tag}")
        print("\nSpecify --all to backfill all pending revisions, or --revision <id> for specific ones.")
        return 0

    targets = list(dict.fromkeys(targets))
    if args.limit is not None:
        targets = targets[: args.limit]

    print(f"\nProcessing {len(targets)} revision(s) [dry_run={args.dry_run}, force={args.force}]...\n")
    results = []
    for idx, target in enumerate(targets, 1):
        print(f"[{idx}/{len(targets)}] Checking {target.name[:12]}...")
        res = process_revision(target, force=args.force, dry_run=args.dry_run,
                               ohlcv_dir=Path(args.ohlcv_dir) if args.ohlcv_dir else None)
        results.append(res)
        print(f"       -> {res['status']}: {res['message']}")

    # Print summary table
    print("\n" + "=" * 70)
    print("BACKFILL REVISION SUMMARY")
    print("=" * 70)
    success_count = sum(1 for r in results if r["status"] == "SUCCESS")
    skipped_count = sum(1 for r in results if r["status"] == "SKIPPED")
    failed_count = sum(1 for r in results if r["status"] in ("FAILED", "ERROR"))
    dry_count = sum(1 for r in results if r["status"] == "DRY_RUN")

    for r in results:
        print(f"  {r['revision'][:12]}... | As-Of: {r['as_of_date']} | Status: {r['status']:<7} | {r['duration']}s")

    print("-" * 70)
    print(f"Total: {len(results)} | Succeeded: {success_count} | Skipped: {skipped_count} | Failed: {failed_count} | Dry-Run: {dry_count}")
    print("=" * 70 + "\n")

    return 0 if failed_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
