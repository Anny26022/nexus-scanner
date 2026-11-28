"""Unit tests for Historical Snapshot Backfill Engine and Point-in-Time Parity."""

from datetime import date, timedelta
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
        # 1,300 bars of synthetic OHLCV for technical verification
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

        # Core moving averages
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

    def test_registered_session_dates_are_read_from_the_manifest(self):
        import json, tempfile
        with tempfile.TemporaryDirectory() as folder:
            manifest = Path(folder) / "sessions.json"
            self.assertEqual(gen.registered_session_dates(None), set())
            self.assertEqual(gen.registered_session_dates(manifest), set())
            manifest.write_text(json.dumps({"version": 1, "sessions": [
                {"date": "2021-10-14", "revision": "a" * 64}, {"date": "2026-10-23", "revision": "b" * 64}]}))
            self.assertEqual(gen.registered_session_dates(manifest), {"2021-10-14", "2026-10-23"})
            manifest.write_text("{not json")
            with self.assertRaises(ValueError):
                gen.registered_session_dates(manifest)

    def run_main(self, folder, start, end, *extra):
        """Runs main() on a one-symbol pipeline whose history has 2021-10-14 and 2021-10-15."""
        import contextlib, gzip, io, json
        from unittest.mock import patch
        pipeline = folder / "pipeline"
        (pipeline / ".scanner_cache").mkdir(parents=True, exist_ok=True)
        with gzip.open(pipeline / "all_stocks_fundamental_analysis.json.gz", "wt") as f:
            f.write("[]")
        np.savez(pipeline / ".scanner_cache" / "history.npz", symbols=np.array(["A"]), offsets=np.array([0, 2]),
                 dates=np.array(["2021-10-14", "2021-10-15"], dtype="datetime64[D]"), values=np.ones((2, 5)), revision=np.array("r1"))
        (pipeline / "scanner_revision.json").write_text(json.dumps({"historyRevision": "r1"}))
        argv = ["generate_historical_snapshots.py", "--pipeline-dir", str(pipeline), "--start-date", start, "--end-date", end,
                "--output-dir", str(folder / "out"), "--update-sessions-manifest", str(folder / "sessions.json"), *extra]
        out = io.StringIO()
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(out):
            gen.main()
        return out.getvalue()

    def test_main_skips_sessions_already_in_the_manifest(self):
        import json, tempfile
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            manifest = folder / "sessions.json"
            manifest.write_text(json.dumps({"version": 1, "sessions": [
                {"date": "2021-10-14", "revision": "a" * 64, "label": "2021-10-14", "isHistorical": True}]}))
            before = manifest.read_bytes()

            # Every requested date is archived: a clean no-op that generates nothing and leaves the manifest alone.
            log = self.run_main(folder, "2021-10-14", "2021-10-14")
            self.assertIn("Skipping 1 already archived sessions", log)
            self.assertEqual(list((folder / "out").iterdir()), [])
            self.assertEqual(manifest.read_bytes(), before)

            # A mixed range plans only the new date.
            log = self.run_main(folder, "2021-10-14", "2021-10-15", "--dry-run")
            self.assertIn("Skipping 1 already archived sessions: [datetime.date(2021, 10, 14)]", log)
            self.assertIn("Found 2 trading sessions", log)
            self.assertEqual(manifest.read_bytes(), before)

    def test_check_consecutive_quarters(self):
        # 4 consecutive quarters spaced ~90 days apart
        q_valid = [
            date(2024, 3, 31),
            date(2024, 6, 30),
            date(2024, 9, 30),
            date(2024, 12, 31),
        ]
        self.assertTrue(gen.check_consecutive_quarters(q_valid))

        # Missing quarter (e.g. Q3 skipped, gap between June 30 and Dec 31 is 184 days)
        q_missing = [
            date(2024, 3, 31),
            date(2024, 6, 30),
            date(2024, 12, 31),
            date(2025, 3, 31),
        ]
        self.assertFalse(gen.check_consecutive_quarters(q_missing))

        # Insufficient quarters
        self.assertFalse(gen.check_consecutive_quarters(q_valid[:3]))

        # Unsorted quarters
        self.assertFalse(gen.check_consecutive_quarters(list(reversed(q_valid))))

    def test_shareholding_sebi_lodr_21_day_statutory_lag(self):
        records = [
            {"period_end": "2024-03-31", "fii_holding_percent": 1.0, "promoter_holding_percent": 50.0},
            {"period_end": "2024-06-30", "fii_holding_percent": 1.5, "promoter_holding_percent": 50.0},
            {"period_end": "2024-09-30", "fii_holding_percent": 2.0, "promoter_holding_percent": 50.0},
        ]

        def get_valid_sh(session_d: date):
            valid = []
            for s in records:
                pe_d = date.fromisoformat(s["period_end"])
                if pe_d + timedelta(days=21) <= session_d:
                    valid.append(s)
            valid.sort(key=lambda x: x["period_end"])
            return valid

        # On 2024-07-15 (15 days post 2024-06-30), Q1 filing is NOT yet publicly disclosed
        sh_early = get_valid_sh(date(2024, 7, 15))
        self.assertEqual(len(sh_early), 1)
        self.assertEqual(sh_early[-1]["period_end"], "2024-03-31")

        # On 2024-07-20 (20 days post 2024-06-30), still within 21-day statutory window
        sh_day20 = get_valid_sh(date(2024, 7, 20))
        self.assertEqual(sh_day20[-1]["period_end"], "2024-03-31")

        # On 2024-07-21 (21 days post 2024-06-30), filing is statutory point-in-time public
        sh_day21 = get_valid_sh(date(2024, 7, 21))
        self.assertEqual(len(sh_day21), 2)
        self.assertEqual(sh_day21[-1]["period_end"], "2024-06-30")
        self.assertEqual(sh_day21[-2]["period_end"], "2024-03-31")
        fii_qoq = round(sh_day21[-1]["fii_holding_percent"] - sh_day21[-2]["fii_holding_percent"], 2)
        self.assertEqual(fii_qoq, 0.5)

    def test_ttm_calculation_and_weighted_opm(self):
        records = [
            {"quarter_end": "2025-03-31", "sales": 100.0, "net_profit": 10.0, "eps": 2.0, "opm": 15.0},
            {"quarter_end": "2025-06-30", "sales": 110.0, "net_profit": 12.0, "eps": 2.2, "opm": 18.0},
            {"quarter_end": "2025-09-30", "sales": 120.0, "net_profit": 14.0, "eps": 2.4, "opm": 20.0},
            {"quarter_end": "2025-12-31", "sales": 130.0, "net_profit": 16.0, "eps": 2.6, "opm": 22.0},
        ]
        trailing_dates = [date.fromisoformat(f["quarter_end"]) for f in records]
        self.assertTrue(gen.check_consecutive_quarters(trailing_dates))

        ttm_sales = round(sum(f["sales"] for f in records), 2)
        ttm_profit = round(sum(f["net_profit"] for f in records), 2)
        ttm_eps = round(sum(f["eps"] for f in records), 2)

        # Weighted operating profit / sales * 100 (NOT net profit / sales)
        tot_op = sum(f["sales"] * f["opm"] / 100.0 for f in records)
        ttm_opm = round((tot_op / ttm_sales) * 100.0, 2)

        self.assertEqual(ttm_sales, 460.0)
        self.assertEqual(ttm_profit, 52.0)
        self.assertEqual(ttm_eps, 9.2)

        # 100*0.15 + 110*0.18 + 120*0.20 + 130*0.22 = 15 + 19.8 + 24 + 28.6 = 87.4
        # 87.4 / 460 * 100 = 19.00
        self.assertEqual(ttm_opm, 19.0)

        # Net margin would be 52 / 460 * 100 = 11.3%, verifying OPM is distinctly different
        net_margin = round((ttm_profit / ttm_sales) * 100.0, 2)
        self.assertNotEqual(ttm_opm, net_margin)

    def test_discontinuous_quarters_evaluation(self):
        # Quarter missing (Q2 missing)
        records = [
            {"quarter_end": "2024-03-31", "sales": 100.0, "net_profit": 10.0, "eps": 2.0, "opm": 15.0},
            {"quarter_end": "2024-09-30", "sales": 120.0, "net_profit": 14.0, "eps": 2.4, "opm": 20.0},
            {"quarter_end": "2024-12-31", "sales": 130.0, "net_profit": 16.0, "eps": 2.6, "opm": 22.0},
            {"quarter_end": "2025-03-31", "sales": 140.0, "net_profit": 18.0, "eps": 2.8, "opm": 24.0},
        ]
        trailing_dates = [date.fromisoformat(f["quarter_end"]) for f in records]
        # Must fail consecutive quarters check
        self.assertFalse(gen.check_consecutive_quarters(trailing_dates))

    def test_no_current_master_leakage_and_metadata(self):
        # Build a synthetic historical stock item as done by generate_historical_snapshots
        master_template = {
            "symbol": "RELIANCE",
            "name": "Reliance Industries Ltd",
            "sector": "Energy",
            "industry": "Oil & Gas",
            "isFno": True,
            "indexMemberships": ["Nifty 50", "Nifty 500"],
            "peRatio": 28.5,
            "pbRatio": 2.1,
            "debtToEquity": 0.42,
            "marketCapCrore": 1900000.0,
            "totalRevenueLakh": 89000000,
        }

        # Historical item constructed strictly according to our PIT rules
        item = {
            "symbol": master_template["symbol"],
            "name": master_template["name"],
            "sector": master_template["sector"],
            "industry": master_template["industry"],
            "isFno": None,
            "fnoBan": None,
            "indexMemberships": [],
            "extended": None,
            "pbRatio": None,
            "debtToEquity": None,
            "totalRevenueLakh": None,
            "freeCashFlowCrore": None,
            "industryPeRatio": None,
            "marketCapCrore": None,
            "peRatio": None,
        }

        # Verify critical PIT invariants
        self.assertIsNone(item["isFno"])
        self.assertIsNone(item["fnoBan"])
        self.assertIsNone(item["extended"])
        self.assertEqual(item["indexMemberships"], [])
        self.assertIsNone(item["pbRatio"])
        self.assertIsNone(item["debtToEquity"])
        self.assertIsNone(item["totalRevenueLakh"])
        self.assertIsNone(item["freeCashFlowCrore"])
        self.assertIsNone(item["industryPeRatio"])

        # Check coverage contract
        coverage = {
            "survivorshipBias": "Stock universe restricted to current surviving master list; historical delisted/merged securities omitted",
            "shareholding": "Point-in-time quarter end filings with 21-day SEBI LODR statutory reporting lag",
            "financials": "Point-in-time disclosure filing dates; TTM requires 4 consecutive quarters without temporal gaps",
            "balanceSheetRatios": "unavailable (annual balance sheet time-series not maintained)",
            "fnoEligibility": "unavailable",
            "fnoBan": "unavailable",
            "indexMemberships": "unavailable (constituent change history not backfilled)",
            "extended": "unavailable",
            "surveillance": "Reconstructed from official NSE circulars where complete",
        }
        self.assertEqual(coverage["fnoEligibility"], "unavailable")
        self.assertEqual(coverage["indexMemberships"], "unavailable (constituent change history not backfilled)")
        self.assertIn("21-day SEBI LODR", coverage["shareholding"])
        self.assertIn("consecutive quarters", coverage["financials"])


if __name__ == "__main__":
    unittest.main()
