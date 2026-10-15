import unittest
from unittest import mock

import requests

import fetch_advanced_indicators as indicators


def row(symbol="PROVIDER_ALIAS", isin="ISIN-A", timestamp=1792035900, **values):
    data = {field: 100.0 for field in indicators.COLUMNS}
    data.update(isin=isin, time=timestamp, update_mode="delayed_streaming_900",
                currency="INR", fundamental_currency_code="INR")
    data.update(values)
    return {"s": f"NSE:{symbol}", "d": [data[field] for field in indicators.COLUMNS]}


MASTER = [{"Symbol": "CANONICAL-A", "ISIN": "ISIN-A"}]


class AdvancedIndicatorTests(unittest.TestCase):
    def normalize(self, rows, **extra):
        return indicators.normalize_rows({"totalCount": len(rows), "data": rows, **extra}, MASTER, "observed")

    def test_joins_by_isin_and_preserves_nulls_units_and_provenance(self):
        result = self.normalize([row(SMA200=None, EMA200=float("nan"), ATR=5.5)])[0]
        self.assertEqual(result["Symbol"], "CANONICAL-A")
        self.assertEqual(result["asOfDate"], "2026-10-15")
        self.assertEqual(result["fetchedAt"], "observed")
        self.assertEqual(result["updateMode"], "delayed_streaming_900")
        self.assertIsNone(result["SMA"][-1]["Value"])
        self.assertIsNone(result["EMA"][-1]["Value"])
        self.assertEqual(result["TechnicalIndicators"][1]["Value"], 5.5)
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
        result = self.normalize([row(**{"market_cap_basic": 1230000000,
            "AvgValue.Traded_10d": 20000000, "AvgValue.Traded_30d": 50000000,
            "AvgValue.Traded_60d": 70000000, "AvgValue.Traded_90d": None,
            "total_revenue_ttm": 970000000,
            "return_on_equity_fy": 15.2, "total_assets_fy": None})])[0]
        self.assertEqual(result["market"]["market_cap_crore"], 123)
        self.assertEqual(result["market"]["turnover30_crore"], 5)
        self.assertEqual(result["market"]["turnover10_crore"], 2)
        self.assertEqual(result["market"]["turnover60_crore"], 7)
        self.assertIsNone(result["market"]["turnover90_crore"])
        self.assertEqual(result["financials"]["revenue_ttm_crore"], 97)
        self.assertEqual(result["financials"]["roe_fy_pct"], 15.2)
        self.assertIsNone(result["financials"]["total_assets_fy_crore"])

    def test_currency_mismatch_does_not_create_inr_values(self):
        result = self.normalize([row(currency="USD", fundamental_currency_code="USD")])[0]
        self.assertTrue(all(value is None for value in result["market"].values()))
        self.assertTrue(all(value is None for value in result["financials"].values()))

    def test_pipeline_retains_expanded_data_without_overwriting_canonical_values(self):
        from edl_pipeline.transforms.fundamentals import analyze_stock
        from standardize_stock_artifact import canonicalize_stock
        enrichment = self.normalize([row(market_cap_basic=1230000000)])[0]
        canonical = canonicalize_stock(analyze_stock({"Symbol": "CANONICAL-A"}, {}, enrichment, {}))
        self.assertIsNone(canonical["market_cap_crore"])
        self.assertEqual(canonical["tradingview_snapshot"]["market"]["market_cap_crore"], 123)
        self.assertEqual(canonical["tradingview_snapshot"]["as_of_date"], "2026-10-15")

    def test_rejects_partial_malformed_ambiguous_or_unmatched_responses(self):
        cases = [([], {}), ([row()], {"totalCount": 2}),
                 ([{"s": "NSE:A", "d": []}], {}),
                 ([row(), row("DUPLICATE")], {}),
                 ([row(isin="UNRELATED")], {}),
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
