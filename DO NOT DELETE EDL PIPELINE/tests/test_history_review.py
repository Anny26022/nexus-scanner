import json
from datetime import date, timedelta
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from fetch_all_ohlcv import expected_sessions_by_symbol, fetch_single_stock
from ohlcv_utils import missing_history_sessions, read_ohlcv_csv, write_ohlcv_csv
from edl_pipeline.quality import inspect_breadth_history, inspect_publication
import test_integrity


def candle(day, close=10):
    return dict(Date=day, Open=close, High=close, Low=close, Close=close, Volume=10)


class ReviewRegressionTests(unittest.TestCase):
    def test_trailing_empty_and_prelisting_gaps(self):
        expected = {"2026-09-21", "2026-09-22", "2026-09-23"}
        self.assertEqual(missing_history_sessions([], expected), sorted(expected))
        self.assertEqual(missing_history_sessions([candle("2026-09-22")], expected), ["2026-09-23"])

    def test_unusable_ledger_files_warn_and_valid_sessions_survive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "2026-09-21.json").write_text("broken")
            (root / "2026-09-22.json").write_text(json.dumps({"date": "2026-09-22", "records": []}))
            (root / "2026-09-23.json").write_text(json.dumps({"date": "2026-09-23", "records": [
                {"symbol": "ABC", "series": "EQ", "date": "2026-09-23"},
                {"symbol": "OTHER", "series": "EQ", "date": "2026-09-23"}]}))
            with self.assertWarns(UserWarning):
                result = expected_sessions_by_symbol(root, {"ABC": {}}, "2026-09-23")
            self.assertEqual(result, {"ABC": {"2026-09-23"}})

    def test_empty_or_missing_ledger_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            for root in (Path(folder), Path(folder) / "missing"):
                with self.assertRaisesRegex(ValueError, "no usable sessions"):
                    expected_sessions_by_symbol(root, {"ABC": {}}, "2026-09-23")

    def test_provider_overlap_preserves_adjusted_history(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "ABC.csv"
            existing = [candle("2026-09-21", 5), candle("2026-09-23", 5), candle("2026-09-25", 5)]
            write_ohlcv_csv(path, existing)
            fetched = [candle(f"2026-09-{day}", 10) for day in range(21, 26)]
            with patch("fetch_all_ohlcv.resolve_path", return_value=root), patch(
                "fetch_all_ohlcv.fetch_history_chunk", return_value=fetched
            ), patch("fetch_all_ohlcv.is_nse_cash_session", return_value=False):
                result = fetch_single_stock("ABC", dict(Exch="NSE", Seg="E", Inst="EQUITY", Sid=1),
                    official_nse_session="2026-09-25", expected_sessions={row["Date"] for row in fetched})
            self.assertEqual(result, "success")
            rows = {row["Date"]: row for row in read_ohlcv_csv(path)}
            self.assertEqual(float(rows["2026-09-23"]["Close"]), 5)
            self.assertEqual(float(rows["2026-09-25"]["Close"]), 5)
            self.assertEqual(float(rows["2026-09-22"]["Close"]), 10)

    def test_empty_provider_response_fails_without_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for existing in ([], [candle("2026-09-21")]):
                path = root / "ABC.csv"
                write_ohlcv_csv(path, existing)
                before = path.read_bytes()
                with patch("fetch_all_ohlcv.resolve_path", return_value=root), patch(
                    "fetch_all_ohlcv.fetch_history_chunk", return_value=[]
                ), self.assertRaisesRegex(ValueError, "2026-09-22"):
                    fetch_single_stock("ABC", dict(Exch="NSE", Seg="E", Inst="EQUITY", Sid=1),
                                       expected_sessions={"2026-09-21", "2026-09-22"})
                self.assertEqual(path.read_bytes(), before)

    def test_breadth_requires_all_expected_sessions(self):
        sessions = [(date(2026, 9, 24) - timedelta(days=i)).isoformat() for i in reversed(range(30))]
        breadth = {"quality": {"eligible_symbols": 10}, "records": [
            {"date": day, "eligible_with_candle": 9} for day in sessions]}
        self.assertEqual(inspect_breadth_history(breadth, sessions)["errors"], [])
        breadth["records"] = breadth["records"][-1:]
        self.assertEqual(len(inspect_breadth_history(breadth, sessions)["deficient_sessions"]), 29)
        self.assertTrue(inspect_breadth_history(breadth, sessions[-1:])["errors"])
        for quality in (None, [], "invalid", 1):
            breadth["quality"] = quality
            self.assertTrue(inspect_breadth_history(breadth, sessions)["errors"])

    def test_malformed_session_keeps_other_publication_findings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixture = test_integrity.IntegrityTests()
            data = fixture.fixture(root)
            data["market_breadth_v2.json.gz"]["records"][5]["eligible_with_candle"] = "bad"
            data["all_stocks_fundamental_analysis.json.gz"][0]["as_of_date"] = "2026-09-23"
            for name, value in data.items():
                fixture.write(root, name, value)
            report = inspect_publication(root, today=date(2026, 9, 24))
            self.assertIn("delivery_history", report)
            self.assertIn("rs_ratings", report)
            self.assertEqual(len(report["breadth_history"]["deficient_sessions"]), 1)
            self.assertTrue(any("current stock-history coverage" in error for error in report["errors"]))


if __name__ == "__main__":
    unittest.main()
