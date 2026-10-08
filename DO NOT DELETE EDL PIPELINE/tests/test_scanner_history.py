import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edl_pipeline.scanner.history import build_snapshot, load_snapshot
from edl_pipeline.scanner.earnings import merge_observations, select_observation
from edl_pipeline.scanner.shareholding import observations_from_fundamentals, select_observation as select_shareholding_observation


class ScannerHistoryTests(unittest.TestCase):
    def test_statement_history_is_not_backfilled_before_observation(self):
        stocks = [{"symbol": "TEST", "ttm_revenue_growth_percent": 20,
                   "financial_statement_history": {"observed_on": "2026-10-07", "annual": [], "quarterly": []}}]
        with tempfile.TemporaryDirectory() as directory:
            build_snapshot(Path(directory), stocks, {}, {}, "2026-10-06")
            old = load_snapshot(Path(directory), "2026-10-06")["stocks"][0]
            self.assertIsNone(old["financial_statement_history"])
            self.assertIsNone(old["ttm_revenue_growth_percent"])
            build_snapshot(Path(directory), stocks, {}, {}, "2026-10-07")
            current = load_snapshot(Path(directory), "2026-10-07")["stocks"][0]
            self.assertEqual(current["financial_statement_history"],stocks[0]["financial_statement_history"])

    def test_snapshot_preserves_metrics_and_current_ownership_changes(self):
        stocks = [{"symbol": "TEST", "as_of_date": "2026-09-25", "promoter_holding_percent": 50.48,
                   "fii_percent_change_qoq": -1.47, "dii_percent_change_qoq": 0.0,
                   "cwip_crore": 237686, "total_income_in_lakhs": 31601800,
                   "financial_units_version": 1, "debt_to_equity_source": "SCANX_Debt2Eq"}]
        with tempfile.TemporaryDirectory() as directory:
            build_snapshot(Path(directory), stocks, {}, {}, "2026-09-25")
            saved = load_snapshot(Path(directory), "2026-09-25")
        item = saved["stocks"][0]
        self.assertEqual(item["promoter_holding_percent"], 50.48)
        self.assertEqual(item["fii_percent_change_qoq"], -1.47)
        self.assertEqual(item["dii_percent_change_qoq"], 0.0)
        self.assertEqual(item["cwip_crore"], 237686)
        self.assertEqual(item["total_income_in_lakhs"], 31601800)
        self.assertEqual(item["financial_units_version"], 1)
        self.assertEqual(item["debt_to_equity_source"], "SCANX_Debt2Eq")

    def test_historical_ownership_changes_use_adjacent_observed_quarters(self):
        stocks = [{"symbol": "TEST", "as_of_date": "2026-10-07",
                   "promoter_holding_percent": 99, "fii_percent_change_qoq": 99,
                   "dii_percent_change_qoq": 99}]
        observations = [
            {"symbol": "TEST", "period_end": "2026-03-31", "observed_on": "2026-05-01",
             "fii_holding_percent": 18.67, "dii_holding_percent": 20.55},
            {"symbol": "TEST", "period_end": "2026-06-30", "observed_on": "2026-08-01",
             "promoter_holding_percent": 50.48, "fii_holding_percent": 17.20, "dii_holding_percent": 20.55},
            # Neither the new quarter nor later corrections were known in August.
            {"symbol": "TEST", "period_end": "2026-09-30", "observed_on": "2026-10-07",
             "fii_holding_percent": 25, "dii_holding_percent": 25},
            {"symbol": "TEST", "period_end": "2026-03-31", "observed_on": "2026-10-07",
             "fii_holding_percent": 1, "dii_holding_percent": 1},
        ]
        with tempfile.TemporaryDirectory() as directory:
            build_snapshot(Path(directory), stocks, {}, {}, "2026-08-15",
                           shareholding_observations=observations)
            item = load_snapshot(Path(directory), "2026-08-15")["stocks"][0]
        self.assertEqual(item["promoter_holding_percent"], 50.48)
        self.assertEqual(item["shareholding_period_end"], "2026-06-30")
        self.assertEqual(item["fii_percent_change_qoq"], -1.47)
        self.assertEqual(item["dii_percent_change_qoq"], 0.0)

    def test_ownership_changes_keep_four_decimal_precision(self):
        observations = [
            {"symbol": "TEST", "period_end": "2026-03-31", "observed_on": "2026-05-01",
             "fii_holding_percent": 10, "dii_holding_percent": 20},
            {"symbol": "TEST", "period_end": "2026-06-30", "observed_on": "2026-08-01",
             "fii_holding_percent": 10.123456, "dii_holding_percent": 19.876544},
        ]
        selected = select_shareholding_observation(observations, "TEST", "2026-08-15")
        self.assertEqual(selected["fii_percent_change_qoq"], 0.1235)
        self.assertEqual(selected["dii_percent_change_qoq"], -0.1235)

    def test_ownership_changes_are_null_when_prior_quarter_is_unavailable(self):
        stocks = [{"symbol": "TEST", "as_of_date": "2026-09-25",
                   "fii_percent_change_qoq": 99, "dii_percent_change_qoq": 99}]
        current = {"symbol": "TEST", "period_end": "2026-06-30", "observed_on": "2026-08-01",
                   "fii_holding_percent": 17.20, "dii_holding_percent": 20.55}
        for prior in [None,
                      {"period_end": "2025-12-31", "observed_on": "2026-02-01"},
                      {"period_end": "2026-03-31", "observed_on": "2026-10-07"},
                      {"period_end": "2026-03-31", "observed_on": "2026-05-01",
                       "fii_holding_percent": float('nan'), "dii_holding_percent": None}]:
            with self.subTest(prior=prior), tempfile.TemporaryDirectory() as directory:
                observations = [current]
                if prior:
                    observations.append({"symbol": "TEST", **prior})
                build_snapshot(Path(directory), stocks, {}, {}, "2026-09-25",
                               shareholding_observations=observations)
                item = load_snapshot(Path(directory), "2026-09-25")["stocks"][0]
                self.assertIsNone(item["fii_percent_change_qoq"])
                self.assertIsNone(item["dii_percent_change_qoq"])

    def test_undated_or_future_provider_changes_are_not_backfilled(self):
        for source_date in [None, "2026-10-07"]:
            with self.subTest(source_date=source_date), tempfile.TemporaryDirectory() as directory:
                stocks = [{"symbol": "TEST", "as_of_date": source_date,
                           "fii_percent_change_qoq": -1.47, "dii_percent_change_qoq": 0}]
                build_snapshot(Path(directory), stocks, {}, {}, "2026-09-25")
                item = load_snapshot(Path(directory), "2026-09-25")["stocks"][0]
                self.assertIsNone(item["fii_percent_change_qoq"])
                self.assertIsNone(item["dii_percent_change_qoq"])

    def test_ownership_changes_handle_year_boundary_and_known_corrections(self):
        observations = [
            {"symbol": "TEST", "period_end": "2025-12-31", "observed_on": "2026-02-01",
             "fii_holding_percent": 10, "dii_holding_percent": 20},
            {"symbol": "TEST", "period_end": "2025-12-31", "observed_on": "2026-04-01",
             "fii_holding_percent": 11, "dii_holding_percent": 20},
            {"symbol": "TEST", "period_end": "2026-03-31", "observed_on": "2026-05-01",
             "fii_holding_percent": 12, "dii_holding_percent": 19},
        ]
        selected = select_shareholding_observation(observations, "TEST", "2026-05-02")
        self.assertEqual(selected["fii_percent_change_qoq"], 1)
        self.assertEqual(selected["dii_percent_change_qoq"], -1)
        self.assertNotIn("fii_percent_change_qoq", observations[-1])

    def test_persists_only_point_in_time_scanner_fields(self):
        stocks = [{
            "symbol": "RELIANCE", "as_of_date": "2026-09-25", "close": 1400,
            "market_cap_crore": 1, "index_memberships": ["NIFTY 50"], "unrelated": "omit",
        }]
        breadth = {"records": [{"date": "2026-09-25", "above_50_pct": 55.2}]}
        fno = {"available": True, "trade_date": "2026-09-25", "symbols": ["RELIANCE"]}
        with tempfile.TemporaryDirectory() as directory:
            path = build_snapshot(Path(directory), stocks, breadth, fno, "2026-09-25")
            saved = load_snapshot(Path(directory), "2026-09-25")
        self.assertEqual(path.name, "2026-09-25.json.gz")
        self.assertEqual(saved["stocks"][0]["symbol"], "RELIANCE")
        self.assertEqual(saved["stocks"][0]["index_memberships"], ["NIFTY 50"])
        self.assertNotIn("unrelated", saved["stocks"][0])
        self.assertIn("eps_ttm", saved["stocks"][0])
        self.assertEqual(saved["breadth"]["above_50_pct"], 55.2)
        self.assertNotIn("unrelated", saved["stocks"][0])

    def test_snapshot_uses_the_latest_filing_known_on_its_screen_date(self):
        stocks = [{
            "symbol": "RELIANCE", "as_of_date": "2026-09-25",
            "latest_earnings_date": "2026-08-01", "latest_quarter": "202606",
            "yoy_percent_net_profit_latest": 30,
        }]
        old = [{
            "symbol": "RELIANCE", "announcement_date": "2026-05-01", "observed_on": "2026-05-01",
            "latest_earnings_date": "2026-05-01", "latest_quarter": "202603",
            "yoy_percent_net_profit_latest": 10,
        }]
        observations = merge_observations(old, stocks, "2026-09-25")
        with tempfile.TemporaryDirectory() as directory:
            build_snapshot(Path(directory), stocks, {"records": [{"date": "2026-06-01"}]}, {}, "2026-06-01", observations)
            saved = load_snapshot(Path(directory), "2026-06-01")
        self.assertEqual(saved["stocks"][0]["latest_quarter"], "202603")
        self.assertEqual(saved["stocks"][0]["yoy_percent_net_profit_latest"], 10)

    def test_earnings_observed_after_screen_date_are_not_backfilled(self):
        observations = [{
            "symbol": "RELIANCE", "announcement_date": "2026-08-01",
            "observed_on": "2026-09-25", "latest_quarter": "202606",
        }]
        self.assertIsNone(select_observation(observations, "RELIANCE", "2026-08-15"))
        self.assertEqual(
            select_observation(observations, "RELIANCE", "2026-09-25")["latest_quarter"],
            "202606",
        )

    def test_shareholding_history_is_dated_and_rejects_placeholder_periods(self):
        observations = observations_from_fundamentals([{
            "Symbol": "RELIANCE", "isin": "INE002A01018",
            "sHp": {
                "YEAR": "202606|202603|189912",
                "PROMOTER": "50.48|50.00|49.00",
                "FII": "17.20|18.67|19.00",
                "DII": "21.19|20.55|20.00",
                "PUBLIC": "8.58|8.36|9.00",
                "NO_OF_SHARE_HOLDERS": "4651860|4421290|1",
            },
        }], "2026-09-25")
        self.assertEqual(len(observations), 2)
        self.assertEqual(observations[-1]["period_end"], "2026-06-30")
        self.assertEqual(observations[-1]["number_of_shareholders"], 4651860)
        self.assertIsNone(select_shareholding_observation(observations, "RELIANCE", "2026-09-24"))
        self.assertEqual(
            select_shareholding_observation(observations, "RELIANCE", "2026-09-25")["promoter_holding_percent"],
            50.48,
        )

    def test_snapshot_uses_ownership_seen_by_its_session(self):
        stocks = [{"symbol": "RELIANCE", "promoter_holding_percent": 99}]
        observations = [{
            "symbol": "RELIANCE", "period_end": "2026-06-30", "observed_on": "2026-09-25",
            "promoter_holding_percent": 50.48, "fii_holding_percent": 17.2,
        }]
        with tempfile.TemporaryDirectory() as directory:
            build_snapshot(
                Path(directory), stocks, {"records": [{"date": "2026-09-25"}]}, {}, "2026-09-25",
                shareholding_observations=observations,
            )
            saved = load_snapshot(Path(directory), "2026-09-25")
        item = saved["stocks"][0]
        self.assertEqual(item["promoter_holding_percent"], 50.48)
        self.assertEqual(item["free_float_percent"], 49.52)
        self.assertEqual(item["shareholding_period_end"], "2026-06-30")
