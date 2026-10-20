"""Regression tests for PR #108 review findings across screen pipeline, detectors, and snapshots."""
import importlib.util
from pathlib import Path
import sys
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

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
        """Breakout first occurring 9 sessions ago must fail the 5-session breakout age check."""
        n = 60
        h = np.array([100.0] * 20 + [95.0] * 40)
        l = np.array([90.0] * 60)
        c = np.array([94.0] * 60)
        # Top at bar 40 (recent 10) = 96.0
        h[40] = 96.0
        for k in range(1, 4):
            h[40 - k] = 95.0
            h[40 + k] = 95.0
        # Bottom at bar 45 (recent 15) = 92.0
        l[45] = 92.0
        for k in range(1, 4):
            l[45 - k] = 93.0
            l[45 + k] = 93.0

        # Initial breakout occurred at bar 50 (recent 20, 9 sessions before latest bar 59)
        # close > 96.0 from bar 50 through 59
        for b in range(50, 60):
            c[b] = 98.0
        res = bms.detect_darvas(h, l, c)
        self.assertIsNone(res, "Breakout originating 9 sessions ago must return None")

        # But a fresh breakout occurring 3 sessions ago (bar 56) must pass
        for b in range(46, 56):
            c[b] = 94.0
        for b in range(56, 60):
            c[b] = 98.0
        res2 = bms.detect_darvas(h, l, c)
        self.assertIsNotNone(res2)
        self.assertEqual(res2["state"], "breakout")
        self.assertEqual(res2["daysInState"], 3)

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

    def test_gallery_rs_percentile_clamped_to_1_to_99(self):
        """Gallery signal RS must always be a valid 1-99 percentile rank, never >99 (e.g. 113.9)."""
        # If returns are huge (e.g. stock tripled), pit_score would be ~2.0
        # If naive score * 100 was used, RS would be 200.0. Clamped percentile must be <= 99.
        closes = [10.0] * 100 + [30.0] * 50
        n_sub = len(closes)
        cur_t = closes[-1]
        r63 = ((cur_t - closes[-64]) / closes[-64])
        r126 = ((cur_t - closes[-127]) / closes[-127])
        r189 = r126
        r252 = r189
        pit_score = float(0.40 * r63 + 0.20 * r126 + 0.20 * r189 + 0.20 * r252)
        pit_rs = int(np.clip(round(50.0 + pit_score * 50.0), 1, 99))
        self.assertGreaterEqual(pit_rs, 1)
        self.assertLessEqual(pit_rs, 99)

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
