import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
for path in (ROOT, SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.scanner.query import compile_query
from edl_pipeline.scanner.trend import evaluate_history


def history(length=300):
    dates = pd.date_range("2025-01-01", periods=length, freq="B")
    close = list(range(100, 100 + length))
    return pd.DataFrame({"Date": dates, "Open": close, "High": [value + 2 for value in close], "Low": [value - 2 for value in close], "Close": close, "Volume": [100_000] * length})


class ScannerQueryTests(unittest.TestCase):
    def test_compiles_and_or_with_the_documented_precedence(self):
        tree = compile_query("Market Cap (in Cr) > 2000 OR Close Price > 50 DMA AND Close Price > 100")
        self.assertEqual(tree["op"], "OR")
        self.assertEqual(tree["children"][1]["op"], "AND")

    def test_compiled_query_uses_the_same_local_evaluator(self):
        frame = history()
        tree = compile_query("Market Cap (in Cr) > 2000 AND Close Price > 50 DMA")
        result = evaluate_history(frame, tree, context={"stock": {"as_of_date": "2026-02-24", "market_cap_crore": 3_000, "close": 399}})
        self.assertEqual(result["status"], "match")

    def test_function_query_compiles_to_existing_conditions(self):
        tree = compile_query("ADX(14) > 25 AND MA Stack(\"50,150,200\", SMA, true)")
        self.assertEqual(tree["children"][0]["kind"], "ADX")
        self.assertEqual(tree["children"][1]["kind"], "MA_STACK")

    def test_advanced_technical_functions_use_the_shared_condition_contract(self):
        tree = compile_query(
            'MA Convergence("9,20,50,200", EMA) < 100 AND '
            'Supertrend(10, 3, BULLISH, STATE, 1) AND '
            'Indicator Compare(CLOSE, 1, 0, ABOVE, EMA, 50, 0, 1)'
        )
        self.assertEqual([child["kind"] for child in tree["children"]], [
            "MA_CONVERGENCE", "SUPERTREND", "INDICATOR_COMPARE",
        ])
        result = evaluate_history(history(), tree)
        self.assertEqual(result["status"], "match")

    def test_ma_convergence_preserves_operator_and_requires_quoted_periods(self):
        tree = compile_query('MA Convergence("9,20,50", EMA) > 2')
        self.assertEqual(tree["params"]["comparison"], "greater")
        self.assertEqual(evaluate_history(history(), compile_query('MA Convergence("9,20,50", EMA) > 4'))["status"], "match")
        self.assertEqual(evaluate_history(history(), compile_query('MA Convergence("9,20,50", EMA) < 4'))["status"], "no_match")
        with self.assertRaisesRegex(ValueError, "quoted comma-delimited"):
            compile_query("MA Convergence(9,20,50) <= 2")

    def test_unpublished_field_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported query field"):
            compile_query("Dividend Cover ratio > 4")

    def test_parenthesized_financial_labels_and_absolute_fields_compile_without_function_confusion(self):
        tree = compile_query(
            "Price to Earning (P/E) < 25 AND Earning Per Share (EPS) >= 10 "
            "AND Dividend Yield (%) > 2 AND Volume (in Lakhs) > 5"
        )
        self.assertEqual([child["field"] for child in tree["children"]], [
            "pe_ratio", "eps_ttm", "dividend_yield_percent", "volume_lakh",
        ])
        self.assertEqual([child["comparison"] for child in tree["children"]], [
            "less", "greater_or_equal", "greater", "greater",
        ])

    def test_query_supports_rank_vcp_delivery_and_bare_earnings_age(self):
        tree = compile_query(
            "RS Rating(TWELVE_MONTH) >= 80 AND VCP Legs(3, 120, 8, 0.8, 1.5) "
            "AND Delivery Pct > 60 AND Days Since Earnings < 5"
        )
        self.assertEqual([child["kind"] for child in tree["children"]], [
            "RS_RATING", "VCP_LEGS", "DELIVERY_PERCENT", "DAYS_SINCE_EARNINGS",
        ])
        self.assertEqual(tree["children"][2]["params"]["comparison"], "greater")
        self.assertEqual(tree["children"][3]["params"]["comparison"], "less")

    def test_repeated_clauses_and_nested_groups_are_preserved(self):
        tree = compile_query("(Close Price > 50 AND Close Price < 500) OR (RSI(14) > 50 AND RSI(14) < 70)")
        self.assertEqual(tree["op"], "OR")
        self.assertEqual([child["op"] for child in tree["children"]], ["AND", "AND"])
        close_group, rsi_group = tree["children"]
        self.assertEqual([child["field"] for child in close_group["children"]], ["close", "close"])
        self.assertEqual([child["kind"] for child in rsi_group["children"]], ["INDICATOR_COMPARE", "INDICATOR_COMPARE"])

    def test_strict_and_inclusive_operators_differ_at_the_boundary(self):
        frame = history()
        strict = evaluate_history(frame, compile_query("Close Price > 399"))
        inclusive = evaluate_history(frame, compile_query("Close Price >= 399"))
        self.assertEqual(strict["status"], "no_match")
        self.assertEqual(inclusive["status"], "match")

    def test_field_comparison_accepts_parenthesized_alias_on_the_right(self):
        tree = compile_query("Close Price > Non-current assets (in lakhs)")
        self.assertEqual(tree["condition"], "field_comparison")
        self.assertEqual(tree["field"], "close")
        self.assertEqual(tree["value"], {"field": "non_current_assets_in_lakhs"})


if __name__ == "__main__":
    unittest.main()
