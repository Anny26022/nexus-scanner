"""Unit tests for Historical Snapshot Backfill Engine and Point-in-Time Parity."""

from datetime import date, timedelta
from pathlib import Path
import unittest
import gzip
import hashlib
import importlib.util
import io
import json
import tempfile
from unittest.mock import Mock, patch
import numpy as np
import pandas as pd
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "frontend"))

import generate_historical_snapshots as gen
import backfill_historical_snapshots as backfill
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

    def test_full_generation_recomputes_rs_setups_hash_and_ignores_future_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pipeline, output = root / "pipeline", root / "output"
            cache = pipeline / ".scanner_cache"
            cache.mkdir(parents=True)
            output.mkdir()
            dates = pd.bdate_range("2024-01-01", periods=300)
            target_idx = 280
            session = dates[target_idx].date()
            session_str = session.isoformat()
            master = [
                {"symbol": "A", "rsRating": 99, "rs_rating": 99, "peRatio": 999},
                {"symbol": "B", "rsRating": 1, "rs_rating": 1},
                {"symbol": "STALE", "rsRating": 99},
                {"symbol": "YOUNG", "rsRating": 99},
            ]
            def write_json_gz(path, value):
                with gzip.open(path, "wt", encoding="utf-8") as handle:
                    json.dump(value, handle)
            write_json_gz(pipeline / "all_stocks_fundamental_analysis.json.gz", master)
            # A wins the obsolete one-month-weighted formula; B wins the new formula.
            a = np.full(300, 100.0)
            a[target_idx - 21] = 50
            b = np.full(300, 100.0)
            b[target_idx - 21:target_idx + 1] = 120
            arrays = {"A": a, "B": b, "STALE": np.full(target_idx, 100.0), "YOUNG": np.full(80, 50.0)}
            def write_history(future_multiplier=1):
                combined_dates, combined_values, offsets = [], [], [0]
                for symbol, prices in arrays.items():
                    prices = prices.copy()
                    if symbol in ("A", "B"):
                        prices[target_idx + 1:] *= future_multiplier
                        symbol_dates = dates
                    elif symbol == "STALE":
                        symbol_dates = dates[:target_idx]
                    else:
                        symbol_dates = dates[target_idx - 79:target_idx + 1]
                    combined_dates.extend(symbol_dates.strftime("%Y-%m-%d"))
                    combined_values.extend(np.column_stack((prices, prices + 1, prices - 1, prices, np.full(len(prices), 2_000_000))))
                    offsets.append(len(combined_dates))
                np.savez(cache / "history.npz", revision=np.array(""), symbols=np.array(list(arrays)),
                         offsets=np.array(offsets), dates=np.array(combined_dates), values=np.array(combined_values))
            write_history()
            records = []
            for symbol in ("A", "B"):
                records.extend([
                    {"symbol": symbol, "filing_date": (session - timedelta(days=1)).isoformat(),
                     "quarter_end": "2024-09-30", "net_profit": 100, "eps": 1},
                    {"symbol": symbol, "filing_date": (session + timedelta(days=1)).isoformat(),
                     "quarter_end": "2024-12-31", "net_profit": 9999, "eps": 9999},
                ])
            write_json_gz(pipeline / "quarterly_financial_history.json.gz", {"records": records})
            snapshot_path = output / f"{session_str}.json.gz"
            write_json_gz(snapshot_path, {"revision": "legacy-revision", "stocks": master})
            argv = ["--pipeline-dir", str(pipeline), "--output-dir", str(output),
                    "--start-date", session_str, "--end-date", session_str]
            with patch.object(gen, "fetch_nse_delivery_csv", return_value=[]), \
                 patch.object(gen, "fetch_nse_price_bands", return_value=({}, {})), \
                 patch.object(gen, "fetch_nse_surveillance_for_date", return_value={}):
                generated = gen.main(argv)
                first_bytes = snapshot_path.read_bytes()
                payload = json.loads(gzip.decompress(first_bytes))
                stocks = {stock["symbol"]: stock for stock in payload["stocks"]}
                self.assertEqual(set(stocks), {"A", "B", "YOUNG"})
                self.assertEqual(stocks["A"]["rsRating"], 1)
                self.assertEqual(stocks["B"]["rsRating"], 99)
                self.assertIsNone(stocks["YOUNG"]["rsRating"])
                self.assertEqual(stocks["B"]["close"], 120)
                self.assertEqual(stocks["B"]["quarterlyEps"], 1)
                self.assertEqual(stocks["B"]["stageStatus"]["stage"], 2)
                self.assertTrue(stocks["B"]["presetRuleMatches"]["lib-ms-stage-2"])
                self.assertTrue(stocks["B"]["presetMatches"]["lib-ms-stage-2"])
                self.assertIsInstance(stocks["B"]["setupGeometry"], dict)
                self.assertEqual(payload["screenMethodologyVersion"], "market-strength-v1")
                self.assertIn("R189", payload["relativeStrengthMethodology"]["scoreFormula"])
                self.assertIn("surviving master", payload["relativeStrengthMethodology"]["universe"])
                revision = payload.pop("revision")
                self.assertEqual(revision, hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest())
                self.assertNotEqual(revision, "legacy-revision")
                self.assertEqual(generated, [(session, revision)])
                # Exercise the public backfill command through real generation,
                # R2 byte verification, and the historical-session pointer update.
                objects = {}
                client = Mock()
                client.put_object.side_effect = lambda **kw: objects.update({kw["Key"]: kw["Body"]})
                client.get_object.side_effect = lambda **kw: {"Body": io.BytesIO(objects[kw["Key"]])}
                manifest = Path(tmp) / "sessions.json"
                with patch.object(backfill, "r2_client", return_value=client):
                    self.assertEqual(backfill.main([*argv, "--sessions-manifest", str(manifest), "--upload-r2"]), 0)
                key = f"snapshots/{session_str}/{revision}.json.gz"
                published = json.loads(gzip.decompress(objects[key]))
                self.assertEqual(published["revision"], revision)
                self.assertEqual(next(s for s in published["stocks"] if s["symbol"] == "B")["rsRating"], 99)
                self.assertEqual(json.loads(manifest.read_text())["sessions"][0]["revision"], revision)
                # Future candles must not alter this historical revision or compressed bytes.
                write_history(future_multiplier=10_000)
                self.assertEqual(gen.main(argv), generated)
                self.assertEqual(snapshot_path.read_bytes(), first_bytes)
                # Empty canonical ranks cannot silently switch to the old formula.
                with patch.object(gen, "percentile_rank", return_value={}):
                    gen.main(argv)
                final = json.loads(gzip.decompress(snapshot_path.read_bytes()))
                self.assertTrue(all(stock["rsRating"] is None for stock in final["stocks"]))

    def test_missing_shared_rs_dependency_fails_import(self):
        spec = importlib.util.spec_from_file_location("isolated_historical_generator", ROOT / "tools/generate_historical_snapshots.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"build_rs_ratings": None}):
            with self.assertRaises(ImportError):
                spec.loader.exec_module(module)

    def test_sessions_manifest_update_preserves_history_and_rejects_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sessions.json"
            existing = {"date": "2024-01-01", "revision": "old", "label": "Old"}
            path.write_text(json.dumps({"version": 1, "sessions": [existing]}))
            gen.update_sessions_manifest(path, [(date(2024, 1, 2), "a" * 64)])
            sessions = json.loads(path.read_text())["sessions"]
            self.assertEqual(sessions[0]["revision"], "a" * 64)
            self.assertEqual(sessions[1], existing)
            path.write_text("{broken")
            with self.assertRaises(json.JSONDecodeError):
                gen.update_sessions_manifest(path, [(date(2024, 1, 3), "b" * 64)])
            self.assertEqual(path.read_text(), "{broken")
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_preset_eligibility_keeps_ms_liquidity_in_editable_rule_matches(self):
        item = {"marketCapCrore": 2000, "close": 100, "metrics": {"turnover50": 20},
                "presetRuleMatches": {"lib-stage-two": True, "mom_rvol": True},
                "presetMatches": {"mom_rvol": True}}
        gen.apply_preset_eligibility(item, {"lib-ms-vcp": True}, False)
        self.assertFalse(item["presetRuleMatches"]["lib-ms-vcp"])
        self.assertFalse(item["presetMatches"]["lib-ms-vcp"])
        self.assertTrue(item["presetMatches"]["lib-stage-two"])
        self.assertTrue(item["presetMatches"]["mom_rvol"])

    def test_preset_eligibility_uses_shared_strict_thresholds_and_missing_values(self):
        for field, value, expected in (("marketCapCrore", 1000, False), ("close", 10, False),
                                       ("turnover50", 5, False), ("turnover50", None, None)):
            with self.subTest(field=field, value=value):
                item = {"marketCapCrore": 2000, "close": 100, "metrics": {"turnover50": 20}}
                (item["metrics"] if field == "turnover50" else item)[field] = value
                gen.apply_preset_eligibility(item, {"lib-ms-vcp": True}, True)
                self.assertIs(item["presetMatches"]["lib-ms-vcp"], expected)
                self.assertTrue(item["presetRuleMatches"]["lib-ms-vcp"])

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

    def test_rs_and_setup_geometry_enrichment_parity(self):
        # Verify that compute_stock_returns and calculate_composite_score are imported and working
        self.assertIsNotNone(gen.compute_stock_returns)
        self.assertIsNotNone(gen.calculate_composite_score)
        self.assertIsNotNone(gen.percentile_rank)

        # 200 closes (young stock listing >= 126 sessions)
        c_list = [100.0 * (1.001 ** i) for i in range(200)]
        returns = gen.compute_stock_returns(c_list)
        self.assertIsNotNone(returns)
        self.assertIn("three_month", returns)
        self.assertIn("six_month", returns)
        # Young stock fallback: nine_month and twelve_month should fill from six_month in calculate_composite_score
        score = gen.calculate_composite_score(returns)
        self.assertIsNotNone(score)

        # Verify detect functions are bound
        self.assertIsNotNone(gen.detect_vcp)
        self.assertIsNotNone(gen.detect_darvas)
        self.assertIsNotNone(gen.detect_flags)
        self.assertIsNotNone(gen.detect_cup_with_handle)
        self.assertIsNotNone(gen.detect_tight_weeks)
        self.assertIsNotNone(gen.evaluate_minervini_trend)
        self.assertIsNotNone(gen.evaluate_weinstein_stage)


if __name__ == "__main__":
    unittest.main()
