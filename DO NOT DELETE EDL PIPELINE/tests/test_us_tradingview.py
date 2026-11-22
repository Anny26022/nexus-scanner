import sys
import unittest
from pathlib import Path

for path in (Path(__file__).resolve().parents[1] / 'src', Path(__file__).resolve().parents[1]):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import tradingview  # noqa: E402

STAMP = 1794234600  # 2026-11-09 09:30 in New York


def row(index):
    values = {'isin': f'US{index:010d}', 'time': STAMP, 'close': 10.0, 'update_mode': 'delayed', 'currency': 'USD',
              'fundamental_currency_code': 'USD', 'exchange': 'NYSE', 'is_primary': True, 'type': 'stock'}
    return {'s': f'NYSE:T{index}', 'd': [values.get(column) for column in tradingview.COLUMNS]}


class Scanner:
    """A paged scanner: `total` rows, answering each request's range; `counts` overrides totalCount per call."""

    def __init__(self, total, counts=None, short=False):
        self.rows, self.counts, self.short, self.calls = [row(i) for i in range(total)], counts, short, []

    def __call__(self, url, payload, timeout, retries):
        self.calls.append((payload['range'], payload.get('sort'), retries))
        start, end = payload['range']
        count = self.counts[len(self.calls) - 1] if self.counts else len(self.rows)
        data = [] if self.short and start else self.rows[start:end]
        return {'totalCount': count, 'data': data}


class PagingTests(unittest.TestCase):
    def test_pages_sorted_by_name_until_the_count_is_reached(self):
        scanner = Scanner(12)
        response = tradingview.fetch(post=scanner, page_size=5)
        self.assertEqual([call[0] for call in scanner.calls], [[0, 5], [5, 10], [10, 15]])
        self.assertTrue(all(call[1] == {'sortBy': 'name', 'sortOrder': 'asc'} for call in scanner.calls))
        self.assertTrue(all(call[2] == tradingview.PAGE_RETRIES for call in scanner.calls))
        self.assertEqual((response['totalCount'], len(response['data'])), (12, 12))
        self.assertEqual(len(tradingview.snapshots(response, '')), 12)

    def test_a_short_assembly_is_refused(self):
        response = tradingview.fetch(post=Scanner(12, short=True), page_size=5)
        self.assertEqual(len(response['data']), 5)
        with self.assertRaises(ValueError):
            tradingview.snapshots(response, '')

    def test_a_count_that_changes_between_pages_is_refused(self):
        with self.assertRaises(ValueError):
            tradingview.fetch(post=Scanner(12, counts=[12, 13, 13]), page_size=5)


class FailureReportTests(unittest.TestCase):
    def test_a_failed_request_reports_an_error(self):
        def fail():
            raise OSError()
        report = tradingview.enrich([{'isin': 'US1'}], '2026-11-09', fetch_response=fail)
        self.assertTrue(report.get('error'))

    def test_too_few_matches_report_an_error(self):
        response = {'totalCount': 2, 'data': [row(0), row(1)]}
        records = [{'isin': f'US{i:010d}', 'close': 10.0} for i in range(5)]
        report = tradingview.enrich(records, '2026-11-09', fetch_response=lambda: response)
        self.assertEqual(report['matched'], 2)
        self.assertIn('2 of 5', report['error'])
        # Most records matched: no error.
        report = tradingview.enrich(records[:3], '2026-11-09', fetch_response=lambda: response)
        self.assertNotIn('error', report)


if __name__ == '__main__':
    unittest.main()
