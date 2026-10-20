"""Unit tests for revision backfill and enrichment engine."""

import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

import sys
PIPELINE_DIR = Path(__file__).resolve().parent.parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))
TOOLS_DIR = PIPELINE_DIR.parent / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from build_market_screens import enrich_snapshot_directory
from backfill_revision_screens import is_revision_enriched, get_revision_as_of_date, process_revision, main


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
            for i, day in enumerate(pd.bdate_range(end="2026-09-30", periods=100)):
                dt_str = day.date().isoformat()
                c = 100.0 + i * 0.5
                f.write(f"{dt_str},{c-1},{c+2},{c-2},{c},500000\n")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_published_revision_is_preserved_and_uses_frozen_history(self):
        history_dir = self.rev_dir / ".scanner_cache"
        history_dir.mkdir()
        frame = pd.read_csv(self.ohlcv_dir / "TESTCO.csv")
        np.savez(history_dir / "history.npz", revision="frozen-history", symbols=np.array(["TESTCO"]),
                 offsets=np.array([0, len(frame)]), dates=pd.to_datetime(frame["Date"]).to_numpy(dtype="datetime64[ns]").astype("int64"),
                 values=frame[["Open", "High", "Low", "Close", "Volume"]].to_numpy())
        (self.rev_dir / "scanner_revision.json").write_text(json.dumps({"revision": self.rev_dir.name, "historyRevision": "frozen-history"}))
        # A calendar in the current pipeline root must not leak into this older revision.
        (self.root / "earnings_calendar.json").write_text(json.dumps({"events": [{"symbol": "TESTCO", "scheduled_date": "2026-10-01"}]}))
        before = {p.relative_to(self.rev_dir): p.read_bytes() for p in self.rev_dir.rglob("*") if p.is_file()}
        result = process_revision(self.rev_dir)
        self.assertEqual(result["status"], "SUCCESS", result)
        after = {p.relative_to(self.rev_dir): p.read_bytes() for p in self.rev_dir.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        derived = self.rev_dir.parent / result["output_revision"]
        self.assertEqual(json.loads((derived / "scanner_revision.json").read_text())["revision"], derived.name)
        with gzip.open(derived / "all_stocks_fundamental_analysis.json.gz", "rt") as handle:
            stock = json.load(handle)[0]
        self.assertIsNone(stock["upcoming_earnings"]["scheduled_date"])
        self.assertTrue((derived / ".scanner_cache/history.npz").exists())
        self.assertEqual(list((derived / "ohlcv_data").glob("*.csv")), [])

    def test_missing_history_fails_without_modifying_source(self):
        stock_file = self.rev_dir / "all_stocks_fundamental_analysis.json.gz"
        before = stock_file.read_bytes()
        result = process_revision(self.rev_dir)
        self.assertEqual(result["status"], "ERROR")
        self.assertIn("frozen OHLCV", result["message"])
        self.assertEqual(before, stock_file.read_bytes())

    def test_partial_enrichment_does_not_skip(self):
        stocks = [{"symbol": "TESTCO", "setup_geometry": {}, "trend_template": {}}]
        with gzip.open(self.rev_dir / "all_stocks_fundamental_analysis.json.gz", "wt") as handle:
            json.dump(stocks, handle)
        self.assertFalse(is_revision_enriched(self.rev_dir))

    def test_failure_does_not_publish_partial_revision(self):
        before = sorted(p.name for p in self.root.iterdir())
        with patch("backfill_revision_screens.enrich_snapshot_directory", side_effect=ValueError("invalid inputs")):
            result = process_revision(self.rev_dir, ohlcv_dir=self.ohlcv_dir)
        self.assertEqual(result["status"], "ERROR")
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), before)
        self.assertFalse(is_revision_enriched(self.rev_dir))

    def test_explicit_history_is_retained_in_derived_revision(self):
        result = process_revision(self.rev_dir, ohlcv_dir=self.ohlcv_dir)
        self.assertEqual(result["status"], "SUCCESS", result)
        derived = self.root / result["output_revision"]
        self.assertEqual((derived / "ohlcv_data/TESTCO.csv").read_bytes(),
                         (self.ohlcv_dir / "TESTCO.csv").read_bytes())

    def test_cli_rejects_missing_and_ambiguous_revisions(self):
        for name in ("missing", "mock"):
            if name == "mock":
                other = self.root / "mock_rev_other"
                other.mkdir()
                (other / "all_stocks_fundamental_analysis.json").write_text("[]")
            with self.subTest(name=name), patch("sys.argv", ["backfill", "--revisions-dir", str(self.root), "--revision", name]), self.assertRaises(SystemExit) as error:
                main()
            self.assertEqual(error.exception.code, 2)

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
