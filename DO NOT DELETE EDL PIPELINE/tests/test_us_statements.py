import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

for path in (Path(__file__).resolve().parents[1] / 'src', Path(__file__).resolve().parents[1]):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import statements  # noqa: E402

NOW = datetime(2026, 11, 10, tzinfo=timezone.utc)
PAGE = {'incomeStat_sq': {'YEAR': '202609', 'REVENUE': '1'}}


class Pages:
    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def fetch(self, slug):
        self.calls.append(slug)
        answer = self.answers[slug]
        if isinstance(answer, Exception):
            raise answer
        return answer


class StatementReviewTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def refresh(self, symbols, answers):
        records = [{'symbol': symbol, 'slug': f'{symbol}-x'} for symbol in symbols]
        pages = Pages({f'{symbol}-x': answer for symbol, answer in answers.items()})
        return statements.refresh_pages(records, self.root, NOW, pages=pages, interval=0, workers=1), pages

    def test_an_empty_answer_or_404_keeps_a_page_fetched_before(self):
        statements.write_page(self.root, 'A', {'fetched_at': '2026-10-01T00:00:00+00:00', 'slug': 'A-x', **PAGE})
        statements.write_page(self.root, 'B', {'fetched_at': '2026-10-01T00:00:00+00:00', 'slug': 'B-x', **PAGE})
        counts, _ = self.refresh(['A', 'B', 'C'], {'A': {}, 'B': OSError('404 Not Found'), 'C': {}})
        self.assertEqual(counts['missing'], 3)
        for symbol in ('A', 'B'):
            kept = statements.read_page(self.root, symbol)
            self.assertFalse(kept.get('missing'))
            self.assertEqual(kept['incomeStat_sq'], PAGE['incomeStat_sq'])
        self.assertTrue(statements.read_page(self.root, 'C')['missing'])  # never fetched: remembered as missing

    def test_a_malformed_answer_fails_that_page_only(self):
        counts, _ = self.refresh(['A', 'B', 'C'], {'A': ['not', 'props'], 'B': {'fundamentalsData': 'oops'},
                                                    'C': {'fundamentalsData': PAGE}})
        self.assertEqual((counts['failed'], counts['fetched']), (2, 1))
        self.assertIsNone(statements.read_page(self.root, 'A'))
        self.assertIsNotNone(statements.read_page(self.root, 'C'))

    def test_never_fetched_pages_come_first_then_the_oldest(self):
        for symbol, fetched in (('NEW', None), ('OLD', '2026-09-01'), ('MID', '2026-10-01'), ('RECENT', '2026-10-20')):
            if fetched:
                statements.write_page(self.root, symbol, {'fetched_at': f'{fetched}T00:00:00+00:00', 'slug': f'{symbol}-x', **PAGE})
        symbols = ['RECENT', 'MID', 'NEW', 'OLD']
        _, pages = self.refresh(symbols, {symbol: {'fundamentalsData': PAGE} for symbol in symbols})
        self.assertEqual(pages.calls, ['NEW-x', 'OLD-x', 'MID-x', 'RECENT-x'])

    def test_zero_placeholders_in_earlier_quarters_leave_trailing_totals_empty(self):
        block = {'YEAR': '202609|202606|202603|202512', 'REVENUE': '10|10|10|10', 'NET_PROFIT': '2|2|0|2'}
        rows = statements.series(block)
        self.assertIsNone(rows[2]['NET_PROFIT'])
        fields = statements.statement_blocks({'incomeStat_sq': block})['income']['fields']
        self.assertEqual(fields['ttm_revenue_crore'], 40)
        self.assertIsNone(fields['ttm_net_profit_crore'])

    def test_years_a_date_cannot_hold_are_not_periods(self):
        block = {'YEAR': '000012|999912|202609', 'REVENUE': '1|2|3'}
        self.assertEqual([row['period'] for row in statements.series(block)], ['202609'])
        self.assertEqual(len(statements.quarterly_history({'incomeStat_sq': block}, {'symbol': 'A'})), 1)

    def test_a_report_matches_only_one_of_two_adjacent_quarters_two_weeks_after_a_quarter_end(self):
        # The fastest US reporters (banks) publish about two weeks after the quarter: only the newer quarter matches.
        self.assertTrue(statements.reports('202609', '2026-10-14'))
        self.assertFalse(statements.reports('202606', '2026-10-14'))
        # A small filer's 10-K on a leap year's 90-day deadline (91 days) still matches.
        self.assertTrue(statements.reports('202712', '2028-03-31'))


if __name__ == '__main__':
    unittest.main()
