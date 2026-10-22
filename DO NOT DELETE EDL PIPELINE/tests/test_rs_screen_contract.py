"""Cross-path regressions for the single dated RS/setup contract."""
import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build_rs_ratings as rs
import build_market_screens as screens


class DatedScreenContractTests(unittest.TestCase):
    def setUp(self):
        self.dates = pd.bdate_range("2025-01-01", periods=300).strftime("%Y-%m-%d").tolist()
        self.histories = {symbol: (self.dates, np.exp(np.arange(300) * growth) * 100)
                          for symbol, growth in (("A", .001), ("B", .002), ("X", .003))}

    def test_rank_uses_only_the_dated_universe_and_exact_session(self):
        date = self.dates[-2]
        ranks = rs.rank_session(self.histories, date, {"A", "B"})
        self.assertEqual(ranks["B"]["composite_rs"], 99)
        self.assertNotIn("X", ranks)
        stale = {"B": (self.dates[:-2], self.histories["B"][1][:-2])}
        self.assertEqual(rs.rank_session(stale, date, {"B"}), {})

    def test_daily_delta_uses_prior_membership_on_common_market_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ohlcv_data").mkdir()
            (root / "indices_ohlcv_data").mkdir()
            for symbol, (dates, closes) in self.histories.items():
                pd.DataFrame({"Date": dates, "Close": closes}).to_csv(root / "ohlcv_data" / f"{symbol}.csv", index=False)
            pd.DataFrame({"Date": self.dates, "Close": np.full(300, 100.)}).to_csv(
                root / "indices_ohlcv_data/NIFTY_500.csv", index=False)
            previous = self.dates[-22]
            rs.save_universe_history(root, {previous: {"A", "B", "X"}})
            with patch.object(rs, "BASE_DIR", root), patch.object(rs, "liquid_universe", return_value=({"A", "B"}, "fixture")):
                self.assertTrue(rs.main())
            payload = json.loads((root / "rs_rating_daily.json").read_text())
            self.assertEqual(payload["ratings"]["B"]["rs_change_21d"], 49)
            self.assertEqual(rs.load_universe_history(root)[previous], {"A", "B", "X"})
            # Gallery and daily must consume exactly the same rank function.
            gallery = screens.precompute_gallery_rs([], root / "ohlcv_data", self.dates[-1],
                                                     eligible_by_date=rs.load_universe_history(root))
            self.assertEqual(gallery[self.dates[-1]]["B"], payload["ratings"]["B"]["composite_rs"])

    def test_missing_prior_universe_is_unknown_and_wrong_version_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(rs.load_universe_history(root), {})
            with gzip.open(root / rs.UNIVERSE_HISTORY_FILE, "wt") as handle:
                json.dump({"methodology_version": "old", "sessions": {}}, handle)
            with self.assertRaisesRegex(ValueError, "methodology mismatch"):
                rs.load_universe_history(root)

    def test_precomputed_atr_preserves_setup_results_and_myb_boundary(self):
        dates = pd.bdate_range("2023-01-01", periods=750).strftime("%Y-%m-%d").tolist()
        c = np.full(750, 80.); h = np.full(750, 90.); l = np.full(750, 70.); v = np.full(750, 1e6)
        c[-1], h[-1], l[-1], h[499] = 101., 102., 100., 100.
        direct = screens.evaluate_setups(h, l, c, v, dates, 80)
        atr10 = screens.calculate_atr_series(h, l, c, 10)
        atr50 = screens.calculate_atr_series(h, l, c, 50)
        cached = screens.evaluate_setups(h, l, c, v, dates, 80, atr10[-1] / atr50[-1])
        self.assertEqual(direct, cached)
        self.assertEqual(direct["setup_geometry"]["multiYearBreakout"]["ceilingHeldDays"], 250)
        h[499], h[500] = 90., 100.
        self.assertIsNone(screens.evaluate_setups(h, l, c, v, dates, 80)["setup_geometry"]["multiYearBreakout"])

    def test_gallery_loads_archived_membership_and_records_signal_liquidity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "ohlcv_data").mkdir()
            c = self.histories["B"][1]
            pd.DataFrame({"Date": self.dates, "Open": c, "High": c * 1.01,
                          "Low": c * .99, "Close": c, "Volume": np.full(300, 1e6)}).to_csv(root / "ohlcv_data/B.csv", index=False)
            (root / "all_stocks_fundamental_analysis.json").write_text(json.dumps([
                {"symbol": "B", "as_of_date": self.dates[-1]}]))
            (root / "rs_rating_daily.json").write_text(json.dumps({"as_of_date": self.dates[-1], "ratings": {}}))
            signal_date = self.dates[-2]
            rs.save_universe_history(root, {signal_date: {"B"}, self.dates[-1]: {"B"}})
            def signal(highs, lows, closes, volumes, dates):
                return {"matched": True, "textbook": True} if len(closes) == 299 else None
            with patch.object(screens, "detect_vcp", side_effect=signal):
                screens.enrich_snapshot_directory(root)
            gallery = json.loads((root / "pattern_gallery.json").read_text())
            event = next(item for item in gallery["items"] if item["pattern"] == "VCP")
            self.assertEqual(event["signal_date"], signal_date)
            self.assertEqual(event["signal_rs"], 50)
            self.assertTrue(event["signal_is_liquid"])
            self.assertGreater(event["signal_traded_value_mean_20d_cr"], 10)
            self.assertIsNone(event["return_5d"])


if __name__ == "__main__":
    unittest.main()
