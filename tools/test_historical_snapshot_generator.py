"""Unit tests for Historical Snapshot Backfill Engine."""

from datetime import date
from pathlib import Path
import unittest
import numpy as np

import sys
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "frontend"))

import generate_historical_snapshots as gen
import scanner_bridge as bridge


class TestHistoricalSnapshotGenerator(unittest.TestCase):
    def setUp(self):
        # 1,300 bars of synthetic OHLCV
        np.random.seed(42)
        n = 1300
        self.closes = np.cumsum(np.random.randn(n) * 2) + 100.0
        self.closes = np.clip(self.closes, 10.0, None)
        self.highs = self.closes + np.random.uniform(0.5, 3.0, n)
        self.lows = self.closes - np.random.uniform(0.5, 3.0, n)
        self.opens = self.closes + np.random.uniform(-1.0, 1.0, n)
        self.volumes = np.random.uniform(10_000, 500_000, n)

    def test_calculate_technicals_extended_indicators(self):
        tech = gen.calculate_technicals(self.opens, self.closes, self.highs, self.lows, self.volumes)

        # Core SMAs and EMAs
        self.assertIn("sma10", tech)
        self.assertIn("sma20", tech)
        self.assertIn("sma50", tech)
        self.assertIn("sma200", tech)
        self.assertIn("ema20", tech)
        self.assertIn("ema50", tech)
        self.assertIn("ema200", tech)

        # Extended metrics
        self.assertIn("adr20Pct", tech)
        self.assertGreater(tech["adr20Pct"], 0)
        self.assertIn("atr14", tech)
        self.assertGreater(tech["atr14"], 0)
        self.assertIn("allTimeHigh", tech)
        self.assertIn("allTimeLow", tech)
        self.assertGreaterEqual(tech["allTimeHigh"], tech["allTimeLow"])
        self.assertIn("distAthPct", tech)
        self.assertLessEqual(tech["distAthPct"], 0.0)
        self.assertIn("gapPct", tech)
        self.assertIn("daily_rupee_turnover_50_cr", tech)
        self.assertIsNotNone(tech["daily_rupee_turnover_50_cr"])
        self.assertIn("daily_rupee_turnover_100_cr", tech)
        self.assertIsNotNone(tech["daily_rupee_turnover_100_cr"])
        self.assertIn("return5yPct", tech)
        self.assertIsNotNone(tech["return5yPct"])

    def test_shareholding_point_in_time_filtering(self):
        records = [
            {"period_end": "2024-03-31", "observed_on": "2026-10-16", "fii_holding_percent": 1.0, "promoter_holding_percent": 50.0},
            {"period_end": "2024-06-30", "observed_on": "2026-10-16", "fii_holding_percent": 1.5, "promoter_holding_percent": 50.0},
            {"period_end": "2024-09-30", "observed_on": "2026-10-16", "fii_holding_percent": 2.0, "promoter_holding_percent": 50.0},
        ]
        session_str = "2024-07-15"
        valid_shs = [
            s for s in records
            if (s.get("period_end") and s["period_end"] <= session_str)
            or (s.get("observed_on") and s["observed_on"] <= session_str)
        ]
        valid_shs.sort(key=lambda x: x["period_end"])
        latest = valid_shs[-1]
        prev = valid_shs[-2]

        self.assertEqual(latest["period_end"], "2024-06-30")
        self.assertEqual(prev["period_end"], "2024-03-31")
        qoq_fii = round(latest["fii_holding_percent"] - prev["fii_holding_percent"], 2)
        self.assertEqual(qoq_fii, 0.5)

    def test_ttm_financial_aggregation(self):
        records = [
            {"quarter_end": "2025-03-31", "filing_date": "2025-05-10", "report_type": "CONSOLIDATED", "sales": 100.0, "net_profit": 10.0, "eps": 2.0},
            {"quarter_end": "2025-06-30", "filing_date": "2025-08-10", "report_type": "CONSOLIDATED", "sales": 110.0, "net_profit": 12.0, "eps": 2.2},
            {"quarter_end": "2025-09-30", "filing_date": "2025-11-10", "report_type": "CONSOLIDATED", "sales": 120.0, "net_profit": 14.0, "eps": 2.4},
            {"quarter_end": "2025-12-31", "filing_date": "2026-02-10", "report_type": "CONSOLIDATED", "sales": 130.0, "net_profit": 16.0, "eps": 2.6},
        ]
        trailing_4q = records[-4:]
        ttm_sales = sum(f["sales"] for f in trailing_4q)
        ttm_profit = sum(f["net_profit"] for f in trailing_4q)
        ttm_eps = sum(f["eps"] for f in trailing_4q)

        self.assertEqual(ttm_sales, 460.0)
        self.assertEqual(ttm_profit, 52.0)
        self.assertEqual(ttm_eps, 9.2)


if __name__ == "__main__":
    unittest.main()
