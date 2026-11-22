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
                        'net_income_fy_h': [value * 1e5 for value in years], 'earnings_per_share_diluted_fy_h': [4.0] * len(years),
                        'ebitda_fy_h': [None] * len(years),
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


class VerificationTests(unittest.TestCase):
    def test_a_nan_year_is_not_verified(self):
        broken = found([110, 110, 110, 110, 100, 100, 100, 100], [440, 400])
        broken['history']['total_revenue_fy_h'][1] = float('nan')
        self.assertEqual(len(tradingview.quarters(broken)['quarters']), 4)  # the NaN year stops the history
        broken['history']['total_revenue_fq_h'][0] = float('inf')
        self.assertEqual(tradingview.quarters(broken)['quarters'], [])

    def test_a_small_company_is_held_to_its_own_rounding_not_a_million(self):
        # $0.2M quarters: a grouping $0.3M off a $1.0M year passed the old $1M floor; 1% (or $1,000) does not.
        small = {'history': {**found([0.25] * 4, [1.0])['history'], 'total_revenue_fq_h': [250_000, 250_000, 250_000, 550_000]}}
        self.assertEqual(tradingview.quarters(small)['quarters'], [])
        exact = {'history': {**found([0.25] * 4, [1.0])['history'], 'total_revenue_fq_h': [250_000, 250_000, 250_000, 250_400]}}
        self.assertEqual(len(tradingview.quarters(exact)['quarters']), 4)

    def test_the_source_that_reaches_further_back_wins(self):
        newer = [{'period': '202609'}, {'period': '202509'}]
        older = [{'period': '202509'}, {'period': '202409'}]
        self.assertFalse(statements.reaches_as_far(newer, older))
        self.assertTrue(statements.reaches_as_far(older, newer))
        self.assertTrue(statements.reaches_as_far(older, list(older)))  # a tie goes to TradingView's
        self.assertFalse(statements.reaches_as_far([], older))


class FundamentalFieldTests(unittest.TestCase):
    def test_average_roa_uses_each_years_average_assets(self):
        # Apple's FY2024-FY2026 (TradingView, 2026-11-22): FY2026 alone is 34.61%, TradingView's own figure.
        history = {'net_income_fy_h': [132175e6, 112010e6, 93736e6], 'total_assets_fy_h': [404548e6, 359241e6, 364980e6, 352583e6]}
        self.assertAlmostEqual(tradingview.average_roa({'history': history}, years=1), 34.6103, places=3)
        self.assertAlmostEqual(tradingview.average_roa({'history': history}), (34.6103 + 30.9325 + 26.1262) / 3, places=3)
        self.assertIsNone(tradingview.average_roa({'history': {**history, 'total_assets_fy_h': history['total_assets_fy_h'][:3]}}))

    def test_opm_five_years_ago_and_fixed_assets_come_from_the_page(self):
        joined = market.joined
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        page = {**market.StatementTests.PAGE,
                'incomeStat_sy': {'YEAR': joined(*(year * 100 + 9 for year in range(2026, 2016, -1))),
                                  'REVENUE': joined(*[400] * 10), 'OPM': joined(33, 32, 31, 30, 29, 24, 23, 22, 21, 20)},
                'bs_s': {**market.StatementTests.PAGE['bs_s'], 'FIXED_ASSETS': joined(51, 50), 'CWIP': joined(51, 50)}}
        statements.write_page(root, 'ACME', {'fetched_at': '2026-11-09T00:30:00+00:00', 'slug': 'ACME-acme', **page})
        record = {'symbol': 'ACME', 'total_revenue_in_lakhs': 108, 'latest_earnings_date': '2026-10-30'}
        statements.enrich([record], root, [], {})
        self.assertEqual(record['opm_5_years_ago_percent'], 24)  # FY2021, five fiscal years before FY2026
        self.assertEqual(record['fixed_assets_crore'], 51)
        self.assertNotIn('cwip_crore', record)  # the page repeats fixed assets there: not a real CWIP


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


class StatementHistoryTests(unittest.TestCase):
    def page(self):
        joined = market.joined
        return {**market.StatementTests.PAGE,
                'incomeStat_sy': {'YEAR': joined(202609, 202509, 202409), 'REVENUE': joined(440, 400, 380),
                                  'OPERATING_PROFIT': joined(120, 100, 90), 'NET_PROFIT': joined(88, 80, 70), 'OPM': joined(27, 25, 24)},
                'cF_sq': {'YEAR': joined(202609, 202606), 'OPERATING_ACTIVITIES': joined(35, 30), 'CAPITAL_EXPENDITURE': joined(-5, 0)}}

    def test_tradingview_years_with_the_pages_lines_balance_sheets_and_cash_flow_from_the_page(self):
        record = {'symbol': 'ACME', 'tradingview_quarters': tradingview.quarters(found([110] * 4 + [100] * 4 + [95] * 4, [440, 400, 380]))}
        history = statements.statement_history(record, self.page(), {'income'})
        self.assertEqual([row['period_end'] for row in history['annual']], ['2024-09-30', '2025-09-30', '2026-09-30'])
        latest = history['annual'][-1]
        self.assertEqual((latest['revenue'], latest['net_profit'], latest['operating_profit'], latest['opm']), (440, 44, 120, 27))
        self.assertEqual(history['balance_sheet'][-1], {'period_end': '2026-09-30', 'total_assets': 500, 'current_assets': 200,
                                                        'current_liabilities': 100, 'non_current_liabilities': 150, 'total_equity': 250})
        self.assertEqual(history['cash_flow'][-1]['operating_activities'], 120)
        # Dhan's 0 is "not reported", not a value.
        self.assertEqual(history['cash_flow_quarterly'], [{'period_end': '2026-06-30', 'operating_activities': 30, 'capital_expenditure': None},
                                                          {'period_end': '2026-09-30', 'operating_activities': 35, 'capital_expenditure': -5}])

    def test_the_pages_years_when_tradingview_verifies_fewer_and_nothing_from_an_untrusted_page(self):
        record = {'symbol': 'ACME', 'tradingview_quarters': tradingview.quarters(found([110] * 4, [440]))}
        history = statements.statement_history(record, self.page(), {'income'})
        self.assertEqual(len(history['annual']), 3)
        # A page in another currency (TradingView's dollars are a tenth of it) gives nothing; TradingView's year stands.
        foreign = {'symbol': 'ACME', 'tradingview_quarters': tradingview.quarters(found([11] * 4, [44]))}
        history = statements.statement_history(foreign, self.page(), set())
        self.assertEqual((list(history), len(history['annual'])), (['annual'], 1))

    def test_a_page_a_quarter_behind_still_gives_its_dated_history(self):
        # TradingView already has the October quarter; the page ends in September but agrees on it.
        record = {'symbol': 'ACME', 'tradingview_quarters': tradingview.quarters(
            found([120, 110, 110, 110, 110, 100, 100, 100, 100], [440, 400], latest=(2026, 12), year_end=(2026, 9)))}
        history = statements.statement_history(record, self.page(), set())
        self.assertEqual(len(history['balance_sheet']), 2)

    def test_a_stale_cash_flow_series_is_left_out(self):
        joined = market.joined
        page = {**self.page(), 'cF_sy': {'YEAR': joined(202309, 202209), 'OPERATING_ACTIVITIES': joined(100, 90)}}
        record = {'symbol': 'ACME', 'tradingview_quarters': tradingview.quarters(found([110] * 4 + [100] * 4, [440, 400]))}
        history = statements.statement_history(record, page, {'income'})
        self.assertNotIn('cash_flow', history)  # ends three years before the latest quarter
        self.assertIn('cash_flow_quarterly', history)

    def test_blocks_that_are_not_what_their_names_say_are_left_out(self):
        joined = market.joined
        page = {**self.page(),
                # Costco's: the "yearly" block holds quarters, and the balance sheets are from 2009.
                'incomeStat_sy': {'YEAR': joined(202605, 202602, 202511), 'REVENUE': joined(70, 69, 67)},
                'bs_s': {'YEAR': joined(200905, 200902), 'TOTAL_ASSETS': joined(21, 20)}}
        history = statements.statement_history({'symbol': 'COST'}, page, {'income'})
        self.assertNotIn('annual', history)
        self.assertNotIn('balance_sheet', history)
        self.assertEqual(statements.spaced(statements.series(page['incomeStat_sy']), 12), [])

    def test_the_publisher_adds_the_series_to_each_stocks_history(self):
        import gzip, json
        sys.path.insert(0, str(ROOT.parent / 'frontend'))
        import publish_us
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        ledger = {'records': [{'symbol': 'ACME', 'quarter_end': '2026-09-30', 'revenue': 110}]}
        extra = {'stocks': {'ACME': {'annual': [{'period_end': '2026-09-30', 'revenue': 440}]},
                            'ONLY': {'balance_sheet': [{'period_end': '2026-09-30', 'total_assets': 5}]}}}
        source = {'quarterly_financial_history.json.gz': gzip.compress(json.dumps(ledger).encode()),
                  'statement_history.json.gz': gzip.compress(json.dumps(extra).encode())}
        histories = publish_us.load_financial_history(root, source, '2026-11-20')
        self.assertEqual((len(histories['ACME']['quarterly']), histories['ACME']['annual'][0]['revenue']), (1, 440))
        self.assertEqual((histories['ONLY']['quarterly'], histories['ONLY']['balance_sheet'][0]['total_assets']), ([], 5))


if __name__ == '__main__':
    unittest.main()
