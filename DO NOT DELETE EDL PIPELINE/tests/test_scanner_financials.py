import sys
import unittest
from datetime import date
from pathlib import Path
import pandas as pd

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"src"))
from edl_pipeline.scanner.financials import financial_value, normalize_statement_history, statement_reference, statement_summary, historical_field_value
from edl_pipeline.scanner.query import compile_query
from edl_pipeline.scanner.context import _published_field_value
from edl_pipeline.scanner.trend import evaluate_history


class FinancialScannerTests(unittest.TestCase):
    def raw_history(self):
        return {
            "incomeStat_cq": {"YEAR": "202606|202603|202512|202509|202506|202503|202412|202409",
                              "REVENUE": "120|120|120|120|100|100|100|100",
                              "NET_PROFIT": "0|10|20|30|20|20|20|20",
                              "OPM": "15|14|13|12|11|10|9|8"},
            "incomeStat_cy": {"YEAR": "202603|202503|202403|202303|202203|202103",
                              "OPM": "16.93|17.15|18|16.19|15.58|17.29"},
            "bs_c": {"YEAR": "202603|202503", "CWIP": "200|100"},
        }

    def test_normalized_series_preserve_periods_and_units(self):
        history = normalize_statement_history(self.raw_history(), "2026-10-07")
        self.assertEqual(history["amount_unit"], "INR_CRORE")
        self.assertEqual(history["quarterly"][-1]["revenue"], 120)
        self.assertEqual(history["quarterly"][-1]["net_profit"], 0)
        self.assertEqual(history["balance_sheet"][-1]["cwip"], 200)
        self.assertEqual(statement_reference(history, "quarterly", "opm", 4), 11)
        self.assertEqual(statement_reference(history, "annual", "opm", 5), 17.29)
        self.assertIsNone(statement_reference(history, "annual", "roce", 1))
        self.assertIsNone(statement_reference(history, "annual", "borrowings", 1))

    def test_ttm_growth_requires_eight_consecutive_valid_quarters(self):
        raw = self.raw_history()
        summary = statement_summary(normalize_statement_history(raw, "2026-10-07"))
        self.assertEqual(summary["ttm_revenue_crore"], 480)
        self.assertEqual(summary["ttm_revenue_growth_percent"], 20)
        self.assertEqual(summary["ttm_net_profit_growth_percent"], -25)
        for invalid in ["", "nan", "inf"]:
            raw["incomeStat_cq"]["REVENUE"] = f"{invalid}|120|120|120|100|100|100|100"
            self.assertIsNone(statement_summary(normalize_statement_history(raw, "2026-10-07"))["ttm_revenue_growth_percent"])
        raw = self.raw_history()
        raw["incomeStat_cq"]["YEAR"] = raw["incomeStat_cq"]["YEAR"].replace("202512", "202206")
        self.assertIsNone(statement_summary(normalize_statement_history(raw, "2026-10-07"))["ttm_revenue_growth_percent"])
        self.assertIsNone(statement_reference(normalize_statement_history(raw, "2026-10-07"), "quarterly", "revenue", 2))
        raw = self.raw_history(); raw["incomeStat_cq"]["REVENUE"] = "120|120|120|120|0|0|0|0"
        self.assertIsNone(statement_summary(normalize_statement_history(raw, "2026-10-07"))["ttm_revenue_growth_percent"])

    def test_malformed_columns_duplicates_and_placeholder_periods_are_not_shifted(self):
        raw = {"incomeStat_cq": {"YEAR": "202606|202603|189912|202613", "REVENUE": "1|2", "EPS": "1|2|3|4"}}
        history = normalize_statement_history(raw, "2026-10-07")
        self.assertEqual(len(history["quarterly"]), 2)
        self.assertIsNone(history["quarterly"][-1]["revenue"])
        raw["incomeStat_cq"]["YEAR"] = "202606|202606"
        self.assertEqual(normalize_statement_history(raw, "2026-10-07")["quarterly"], [])

    def test_statement_queries_support_both_operands_without_lookahead(self):
        tree = compile_query("Financial Value(quarterly, revenue, 0) > Financial Value(quarterly, revenue, 4)")
        self.assertEqual(tree["field"], "financial:quarterly:revenue:0")
        self.assertEqual(tree["value"], {"field": "financial:quarterly:revenue:4"})
        stock = {"financial_statement_history": normalize_statement_history(self.raw_history(), "2026-10-07")}
        self.assertEqual(_published_field_value(None, stock, tree["field"], date(2026,10,7)), (120, None))
        self.assertEqual(historical_field_value(stock, "ttm_revenue_growth_percent", date(2026,10,7)), (20, None))
        self.assertIsNone(historical_field_value(stock, tree["field"], date(2026,8,1))[0])
        stock["financial_statement_history"]["observed_on"] = None
        self.assertIsNone(historical_field_value(stock, tree["field"], date(2026,10,7))[0])
        for query in ["Financial Value(annual, roce, 1) > 10", "Financial Value(annual, revenue, 101) > 0"]:
            with self.assertRaises(ValueError): compile_query(query)
        self.assertEqual(compile_query("TTM PAT Growth > 10")["field"], "ttm_net_profit_growth_percent")
        stock["financial_statement_history"]["observed_on"] = "2026-10-07"
        frame = pd.DataFrame([{"Date": "2026-10-07", "Open": 100, "High": 101, "Low": 99, "Close": 100, "Volume": 10}])
        result = evaluate_history(frame, tree, "2026-10-07", context={"stock": stock})
        self.assertEqual(result["status"], "match")

    def test_financial_reference_syntax_errors_name_expected_format(self):
        spaced = compile_query("Financial Value (annual, revenue, 0) > 1")
        self.assertEqual(spaced["field"], "financial:annual:revenue:0")
        for query in [
            "Financial Value(annual, revenue) > 1",
            "Financial Value (annual, revenue) > 1",
            "Financial Value(annual, revenue, -1) > 1",
            "Financial Value(monthly, revenue, 0) > 1",
            "Financial Value annual revenue 0 > 1",
            "Close Price > Financial Value(annual, revenue)",
        ]:
            with self.subTest(query=query), self.assertRaisesRegex(ValueError, r"Expected Financial Value\(frequency, metric, offset\)"):
                compile_query(query)

    def context(self):
        rows=[]
        for statement,profits in [("CONSOLIDATED",[10,20,30,40]),("STANDALONE",[5,5,5,5])]:
            for quarter,profit in zip(["2025-09-30","2025-12-31","2026-03-31","2026-06-30"],profits):
                rows.append({"quarter_end":quarter,"filing_date":"2026-08-01","report_type":statement,"net_profit":profit})
        return {"financial_history":{"TEST":rows},"financial_history_as_of":"2026-09-30"}

    def test_pe_selects_statement_and_requires_four_consecutive_quarters(self):
        context=self.context()
        spec={"condition":"pe_ratio","report_type":"PREFER_CONSOLIDATED"}
        self.assertEqual(financial_value(context,{"symbol":"TEST"},spec,date(2026,9,30),1000)[0],10)
        spec["report_type"]="STANDALONE"
        self.assertEqual(financial_value(context,{"symbol":"TEST"},spec,date(2026,9,30),1000)[0],50)
        context["financial_history"]["TEST"].pop()
        self.assertIsNone(financial_value(context,{"symbol":"TEST"},spec,date(2026,9,30),1000)[0])

    def test_growth_uses_same_statement_comparison_quarter(self):
        spec={"condition":"earnings_growth","report_type":"CONSOLIDATED","metric":"net_profit","basis":"qoq","maximum_filing_age_days":200}
        value,details,reason=financial_value(self.context(),{"symbol":"TEST"},spec,date(2026,9,30),1000)
        self.assertAlmostEqual(value,100/3)
        self.assertEqual(details["report_type"],"CONSOLIDATED")
        self.assertIsNone(reason)

    def test_future_filings_and_unobserved_historical_revisions_are_unavailable(self):
        spec={"condition":"pe_ratio","report_type":"CONSOLIDATED"}
        self.assertIsNone(financial_value(self.context(),{"symbol":"TEST"},spec,date(2026,7,1),1000)[0])
        self.assertIsNone(financial_value(self.context(),{"symbol":"TEST"},spec,date(2026,9,29),1000)[0])

    def test_nonpositive_ttm_profit_is_unavailable(self):
        context=self.context()
        for row in context["financial_history"]["TEST"]:
            row["net_profit"]=-10
        value,_,reason=financial_value(context,{"symbol":"TEST"},{"condition":"pe_ratio"},date(2026,9,30),1000)
        self.assertIsNone(value)
        self.assertEqual(reason,"positive_ttm_profit_or_market_cap_unavailable")
