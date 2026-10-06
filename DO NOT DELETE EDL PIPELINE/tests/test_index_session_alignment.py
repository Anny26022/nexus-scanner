import csv
import json
from datetime import datetime, timezone
from unittest.mock import patch
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import fetch_indices_ohlcv as indices
from fetch_indices_ohlcv import has_current_equity_session, index_snapshot_session


class IndexSessionAlignmentTests(unittest.TestCase):
    def test_after_midnight_uses_fresh_official_previous_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for symbol in ("A", "B"):
                (root / f"{symbol}.csv").write_text("Date\n2026-10-05\n")
            report = {"available": True, "as_of_date": "2026-10-05",
                      "retrieved_at": "2026-10-06T00:55:00+05:30"}
            now = datetime(2026, 10, 6, 1, 10)
            self.assertEqual(index_snapshot_session(root, {"A", "B"}, report, now), "2026-10-05")
            for changed in ({"available": False}, {"as_of_date": "2026-10-01"},
                            {"as_of_date": "2026-10-07"}, {"retrieved_at": "2026-10-05T18:00:00+05:30"}):
                self.assertIsNone(index_snapshot_session(root, {"A", "B"}, {**report, **changed}, now))
            self.assertIsNone(index_snapshot_session(root, {"A", "B", "MISSING"}, report, now))
            self.assertIsNone(index_snapshot_session(root, {"A", "B"}, report, datetime(2026, 10, 6, 16)))

    def test_preopen_weekend_uses_fresh_official_friday_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for symbol in ("A", "B"):
                (root / f"{symbol}.csv").write_text("Date\n2026-10-02\n")
            report = {"available": True, "as_of_date": "2026-10-02",
                      "retrieved_at": "2026-10-05T01:05:00+05:30"}
            now = datetime(2026, 10, 5, 1, 10)
            self.assertEqual(index_snapshot_session(root, {"A", "B"}, report, now), "2026-10-02")
            too_old = {**report, "as_of_date": "2026-09-25"}
            self.assertIsNone(index_snapshot_session(root, {"A", "B"}, too_old, now))

    def test_after_midnight_refresh_writes_previous_close_not_new_day(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stocks = root / "ohlcv_data"; stocks.mkdir()
            output = root / "indices_ohlcv_data"; output.mkdir()
            (stocks / "ABC.csv").write_text("Date\n2026-10-05\n")
            (output / "NIFTY.csv").write_text("Date,Open,High,Low,Close,Volume\n2026-10-01,100,102,99,101,0\n")
            roster = [{"Symbol":"NIFTY", "Exchange":"NSE", "Segment":"I", "Instrument":"INDEX", "IndexID":13,
                       "Open":102, "High":104, "Low":101, "Ltp":103, "Volume":0}]
            report = {"available": True, "as_of_date":"2026-10-05", "retrieved_at":"2026-10-06T00:55:00+05:30"}
            def load(name):
                return roster if name == indices.INPUT_FILE else [{"Symbol":"ABC"}] if name == indices.MASTER_FILE else report
            def resolve(name):return root / name
            now = datetime(2026, 10, 6, 1, 10)
            with patch.object(indices, "load_json", side_effect=load), patch.object(indices, "resolve_path", side_effect=resolve), \
                 patch.object(indices, "ensure_dir"), patch.object(indices, "nse_now", return_value=indices.nse_now(now)), \
                 patch.object(indices.time, "time", return_value=datetime(2026,10,5,19,40,tzinfo=timezone.utc).timestamp()), \
                 patch.object(indices, "fetch_chunk", return_value=[]):
                self.assertTrue(indices.main())
            rows = indices.read_ohlcv_csv(output / "NIFTY.csv")
            self.assertEqual([row["Date"] for row in rows], ["2026-10-01", "2026-10-05"])
            self.assertEqual(rows[-1]["Close"], "103")

    def test_current_equity_coverage_allows_after_close_index_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sessions = [(f"S{index}", "2026-09-28") for index in range(9)] + [("STALE", "2026-09-25")]
            for symbol, session in sessions:
                with (root / f"{symbol}.csv").open("w", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=["Date"])
                    writer.writeheader()
                    writer.writerow({"Date": session})
            self.assertTrue(has_current_equity_session(root, "2026-09-28"))

    def test_old_equity_cache_does_not_relabel_index_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for symbol in ("A", "B", "C"):
                with (root / f"{symbol}.csv").open("w", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=["Date"])
                    writer.writeheader()
                    writer.writerow({"Date": "2026-09-25"})
            self.assertFalse(has_current_equity_session(root, "2026-09-28"))

    def test_uses_current_master_universe_not_stale_cache_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for symbol, session in (("MAIN", "2026-09-28"), ("OLD", "2026-09-25")):
                with (root / f"{symbol}.csv").open("w", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=["Date"])
                    writer.writeheader()
                    writer.writerow({"Date": session})
            self.assertTrue(has_current_equity_session(root, "2026-09-28", {"MAIN"}))


if __name__ == "__main__":
    unittest.main()
