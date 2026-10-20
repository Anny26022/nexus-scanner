"""Regression tests for PR #108 review findings across screen pipeline, detectors, and snapshots."""
import importlib.util
from pathlib import Path
import sys
import unittest
import json
import tempfile
from unittest.mock import patch
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT.parent) not in sys.path:
    sys.path.insert(0, str(ROOT.parent))

SPEC = importlib.util.spec_from_file_location("build_market_screens", ROOT / "build_market_screens.py")
bms = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bms)


class PipelineReviewRegressionTests(unittest.TestCase):
    def test_darvas_52w_proximity_enforces_5_percent(self):
        """Darvas proximity must enforce box top within 5% of 52-week high, not 15%."""
        # 52W high is 100.0, box top at 90.0 (10% below 52W high)
        # Should return None because 10% > 5%
        highs = np.array([100.0] * 30 + [90.0] * 30)
        lows = np.array([85.0] * 60)
        closes = np.array([88.0] * 60)
        res = bms.detect_darvas(highs, lows, closes)
        self.assertIsNone(res)

        # 52W high is 100.0, box top at 97.0 (3% below 52W high) -> within 5%
        # Candidate top at index 15 (within recent 30 bars)
        n = 60
        h = np.array([100.0] * 20 + [95.0] * 40)
        l = np.array([90.0] * 60)
        c = np.array([94.0] * 60)
        # Set up a peak at recent_h[15] = 97.0
        h[45] = 97.0
        for k in range(1, 4):
            h[45 - k] = 96.0
            h[45 + k] = 96.0
        # Set up a trough at recent_l[20] = 92.0
        l[50] = 92.0
        for k in range(1, 4):
            l[50 - k] = 93.0
            l[50 + k] = 93.0
        c[-1] = 95.0 # confirmed inside box
        res = bms.detect_darvas(h, l, c)
        self.assertIsNotNone(res)
        self.assertEqual(res["state"], "confirmed")

    def test_darvas_chronological_cancellation_on_floor_breach(self):
        """A box that closed below its floor cannot subsequently recover and resurrect."""
        n = 60
        h = np.array([100.0] * 20 + [95.0] * 40)
        l = np.array([94.0] * 60)
        c = np.array([94.0] * 60)
        # Top at bar 45 (recent 15) = 97.0
        h[45] = 97.0
        for k in range(1, 4):
            h[45 - k] = 96.0
            h[45 + k] = 96.0
        # Bottom at bar 50 (recent 20) = 92.0
        l[50] = 92.0
        for k in range(1, 4):
            l[50 - k] = 93.0
            l[50 + k] = 93.0
        # Bar 54 breaches below floor: close = 91.0 < 92.0
        c[54] = 91.0
        # Bar 59 (today) recovers back to 95.0
        c[-1] = 95.0
        res = bms.detect_darvas(h, l, c)
        self.assertIsNone(res, "Floor breach at bar 54 must permanently cancel the box")

    def test_darvas_breakout_age_rejects_breakout_older_than_5_sessions(self):
        highs = np.linspace(80, 99, 60)
        lows, closes = highs - 1, highs - 0.5
        highs[40], lows[45] = 100, 90
        # Strictly rising post-breakout highs cannot form a separate new box.
        highs[50:] = np.linspace(101, 103, 10)
        closes[50:] = 100.5
        self.assertIsNone(bms.detect_darvas(highs, lows, closes))
        closes[50:56] = 98
        result = bms.detect_darvas(highs, lows, closes)
        self.assertEqual(result["state"], "breakout")
        self.assertEqual(result["daysInState"], 3)

    def test_darvas_canceled_box_does_not_hide_a_later_valid_box(self):
        highs = np.linspace(90, 100, 60)
        lows, closes = highs - 1, highs - 0.5
        highs[37], lows[41] = 101, 94
        lows[45], closes[45] = 92, 93  # Cancel the first confirmed box.
        highs[49], lows[53] = 103, 97
        highs[54:] = np.linspace(101.5, 102, 6)
        closes[54:] = 101
        result = bms.detect_darvas(highs, lows, closes)
        self.assertIsNotNone(result)
        self.assertEqual(result["topPrice"], 103)
        self.assertEqual(result["bottomPrice"], 97)
        self.assertEqual(result["state"], "confirmed")

    def test_darvas_breakout_reentry_does_not_reconfirm_old_box(self):
        highs = np.linspace(80, 99, 60)
        lows, closes = highs - 1, highs - 0.5
        highs[40], lows[45] = 100, 90
        highs[50:] = np.linspace(101, 103, 10)
        closes[50:] = 100.5
        closes[-1] = 98.9  # Re-enter the old range after its breakout expired.
        self.assertIsNone(bms.detect_darvas(highs, lows, closes))
        # A fresh breakout stays a breakout event when price returns inside.
        closes[50:56] = 98
        result = bms.detect_darvas(highs, lows, closes)
        self.assertEqual(result["state"], "breakout")
        self.assertEqual(result["daysInState"], 3)

    def test_stale_inputs_rejected_when_dates_mismatch(self):
        """enrich_snapshot_directory must reject stale RS inputs when snapshot date differs."""
        import tempfile, json
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            # Create snapshot with Oct 19 date
            stocks = [{"symbol": "TEST", "as_of_date": "2026-10-19", "close": 100.0}]
            (tmp / "all_stocks_fundamental_analysis.json").write_text(json.dumps(stocks))
            # Create RS artifact with Oct 9 date
            rs_data = {"as_of_date": "2026-10-09", "ratings": {}}
            (tmp / "rs_rating_daily.json").write_text(json.dumps(rs_data))
            ohlcv_dir = tmp / "ohlcv_data"
            ohlcv_dir.mkdir()

            with self.assertRaisesRegex(ValueError, "Stale inputs rejected"):
                bms.enrich_snapshot_directory(tmp, ohlcv_dir=ohlcv_dir)

    @staticmethod
    def write_history(directory, symbol, closes, dates):
        pd.DataFrame({
            "Date": dates, "Open": closes, "High": np.array(closes) + 1,
            "Low": np.array(closes) - 1, "Close": closes, "Volume": 1_000_000,
        }).to_csv(directory / f"{symbol}.csv", index=False)

    def test_gallery_rs_reuses_canonical_formula_and_dated_universe(self):
        from build_rs_ratings import compute_stock_returns, calculate_composite_score, percentile_rank
        with tempfile.TemporaryDirectory() as tmp:
            history = Path(tmp)
            dates = pd.bdate_range("2025-01-01", periods=250).strftime("%Y-%m-%d").tolist()
            a = np.full(250, 100.0)
            a[60], a[186], a[-1] = 50, 150, 200
            b = np.full(250, 100.0)
            b[-1] = 240
            self.write_history(history, "A", a, dates)
            self.write_history(history, "B", b, dates)
            # A short-history IPO and an ineligible high-return stock must not distort ranks.
            self.write_history(history, "YOUNG", np.linspace(100, 500, 80), dates[-80:])
            self.write_history(history, "OUTSIDE", np.linspace(1, 500, 250), dates)
            expected = percentile_rank({
                sym: calculate_composite_score(compute_stock_returns(closes.tolist()))
                for sym, closes in (("A", a), ("B", b))
            })
            actual = bms.precompute_gallery_rs([], history, dates[-1], eligible_by_date={
                dates[-1]: {"A", "B", "YOUNG"},
            })
            self.assertEqual(expected, {"A": 1, "B": 99})
            self.assertEqual(actual[dates[-1]], expected)
            self.assertEqual(bms.precompute_gallery_rs([], history, dates[-1]), {})

    def test_gallery_unknown_dated_universe_leaves_rs_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            history = root / "ohlcv_data"
            history.mkdir()
            dates = pd.bdate_range("2025-01-01", periods=300).strftime("%Y-%m-%d").tolist()
            self.write_history(history, "A", 100 * 1.005 ** np.arange(300), dates)
            (root / "all_stocks_fundamental_analysis.json").write_text(json.dumps([
                {"symbol": "A", "as_of_date": dates[-1]},
            ]))
            (root / "rs_rating_daily.json").write_text(json.dumps({
                "as_of_date": dates[-1], "ratings": {"A": {"composite_rs": 99}},
            }))
            # A historical episode starting within the window must not borrow today's RS.
            def pattern(highs, lows, closes, *args):
                return {"matched": True, "textbook": True} if len(closes) >= 253 else None
            with patch.object(bms, "detect_vcp", side_effect=pattern), \
                 patch.object(bms, "detect_flags", return_value=None), \
                 patch.object(bms, "detect_cup_with_handle", return_value=None):
                self.assertTrue(bms.enrich_snapshot_directory(root))
            items = json.loads((root / "pattern_gallery.json").read_text())["items"]
            self.assertEqual(len(items), 1)
            self.assertIsNone(items[0]["signal_rs"])
            self.assertFalse(items[0]["textbook"])
            self.assertLess(items[0]["signal_trend_score"], 8)
            self.assertIsNone(items[0]["return_60d"])

            # An episode already active before the window is not a new signal.
            # After a one-session gap, the next appearance is a distinct episode.
            def resumed_pattern(highs, lows, closes, *args):
                return None if len(closes) == 200 else {"matched": True, "textbook": True}
            with patch.object(bms, "detect_vcp", side_effect=resumed_pattern), \
                 patch.object(bms, "detect_flags", return_value=None), \
                 patch.object(bms, "detect_cup_with_handle", return_value=None):
                self.assertTrue(bms.enrich_snapshot_directory(root))
            items = json.loads((root / "pattern_gallery.json").read_text())["items"]
            self.assertEqual([item["signal_date"] for item in items], [dates[200]])

    def test_missing_short_and_stale_histories_clear_old_enrichment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            history = root / "ohlcv_data"
            history.mkdir()
            dates = pd.bdate_range("2025-01-01", periods=250).strftime("%Y-%m-%d").tolist()
            stocks = []
            # Ten stale files before the fresh symbol must not cause an arbitrary probe abort.
            for i in range(10):
                sym = f"STALE{i}"
                self.write_history(history, sym, np.linspace(100, 200, 249), dates[:-1])
                stocks.append({"symbol": sym})
            stocks.extend({"symbol": sym} for sym in ("MISSING", "SHORT", "FRESH"))
            self.write_history(history, "SHORT", np.full(10, 100), dates[-10:])
            self.write_history(history, "FRESH", np.linspace(100, 200, 250), dates)
            for stock in stocks:
                stock.update({"as_of_date": dates[-1], "unrelated": "keep", "setupGeometry": True,
                              "upcomingEarnings": True, "isLiquidScreen": True,
                              "isRsLine52wHigh": True, "trendTemplate": True})
            (root / "all_stocks_fundamental_analysis.json").write_text(json.dumps(stocks))
            (root / "rs_rating_daily.json").write_text(json.dumps({
                "as_of_date": dates[-1], "ratings": {"FRESH": {"composite_rs": 99}},
            }))
            self.assertTrue(bms.enrich_snapshot_directory(root, generate_gallery=False))
            output = json.loads((root / "all_stocks_fundamental_analysis.json").read_text())
            for stock in output:
                self.assertEqual(stock["unrelated"], "keep")
                if stock["symbol"] != "FRESH":
                    for field in ("setupGeometry", "trendTemplate", "upcomingEarnings",
                                  "isLiquidScreen", "isRsLine52wHigh"):
                        self.assertIsNone(stock[field], (stock["symbol"], field))
                else:
                    self.assertIsInstance(stock["setupGeometry"], dict)

    def test_darvas_last_five_sessions_excludes_age_five(self):
        highs = np.linspace(80, 99, 60)
        lows, closes = highs - 1, highs - 0.5
        highs[40], lows[45] = 100, 90
        highs[54:], closes[54:] = 101, 100.5
        self.assertIsNone(bms.detect_darvas(highs, lows, closes))
        closes[54] = 98
        result = bms.detect_darvas(highs, lows, closes)
        self.assertEqual(result["daysInState"], 4)
        self.assertEqual(result["state"], "breakout")

    def test_backend_scanner_bridge_rejects_rs_when_dates_differ(self):
        """scanner_bridge must return None for RS condition when context rs_ratings_as_of != as_of."""
        from frontend import scanner_bridge
        node = {"type": "condition", "kind": "MS_RS_LEADERS_80"}
        stock = {"symbol": "INFY", "as_of_date": "2026-10-19"}
        context = {
            "rs_ratings_as_of": "2026-10-09", # Different date!
            "rs_ratings": {"INFY": {"front_weighted": 90}},
        }
        diagnostics = set()
        res = scanner_bridge.evaluate(node, stock, None, context, "2026-10-19", diagnostics, {})
        self.assertIsNone(res, "Must not accept RS rating from mismatched date")
        self.assertIn(("rs_rating", "dated_rs_ratings_unavailable"), diagnostics)

    def test_backend_scanner_bridge_accepts_rs_when_dates_match(self):
        """scanner_bridge accepts RS rating when dates match."""
        from frontend import scanner_bridge
        node = {"type": "condition", "kind": "MS_RS_LEADERS_80"}
        stock = {"symbol": "INFY", "as_of_date": "2026-10-19"}
        context = {
            "rs_ratings_as_of": "2026-10-19", # Matching date!
            "rs_ratings": {"INFY": {"front_weighted": 90}},
        }
        diagnostics = set()
        res = scanner_bridge.evaluate(node, stock, None, context, "2026-10-19", diagnostics, {})
        self.assertTrue(res)


if __name__ == "__main__":
    unittest.main()
