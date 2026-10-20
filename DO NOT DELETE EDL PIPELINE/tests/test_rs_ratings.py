import importlib.util
import math
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SPEC = importlib.util.spec_from_file_location("build_rs_ratings", ROOT / "build_rs_ratings.py")
rs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rs)


class MarketStrengthRsTests(unittest.TestCase):
    def test_computes_multi_horizon_stock_returns(self):
        # 260 days of prices from 100 growing to 200
        closes = [100.0 + i * (100.0 / 260.0) for i in range(260)]
        returns = rs.compute_stock_returns(closes, offset=0)
        self.assertIsNotNone(returns)
        self.assertIn("three_month", returns)
        self.assertIn("six_month", returns)
        self.assertIn("nine_month", returns)
        self.assertIn("twelve_month", returns)
        self.assertIn("one_month", returns)

        # 3-month lookback is 63 bars
        expected_3m = (closes[-1] / closes[-1 - 63]) - 1.0
        self.assertAlmostEqual(returns["three_month"], expected_3m)

    def test_rejects_insufficient_history(self):
        # Less than 126 sessions should return None
        short_closes = [100.0] * 120
        self.assertIsNone(rs.compute_stock_returns(short_closes, offset=0))

    def test_rejects_invalid_price_endpoints(self):
        valid = [100.0] * 200
        for bad_val in (0.0, -5.0, float("nan"), float("inf")):
            with self.subTest(bad_val=bad_val):
                bad_closes = valid.copy()
                bad_closes[-1] = bad_val
                self.assertIsNone(rs.compute_stock_returns(bad_closes, offset=0))

    def test_weighted_composite_score_formula(self):
        # 3m: 10%, 6m: 20%, 9m: 30%, 12m: 40%
        ret = {
            "three_month": 0.10,
            "six_month": 0.20,
            "nine_month": 0.30,
            "twelve_month": 0.40,
        }
        # Expected: 0.40*0.10 + 0.20*0.20 + 0.20*0.30 + 0.20*0.40 = 0.04 + 0.04 + 0.06 + 0.08 = 0.22
        score = rs.calculate_composite_score(ret)
        self.assertAlmostEqual(score, 0.22)

    def test_six_month_return_fills_missing_longer_windows(self):
        # Only 3m and 6m available: 6m return substitutes missing 9m and 12m
        ret = {
            "three_month": 0.15,
            "six_month": 0.30,
        }
        # 0.40 * 0.15 + 0.20 * 0.30 + 0.20 * 0.30 + 0.20 * 0.30 = 0.06 + 0.18 = 0.24
        score = rs.calculate_composite_score(ret)
        self.assertAlmostEqual(score, 0.24)

    def test_percentile_rank_bounds_and_ordering(self):
        scores = {"A": 0.50, "B": 0.10, "C": 0.30}
        ranked = rs.percentile_rank(scores)
        self.assertEqual(ranked["B"], 1)
        self.assertEqual(ranked["A"], 99)
        self.assertEqual(ranked["C"], 50)

    def test_single_stock_percentile(self):
        single = {"A": 0.25}
        ranked = rs.percentile_rank(single)
        self.assertEqual(ranked["A"], 50)

    def test_rs_line_52w_high_detection(self):
        dates = pd.date_range("2026-01-01", periods=100, freq="B")
        benchmark = pd.DataFrame({"Date": dates, "Close": [100.0] * 100})
        # Stock outperforming and hitting new relative high on last day
        stock_high = pd.DataFrame({"Date": dates, "Close": [100.0] * 99 + [150.0]})
        self.assertTrue(rs.check_rs_line_52w_high(stock_high, benchmark))

        # Stock declining on last day
        stock_low = pd.DataFrame({"Date": dates, "Close": [100.0] * 99 + [80.0]})
        self.assertFalse(rs.check_rs_line_52w_high(stock_low, benchmark))

    def test_publication_saves_expected_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "indices_ohlcv_data").mkdir()
            (root / "ohlcv_data").mkdir()
            dates = pd.bdate_range(end="2026-10-09", periods=200)
            frame = pd.DataFrame({"Date": dates, "Close": [100.0 + i for i in range(200)]})
            frame.to_csv(root / "indices_ohlcv_data/NIFTY_500.csv", index=False)
            frame.to_csv(root / "ohlcv_data/TEST.csv", index=False)

            with patch.object(rs, "BASE_DIR", root), \
                 patch.object(rs, "liquid_universe", return_value=({"TEST"}, "fixture")), \
                 patch.object(rs, "compress_file"):
                self.assertTrue(rs.main())

            output_file = root / "rs_rating_daily.json"
            self.assertTrue(output_file.exists())
            import json
            with open(output_file) as f:
                payload = json.load(f)

            self.assertEqual(payload["methodology"]["version"], "marketstrength_parity_v1")
            self.assertEqual(payload["as_of_date"], "2026-10-09")
            self.assertIn("TEST", payload["ratings"])
            test_rating = payload["ratings"]["TEST"]
            self.assertIn("front_weighted", test_rating)
            self.assertIn("composite_rs", test_rating)
            self.assertIn("rs_change_21d", test_rating)
            self.assertIn("is_rs_line_52w_high", test_rating)


if __name__ == "__main__":
    unittest.main()
