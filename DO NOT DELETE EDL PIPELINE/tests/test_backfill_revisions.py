"""Unit tests for revision backfill and enrichment engine."""

import gzip
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

import sys
PIPELINE_DIR = Path(__file__).resolve().parent.parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))
TOOLS_DIR = PIPELINE_DIR.parent / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from build_market_screens import enrich_snapshot_directory
from backfill_revision_screens import is_revision_enriched, get_revision_as_of_date, process_revision


class TestRevisionBackfill(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.rev_dir = self.root / "mock_rev_12345"
        self.rev_dir.mkdir(parents=True)
        self.ohlcv_dir = self.root / "ohlcv_data"
        self.ohlcv_dir.mkdir(parents=True)

        # Mock stock snapshot
        stocks = [
            {
                "symbol": "TESTCO",
                "name": "Test Company Ltd",
                "sector": "Technology",
                "industry": "Software",
                "as_of_date": "2026-09-30",
                "close": 150.0,
                "volume": 200000,
            }
        ]
        stocks_path = self.rev_dir / "all_stocks_fundamental_analysis.json.gz"
        with gzip.open(stocks_path, "wt", encoding="utf-8") as f:
            json.dump(stocks, f)

        # Mock RS ratings
        rs_data = {
            "as_of_date": "2026-09-30",
            "ratings": {
                "TESTCO": {
                    "composite_rs": 85,
                    "front_weighted": 85,
                    "rs_change_21d": 5,
                    "is_rs_line_52w_high": True,
                }
            }
        }
        with gzip.open(self.rev_dir / "rs_rating_daily.json.gz", "wt", encoding="utf-8") as f:
            json.dump(rs_data, f)

        # Mock OHLCV CSV with 100 sessions
        csv_path = self.ohlcv_dir / "TESTCO.csv"
        with open(csv_path, "w", encoding="utf-8") as f:
            f.write("Date,Open,High,Low,Close,Volume\n")
            # Generate 100 days of ascending prices ending on 2026-09-30
            for i in range(100):
                d_day = i + 1
                dt_str = f"2026-06-{d_day:02d}" if d_day <= 30 else (f"2026-07-{d_day-30:02d}" if d_day <= 60 else f"2026-09-{min(30, d_day-60):02d}")
                c = 100.0 + i * 0.5
                f.write(f"{dt_str},{c-1},{c+2},{c-2},{c},500000\n")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_enrichment_lifecycle(self):
        # 1. Initially not enriched
        self.assertFalse(is_revision_enriched(self.rev_dir))
        self.assertEqual(get_revision_as_of_date(self.rev_dir), "2026-09-30")

        # 2. Dry run
        dry_res = process_revision(self.rev_dir, dry_run=True)
        self.assertEqual(dry_res["status"], "DRY_RUN")
        self.assertFalse(is_revision_enriched(self.rev_dir))

        # 3. Live enrichment
        success = enrich_snapshot_directory(
            root=self.rev_dir,
            ohlcv_dir=self.ohlcv_dir,
            earnings_root=self.root,
            generate_gallery=False,
        )
        self.assertTrue(success)

        # 4. Verified enriched
        self.assertTrue(is_revision_enriched(self.rev_dir))

        # 5. Check enriched stock fields
        stocks_gz = self.rev_dir / "all_stocks_fundamental_analysis.json.gz"
        with gzip.open(stocks_gz, "rt", encoding="utf-8") as f:
            enriched = json.load(f)

        s = enriched[0]
        self.assertIn("setup_geometry", s)
        self.assertIn("trend_template", s)
        self.assertIn("stage_status", s)
        self.assertIn("upcoming_earnings", s)
        self.assertIn("traded_value_mean_20d_cr", s)
        self.assertIn("is_liquid_screen", s)

        # 6. Check market_screens_snapshot.json.gz
        snap_gz = self.rev_dir / "market_screens_snapshot.json.gz"
        self.assertTrue(snap_gz.exists())
        with gzip.open(snap_gz, "rt", encoding="utf-8") as f:
            snap = json.load(f)
        self.assertEqual(snap["as_of_date"], "2026-09-30")
        self.assertEqual(len(snap["records"]), 1)
        self.assertEqual(snap["records"][0]["symbol"], "TESTCO")

        # 7. Second run should be SKIPPED
        skip_res = process_revision(self.rev_dir, force=False, ohlcv_dir=self.ohlcv_dir, earnings_root=self.root)
        self.assertEqual(skip_res["status"], "SKIPPED")

        # 8. Force run should succeed again
        force_res = process_revision(self.rev_dir, force=True, ohlcv_dir=self.ohlcv_dir, earnings_root=self.root)
        self.assertEqual(force_res["status"], "SUCCESS")


if __name__ == "__main__":
    unittest.main()
