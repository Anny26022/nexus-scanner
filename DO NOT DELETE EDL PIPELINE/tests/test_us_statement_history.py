"""TradingView's statement history: dated by counting back, kept only as far as each fiscal year adds up."""
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT, ROOT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import statements, tradingview  # noqa: E402
import test_us_market as market  # noqa: E402 (the module, so its tests are not collected twice)


def stamp(year, month, day=28):
    return datetime(year, month, day, tzinfo=timezone.utc).timestamp()


def found(revenue, years, latest=(2026, 9), year_end=(2026, 9)):
    """TradingView's arrays in dollars: quarters and years newest first."""
    return {'history': {'total_revenue_fq_h': [value * 1e6 for value in revenue],
                        'net_income_fq_h': [value * 1e5 for value in revenue],
                        'earnings_per_share_diluted_fq_h': [1.0] * len(revenue), 'ebitda_fq_h': [None] * len(revenue),
                        'total_revenue_fy_h': [value * 1e6 for value in years],
                        'fiscal_period_end_fq': stamp(*latest), 'fiscal_period_end_fy': stamp(*year_end)}}


class QuarterTests(unittest.TestCase):
    def test_quarters_are_dated_back_from_the_latest_end_in_millions(self):
        result = tradingview.quarters(found([110, 110, 110, 110, 100, 100, 100, 100], [440, 400]))
        self.assertEqual([row['period'] for row in result['quarters']][:5], ['202609', '202606', '202603', '202512', '202509'])
        self.assertEqual(len(result['quarters']), 8)
        self.assertEqual((result['quarters'][0]['revenue'], result['quarters'][0]['net_profit'], result['quarters'][0]['eps']), (110, 11, 1.0))
        self.assertEqual(result['year_end_month'], '09')

    def test_quarters_after_the_fiscal_year_end_lead(self):
        # Two quarters into a new fiscal year that ended in March.
        result = tradingview.quarters(found([120, 115, 110, 110, 110, 110, 100, 100, 100, 100], [440, 400], year_end=(2026, 3)))
        self.assertEqual(len(result['quarters']), 10)
        self.assertEqual(result['quarters'][2]['period'], '202603')

    def test_a_dropped_quarter_stops_the_history_at_the_year_it_breaks(self):
        # TradingView lost a quarter of the older year and moved the rest up: that year no longer adds up.
        result = tradingview.quarters(found([110, 110, 110, 110, 100, 100, 100, 90, 90], [440, 400]))
        self.assertEqual(len(result['quarters']), 4)
        # A first year that already disagrees (a bank's revenue, a semi-annual reporter) keeps nothing.
        self.assertEqual(tradingview.quarters(found([110, 110, 110, 110], [500]))['quarters'], [])
        self.assertEqual(tradingview.quarters({'history': {}})['quarters'], [])


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def test_tradingview_quarters_win_when_they_reach_as_far_and_take_the_pages_operating_lines(self):
        statements.write_page(self.root, 'ACME', {'fetched_at': '2026-11-09T00:30:00+00:00', 'slug': 'ACME-acme', **market.StatementTests.PAGE})
        revenue = [110] * 4 + [100] * 4 + [95] * 4
        record = {'symbol': 'ACME', 'isin': 'US1', 'total_revenue_in_lakhs': 108, 'latest_earnings_date': '2026-10-30',
                  'tradingview_quarters': tradingview.quarters(found(revenue, [440, 400, 380]))}
        history = []
        report = statements.enrich([record], self.root, history)
        self.assertEqual(report['history_tradingview'], 1)
        self.assertEqual(len(history), 12)
        latest = history[-1]
        self.assertEqual((latest['quarter_end'], latest['revenue'], latest['filing_date_basis']), ('2026-09-30', 110, 'reported'))
        # Same quarter, same revenue on the page: its operating profit, PBT and margin join TradingView's row.
        self.assertEqual((latest['operating_profit'], latest['profit_before_tax']), (30, 28))
        self.assertTrue(latest['numeric_source'].startswith('TradingView'))

    def test_the_page_is_kept_when_tradingview_verifies_less_and_tradingview_alone_when_there_is_no_page(self):
        statements.write_page(self.root, 'ACME', {'fetched_at': '2026-11-09T00:30:00+00:00', 'slug': 'ACME-acme', **market.StatementTests.PAGE})
        short = tradingview.quarters(found([110] * 4, [440]))
        history = []
        statements.enrich([{'symbol': 'ACME', 'total_revenue_in_lakhs': 108, 'tradingview_quarters': short}], self.root, history)
        self.assertEqual(len(history), 10)
        self.assertTrue(history[-1]['numeric_source'].startswith('Dhan'))
        history = []
        report = statements.enrich([{'symbol': 'NOPAGE', 'tradingview_quarters': short}], self.root, history)
        self.assertEqual((len(history), report['history_tradingview']), (4, 1))


if __name__ == '__main__':
    unittest.main()
