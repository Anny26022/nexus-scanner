import unittest
from unittest import mock

import requests

import fetch_advanced_indicators as indicators


def row(symbol="PROVIDER_ALIAS", isin="ISIN-A", timestamp=1792035900, **values):
    data = {field: 100.0 for field in indicators.COLUMNS}
    data.update(isin=isin, time=timestamp, update_mode="delayed_streaming_900",
                currency="INR", fundamental_currency_code="INR", exchange="NSE", is_primary=True)
    data.update(values)
    return {"s": f"NSE:{symbol}", "d": [data[field] for field in indicators.COLUMNS]}


MASTER = [{"Symbol": "CANONICAL-A", "ISIN": "ISIN-A"}]


class AdvancedIndicatorTests(unittest.TestCase):
    def normalize(self, rows, **extra):
        return indicators.normalize_rows({"totalCount": len(rows), "data": rows, **extra}, MASTER, "observed")

    def test_joins_by_isin_and_preserves_nulls_units_and_provenance(self):
        result = self.normalize([row(SMA100=None, EMA100=float("nan"), **{"MACD.macd": 5.5})])[0]
        self.assertEqual(result["Symbol"], "CANONICAL-A")
        self.assertEqual(result["exchange"], "NSE")
        self.assertIs(result["isPrimary"], True)
        self.assertEqual(result["primaryExchange"], "NSE")
        self.assertEqual(result["listingSymbol"], "NSE:PROVIDER_ALIAS")
        self.assertEqual(result["asOfDate"], "2026-10-15")
        self.assertEqual(result["fetchedAt"], "observed")
        self.assertEqual(result["updateMode"], "delayed_streaming_900")
        self.assertIsNone(result["SMA"][-1]["Value"])
        self.assertIsNone(result["EMA"][-1]["Value"])
        self.assertEqual(result["TechnicalIndicators"][3]["Value"], 5.5)
        self.assertNotIn("Action", result["TechnicalIndicators"][0])
        self.assertEqual(result["Pivots"], [])

    def test_drops_stale_candles_using_observed_session_not_calendar(self):
        master = MASTER + [{"Symbol": "OLD", "ISIN": "ISIN-B"}]
        response = {"totalCount": 2, "data": [row(), row("OLD", "ISIN-B", 1791949500)]}
        result = indicators.normalize_rows(response, master, "observed")
        self.assertEqual([r["Symbol"] for r in result], ["CANONICAL-A"])
        # A weekend run still accepts the latest observed Friday session.
        result = self.normalize([row(timestamp=1791517500)])
        self.assertEqual(result[0]["asOfDate"], "2026-10-09")

    def test_expanded_fields_preserve_reporting_periods_and_convert_rupees_once(self):
        result = self.normalize([row(**{
            "AvgValue.Traded_10d": 20000000, "AvgValue.Traded_30d": 50000000,
            "relative_volume_10d_calc": 2.5,
            "Perf.W": -3.5, "Perf.YTD": 0, "Perf.3Y": 42,
            "Perf.10Y": None, "Perf.All": 1250,
            "total_debt_fy": 970000000,
            "total_current_assets_fy": 150000000, "total_liabilities_fy": None})])[0]
        self.assertEqual(result["market"]["turnover30_crore"], 5)
        self.assertEqual(result["market"]["turnover10_crore"], 2)
        self.assertEqual(result["market"]["rvol10"], 2.5)
        self.assertEqual(result["market"]["performance_1w_pct"], -3.5)
        self.assertEqual(result["market"]["performance_ytd_pct"], 0)
        self.assertEqual(result["market"]["performance_3y_pct"], 42)
        self.assertIsNone(result["market"]["performance_10y_pct"])
        self.assertEqual(result["market"]["performance_all_time_pct"], 1250)
        self.assertEqual(result["financials"]["total_debt_fy_crore"], 97)
        self.assertEqual(result["financials"]["current_assets_fy_crore"], 15)
        self.assertIsNone(result["financials"]["total_liabilities_fy_crore"])

    def test_currency_mismatch_does_not_create_inr_values(self):
        result = self.normalize([row(currency="USD", fundamental_currency_code="USD")])[0]
        self.assertTrue(all(value is None for value in result["market"].values()))
        self.assertTrue(all(value is None for value in result["financials"].values()))

    def test_pipeline_retains_expanded_data_without_overwriting_canonical_values(self):
        from edl_pipeline.transforms.fundamentals import analyze_stock
        from standardize_stock_artifact import canonicalize_stock
        enrichment = self.normalize([row(total_debt_fy=1230000000)])[0]
        canonical = canonicalize_stock(analyze_stock({"Symbol": "CANONICAL-A"}, {}, enrichment, {}))
        self.assertIsNone(canonical["market_cap_crore"])
        self.assertEqual(canonical["tradingview_snapshot"]["financials"]["total_debt_fy_crore"], 123)
        self.assertEqual(canonical["tradingview_snapshot"]["as_of_date"], "2026-10-15")
        self.assertEqual(canonical["tradingview_snapshot"]["primary_exchange"], "NSE")
        self.assertIs(canonical["tradingview_snapshot"]["is_primary"], True)

    def test_rejects_partial_malformed_ambiguous_or_unmatched_responses(self):
        cases = [([], {}), ([row()], {"totalCount": 2}),
                 ([{"s": "NSE:A", "d": []}], {}),
                 ([row(), row("DUPLICATE")], {}),
                 ([row(isin="UNRELATED")], {}),
                 ([row(exchange="BSE")], {}), ([row(is_primary=False)], {}),
                 ([row(is_primary=None)], {}),
                 ([row(time=None)], {}), ([row(close=None)], {})]
        for rows, extra in cases:
            with self.subTest(rows=rows, extra=extra), self.assertRaises(ValueError):
                self.normalize(rows, **extra)

    def test_main_makes_one_bulk_request_and_retains_artifact_contract(self):
        with mock.patch.object(indicators, "load_json", return_value=MASTER), \
                mock.patch.object(indicators, "post_json", return_value={"totalCount": 1, "data": [row()]}) as post, \
                mock.patch.object(indicators, "save_json") as save:
            self.assertTrue(indicators.main())
        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs, {"timeout": 20, "retries": 1})
        payload = post.call_args.args[1]
        self.assertEqual(payload["columns"], indicators.COLUMNS)
        self.assertIn({"left": "type", "operation": "equal", "right": "stock"}, payload["filter"])
        self.assertEqual(save.call_args.args[0], "advanced_indicator_data.json")
        self.assertEqual(save.call_args.args[1][0]["Symbol"], "CANONICAL-A")

    def test_failure_does_not_publish_empty_success(self):
        for response in (requests.Timeout("timeout"), {"totalCount": 0, "data": []}):
            with self.subTest(response=response), \
                    mock.patch.object(indicators, "load_json", return_value=MASTER), \
                    mock.patch.object(indicators, "post_json", **(
                        {"side_effect": response} if isinstance(response, Exception) else {"return_value": response})), \
                    mock.patch.object(indicators, "save_json") as save:
                self.assertFalse(indicators.main())
                save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
