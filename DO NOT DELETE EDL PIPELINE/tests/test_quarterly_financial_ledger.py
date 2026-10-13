import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import build_quarterly_financial_ledger
from pipeline_utils import save_json, load_json


class QuarterlyFinancialLedgerTests(unittest.TestCase):
    def test_joins_result_disclosure_to_matching_quarter_and_preserves_type(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            save_json(root / "fundamental_data.json", [{
                "Symbol": "ACME", "isin": "INE000A01001",
                "incomeStat_cq": {"YEAR": "202506|202503", "REVENUE": "100|90", "NET_PROFIT": "10|9", "EPS": "1|0.9"},
                "incomeStat_sq": {"YEAR": "202506", "REVENUE": "80", "NET_PROFIT": "8", "EPS": "0.8"},
            }])
            save_json(root / "filing_history_data" / "filing_history.json", {"symbols": {"ACME": {
                "filings": [
                    {"news_date": "2025-07-28 15:00:00", "descriptor": "Board Meeting Outcome",
                     "caption": "Approved standalone and consolidated financial results for quarter ended June 30, 2025",
                     "file_url": "https://example.com/outcome.pdf"},
                    {"news_date": "2025-07-28 16:00:00", "descriptor": "Financial Results", "caption": "Standalone and consolidated quarter ended June 30, 2025", "file_url": "https://example.com/same.pdf"},
                    {"news_date": "2025-07-29 16:00:00", "descriptor": "Financial Results", "caption": "Standalone and consolidated quarter ended June 30, 2025", "file_url": "https://example.com/same.pdf"},
                    {"news_date": "2025-05-01 16:00:00", "descriptor": "Financial Results", "caption": "Consolidated quarter ended March 31, 2025", "file_url": "https://example.com/march.pdf"},
                ]
            }}})
            with mock.patch.object(build_quarterly_financial_ledger, "BASE_DIR", str(root)):
                self.assertEqual(build_quarterly_financial_ledger.main(), 0)
            rows = load_json(root / "quarterly_financial_history.json")["records"]
            self.assertEqual(len(rows), 3)
            june = [row for row in rows if row["quarter_end"] == "2025-06-30"]
            self.assertEqual({row["report_type"] for row in june}, {"CONSOLIDATED", "STANDALONE"})
            self.assertTrue(all(row["filing_date"] == "2025-07-28 16:00:00" for row in june))

    def test_unmatched_numeric_quarter_is_retained_without_a_filing_date(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            save_json(root / "fundamental_data.json", [{
                "Symbol": "ACME", "incomeStat_cq": {"YEAR": "202506", "REVENUE": "100"},
            }])
            save_json(root / "filing_history_data" / "filing_history.json", {"symbols": {"ACME": {
                "filings": [{"news_date": "2025-07-01", "descriptor": "Investor presentation", "caption": "Quarter ended June 30, 2025"}]
            }}})
            with mock.patch.object(build_quarterly_financial_ledger, "BASE_DIR", str(root)):
                self.assertEqual(build_quarterly_financial_ledger.main(), 0)
            result = load_json(root / "quarterly_financial_history.json")
            self.assertEqual(result["records"][0]["revenue"], 100)
            self.assertIsNone(result["records"][0]["filing_date"])
            self.assertIsNone(result["records"][0]["filing_url"])
            self.assertEqual(result["coverage"]["unmatched_numeric_quarters"], 1)

    def test_notices_are_excluded_even_when_they_mention_results(self):
        for title in ("Closure of Trading Window", "Board Meeting Intimation",
                      "Newspaper Publication", "Investor Presentation", "Earnings Call"):
            filing = {"descriptor": title, "caption": title,
                      "news_body": "Consolidated financial results for quarter ended September 30, 2026",
                      "news_date": "2026-10-10", "file_url": "https://example.com/notice.pdf"}
            self.assertEqual(build_quarterly_financial_ledger._filing_candidates([filing]), {})

    def test_outcome_requires_approval_and_explicit_statement_basis(self):
        filing = {"descriptor": "Board Meeting Outcome",
                  "news_body": "Approved consolidated financial results for quarter ended September 30, 2026",
                  "news_date": "2026-10-10", "file_url": "https://example.com/result.pdf"}
        matches = build_quarterly_financial_ledger._filing_candidates([filing])
        self.assertEqual(set(matches), {("2026-09-30", "CONSOLIDATED")})
        filing["news_body"] = "Will consider consolidated financial results for quarter ended September 30, 2026"
        self.assertEqual(build_quarterly_financial_ledger._filing_candidates([filing]), {})

    def test_multiple_actual_documents_are_retained_as_ambiguous(self):
        filings = [{"descriptor": "Financial Results", "caption": "Consolidated quarter ended June 30, 2026",
                    "news_date": day, "file_url": "https://example.com/" + name}
                   for day, name in [("2026-07-20", "original.pdf"), ("2026-07-21", "revised.pdf")]]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            save_json(root / "fundamental_data.json", [{"Symbol": "ACME",
                "financial_observed_on": "2026-07-22", "incomeStat_cq": {"YEAR": "202606",
                    "SALES": "132.9123", "REVENUE": "200.6", "OPERATING_PROFIT": "9.9",
                    "EBITDA": "77.7", "NET_PROFIT": "0", "EPS": "0.0085"}}])
            save_json(root / "filing_history_data/filing_history.json", {"symbols": {"ACME": {"filings": filings}}})
            with mock.patch.object(build_quarterly_financial_ledger, "BASE_DIR", str(root)):
                build_quarterly_financial_ledger.main()
            row = load_json(root / "quarterly_financial_history.json")["records"][0]
            self.assertIsNone(row["filing_date"])
            self.assertIsNone(row["filing_url"])
            self.assertEqual(len(row["result_disclosures"]), 2)
            self.assertEqual((row["sales"], row["revenue"]), (132.9123, 200.6))
            self.assertEqual((row["operating_profit"], row["ebitda"]), (9.9, 77.7))
            self.assertEqual((row["net_profit"], row["eps"]), (0, 0.0085))


if __name__ == "__main__":
    unittest.main()
