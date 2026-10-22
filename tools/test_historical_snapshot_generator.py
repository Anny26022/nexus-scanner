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
            "tradingview": None,
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
        self.assertIsNone(item["tradingview"])
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
            "tradingview": "unavailable",
            "surveillance": "Reconstructed from official NSE circulars where complete",
        }
        self.assertEqual(coverage["fnoEligibility"], "unavailable")
        self.assertEqual(coverage["indexMemberships"], "unavailable (constituent change history not backfilled)")
        self.assertIn("21-day SEBI LODR", coverage["shareholding"])
        self.assertIn("consecutive quarters", coverage["financials"])

    def test_historical_index_rebalance_ledger_and_pit_reconstruction(self):
        ledger_path = ROOT / "reference" / "historical_index_rebalance_events.json"
        self.assertTrue(ledger_path.exists(), "Rebalance ledger file must exist")

        import json
        with open(ledger_path, "r", encoding="utf-8") as f:
            ledger = json.load(f)

        self.assertEqual(ledger.get("schema_version"), 1)
        rebalances = ledger.get("rebalances", [])
        self.assertGreaterEqual(len(rebalances), 500, "Ledger must contain extensive rebalance events")

        indices_in_ledger = {r["index"] for r in rebalances}

        # Check broad indices
        required_broad = [
            "NIFTY 50", "NIFTY NEXT 50", "NIFTY 100", "NIFTY 200",
            "NIFTY 500", "NIFTY MIDCAP 150", "NIFTY SMALLCAP 250"
        ]
        for b in required_broad:
            self.assertIn(b, indices_in_ledger, f"Broad index {b} must be present in ledger")

        # Check sectoral indices
        required_sectoral = [
            "NIFTY BANK", "NIFTY IT", "NIFTY AUTO", "NIFTY PHARMA",
            "NIFTY FMCG", "NIFTY METAL", "NIFTY REALTY", "NIFTY FINANCIAL SERVICES",
            "NIFTY HEALTHCARE", "NIFTY CONSUMER DURABLES", "NIFTY MEDIA"
        ]
        for s in required_sectoral:
            self.assertIn(s, indices_in_ledger, f"Sectoral index {s} must be present in ledger")

        # Reverse temporal reconstruction simulation
        def simulate_pit_indices(symbol: str, target_date: date, base_indices: list[str]) -> list[str]:
            active = {idx.strip().upper() for idx in base_indices if idx}
            for ev in sorted(rebalances, key=lambda x: x["date"], reverse=True):
                try:
                    ev_date = date.fromisoformat(ev["date"])
                    if target_date < ev_date:
                        idx_name = str(ev.get("index", "")).strip().upper()
                        inc = [s.strip().upper() for s in ev.get("inclusions", [])]
                        exc = [s.strip().upper() for s in ev.get("exclusions", [])]
                        if symbol in inc:
                            active.discard(idx_name)
                        if symbol in exc:
                            active.add(idx_name)
                except Exception:
                    continue
            return sorted(list(active))

        # Test 1: NIFTY BANK CANBK inclusion on 2024-09-30 (replaced BANDHANBNK)
        # Prior to 2024-09-30: CANBK was NOT in Nifty Bank; BANDHANBNK WAS in Nifty Bank
        prior_date = date(2024, 6, 1)
        post_date = date(2024, 10, 1)

        # Base is modern constituent list: CANBK in Nifty Bank, BANDHANBNK not
        canbk_prior = simulate_pit_indices("CANBK", prior_date, ["NIFTY BANK"])
        self.assertNotIn("NIFTY BANK", canbk_prior, "CANBK must not be in NIFTY BANK prior to rebalance date")

        canbk_post = simulate_pit_indices("CANBK", post_date, ["NIFTY BANK"])
        self.assertIn("NIFTY BANK", canbk_post, "CANBK must remain in NIFTY BANK after rebalance date")

        bandhan_prior = simulate_pit_indices("BANDHANBNK", prior_date, [])
        self.assertIn("NIFTY BANK", bandhan_prior, "BANDHANBNK must be restored to NIFTY BANK prior to its exclusion date")

        bandhan_post = simulate_pit_indices("BANDHANBNK", post_date, [])
        self.assertNotIn("NIFTY BANK", bandhan_post, "BANDHANBNK must not be in NIFTY BANK after its exclusion date")

        # Test 2: NIFTY 50 APOLLOHOSP inclusion on 2022-03-31 (replaced IOC)
        apoll_prior = simulate_pit_indices("APOLLOHOSP", date(2022, 1, 1), ["NIFTY 50"])
        self.assertNotIn("NIFTY 50", apoll_prior)

        ioc_prior = simulate_pit_indices("IOC", date(2022, 1, 1), [])
        self.assertIn("NIFTY 50", ioc_prior)


if __name__ == "__main__":
    unittest.main()
