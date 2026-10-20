#!/usr/bin/env python3
"""Batch backfill past revisions in .scanner_cache/revisions with setup_geometry and trend_template.

Enables historical session selector dates (e.g. browsing the screener as of Oct 1st)
to carry full setup geometry, Minervini trend template scores, and Weinstein stages.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import gzip
import json
import os
from pathlib import Path
import sys
import time

# Ensure pipeline root is importable
ROOT_DIR = Path(__file__).resolve().parent.parent
PIPELINE_DIR = ROOT_DIR / "DO NOT DELETE EDL PIPELINE"
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from build_market_screens import enrich_snapshot_directory


REVISIONS_DIR = PIPELINE_DIR / ".scanner_cache" / "revisions"
OHLCV_DIR = PIPELINE_DIR / "ohlcv_data"


def is_revision_enriched(rev_dir: Path) -> bool:
    """Check if a revision already contains setup_geometry in its stock snapshot."""
    stocks_gz = rev_dir / "all_stocks_fundamental_analysis.json.gz"
    stocks_json = rev_dir / "all_stocks_fundamental_analysis.json"

    p = stocks_gz if stocks_gz.exists() else stocks_json
    if not p.exists():
        return False

    opener = gzip.open if p.suffix == ".gz" else open
    try:
        with opener(p, "rt", encoding="utf-8") as f:
            stocks = json.load(f)
        if isinstance(stocks, list) and len(stocks) > 0:
            first = stocks[0]
            return "setup_geometry" in first and "trend_template" in first
        elif isinstance(stocks, dict):
            first = (stocks.get("stocks") or [{}])[0]
            return "setup_geometry" in first and "trend_template" in first
    except Exception:
        return False
    return False


def get_revision_as_of_date(rev_dir: Path) -> str:
    """Extract as-of date from a revision's stock snapshot or RS file."""
    stocks_gz = rev_dir / "all_stocks_fundamental_analysis.json.gz"
    stocks_json = rev_dir / "all_stocks_fundamental_analysis.json"
    p = stocks_gz if stocks_gz.exists() else stocks_json

    if p.exists():
        opener = gzip.open if p.suffix == ".gz" else open
        try:
            with opener(p, "rt", encoding="utf-8") as f:
                stocks = json.load(f)
            stock_list = stocks if isinstance(stocks, list) else stocks.get("stocks", [])
            if stock_list:
                return stock_list[0].get("as_of_date") or stock_list[0].get("date") or "unknown"
        except Exception:
            pass

    rs_gz = rev_dir / "rs_rating_daily.json.gz"
    rs_json = rev_dir / "rs_rating_daily.json"
    p_rs = rs_gz if rs_gz.exists() else rs_json
    if p_rs.exists():
        opener = gzip.open if p_rs.suffix == ".gz" else open
        try:
            with opener(p_rs, "rt", encoding="utf-8") as f:
                rs_data = json.load(f)
            return rs_data.get("as_of_date") or "unknown"
        except Exception:
            pass

    return "unknown"


def list_available_revisions(rev_root: Path = REVISIONS_DIR) -> list[Path]:
    """List all valid revision directories sorted by name."""
    if not rev_root.exists():
        return []
    revisions = []
    for item in sorted(rev_root.iterdir()):
        if item.is_dir() and (item / "all_stocks_fundamental_analysis.json.gz").exists() or (item / "all_stocks_fundamental_analysis.json").exists():
            revisions.append(item)
    return revisions


def process_revision(
    rev_dir: Path,
    force: bool = False,
    dry_run: bool = False,
    ohlcv_dir: Path = OHLCV_DIR,
    earnings_root: Path = PIPELINE_DIR,
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
            "message": "Already enriched (use --force to overwrite)",
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
        success = enrich_snapshot_directory(
            root=rev_dir,
            ohlcv_dir=ohlcv_dir,
            earnings_root=earnings_root,
            generate_gallery=False,
        )
        t_dur = round(time.time() - t0, 2)
        if success:
            return {
                "revision": rev_id,
                "as_of_date": as_of,
                "status": "SUCCESS",
                "message": f"Enriched successfully in {t_dur}s",
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
    args = parser.parse_args()

    rev_root = Path(args.revisions_dir)
    all_revs = list_available_revisions(rev_root)

    if not all_revs:
        print(f"No revisions found in {rev_root}")
        return 0

    targets: list[Path] = []
    if args.revision:
        for r_name in args.revision:
            matching = [p for p in all_revs if p.name.startswith(r_name)]
            if matching:
                targets.extend(matching)
            else:
                p = rev_root / r_name
                if p.exists():
                    targets.append(p)
                else:
                    print(f"Warning: revision '{r_name}' not found.")
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

    if args.limit:
        targets = targets[: args.limit]

    print(f"\nProcessing {len(targets)} revision(s) [dry_run={args.dry_run}, force={args.force}]...\n")
    results = []
    for idx, target in enumerate(targets, 1):
        print(f"[{idx}/{len(targets)}] Checking {target.name[:12]}...")
        res = process_revision(target, force=args.force, dry_run=args.dry_run)
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
