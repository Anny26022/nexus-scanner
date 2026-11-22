"""US filings from SEC EDGAR: cached compressed, results dates, and India's filing history for the charts."""
import gzip
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT, ROOT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import dhan, filings  # noqa: E402


def columns(*rows):
    keys = ('accessionNumber', 'filingDate', 'reportDate', 'acceptanceDateTime', 'form', 'items', 'primaryDocument')
    return {key: [row.get(key, '') for row in rows] for key in keys}


RECENT = columns(
    # Accepted at 20:30 in New York on 2 November, already 3 November in UTC.
    {'accessionNumber': '0000320193-26-000101', 'filingDate': '2026-11-02', 'acceptanceDateTime': '2026-11-03T01:30:23.000Z',
     'form': '8-K', 'items': '2.02,9.01', 'primaryDocument': 'aapl-8k.htm'},
    {'accessionNumber': '0000320193-26-000100', 'filingDate': '2026-11-01', 'acceptanceDateTime': '2026-11-01T12:00:00.000Z',
     'form': '4', 'primaryDocument': 'form4.xml'},
    {'accessionNumber': '0000320193-26-000099', 'filingDate': '2026-10-31', 'acceptanceDateTime': '2026-10-31T20:00:00.000Z',
     'form': '10-K', 'reportDate': '2026-09-26', 'primaryDocument': 'aapl-10k.htm'})
OLDER = columns({'accessionNumber': '0000320193-15-000050', 'filingDate': '2015-10-27', 'acceptanceDateTime': '2015-10-27T20:30:36.000Z',
                 'form': '8-K', 'items': '2.02,9.01', 'primaryDocument': 'old-8k.htm'})
PAYLOADS = {
    filings.TICKERS_URL: {'fields': ['cik', 'name', 'ticker', 'exchange'], 'data': [[320193, 'Apple Inc.', 'AAPL', 'Nasdaq'], [1067983, 'Berkshire', 'BRK-B', 'NYSE']]},
    'https://data.sec.gov/submissions/CIK0000320193.json': {'filings': {'recent': RECENT, 'files': [{'name': 'CIK0000320193-submissions-001.json'}]}},
    'https://data.sec.gov/submissions/CIK0000320193-submissions-001.json': OLDER,
    'https://data.sec.gov/submissions/CIK0001067983.json': {'filings': {'recent': columns(), 'files': []}},
}


# EDGAR's daily indexes the tests serve, by date: CIK|Company|Form|Date|File.
INDEXES = {}


def get(url, headers=None, timeout=None):
    assert headers['User-Agent'] == 'NexusScanner ops@example.org'
    if '/daily-index/' in url:
        day = url.rsplit('.', 2)[-2]
        return mock.Mock(status_code=200 if day in INDEXES else 404, text=INDEXES.get(day, ''), raise_for_status=mock.Mock())
    response = mock.Mock(status_code=200)
    response.json.return_value = PAYLOADS[url]
    return response


class FilingsTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        patcher = mock.patch.dict(os.environ, {'SEC_CONTACT': 'ops@example.org'})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.now = datetime(2026, 11, 20, 1, 0, tzinfo=timezone.utc)

    def test_material_filings_with_older_pages_are_cached_compressed(self):
        counts = filings.refresh([{'symbol': 'AAPL'}, {'symbol': 'BRK.B'}, {'symbol': 'NOSEC'}], self.root, self.now, get=get, interval=0)
        self.assertEqual((counts['companies'], counts['fetched']), (2, 2))
        path = self.root / 'sec_filings' / 'AAPL.json.gz'
        cached = json.loads(gzip.decompress(path.read_bytes()))
        self.assertEqual([row['form'] for row in cached['filings']], ['8-K', '10-K', '8-K'])  # the Form 4 left out
        self.assertEqual(cached['filings'][0]['url'], 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000101/aapl-8k.htm')
    def test_the_daily_index_picks_the_companies_to_read_again(self):
        filings.refresh([{'symbol': 'AAPL'}, {'symbol': 'BRK.B'}], self.root, self.now, get=get, interval=0)
        # 19 November (New York) has no index yet: nothing filed, nothing due.
        self.assertEqual(filings.refresh([{'symbol': 'AAPL'}, {'symbol': 'BRK.B'}], self.root, self.now, get=get, interval=0)['due'], 0)
        later = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)  # 20 November in New York
        INDEXES.update({'20261119': '320193|Apple Inc.|8-K|2026-11-19|edgar/data/320193/x.txt\n1067983|Berkshire|4|2026-11-19|y\n',
                        '20261120': '1067983|Berkshire|424B2|2026-11-20|z\n'})
        self.addCleanup(INDEXES.clear)
        counts = filings.refresh([{'symbol': 'AAPL'}, {'symbol': 'BRK.B'}], self.root, later, get=get, interval=0)
        self.assertEqual((counts['index'], counts['due'], counts['fetched']), ('read', 1, 1))  # Apple's 8-K; Berkshire's Form 4 is not material
        self.assertEqual(json.loads((self.root / 'sec_filings' / filings.INDEX_STATE).read_text())['last_index_day'], '2026-11-20')

    def state(self):
        return json.loads((self.root / 'sec_filings' / filings.INDEX_STATE).read_text())

    def write_state(self, value):
        (self.root / 'sec_filings').mkdir(parents=True, exist_ok=True)
        (self.root / 'sec_filings' / filings.INDEX_STATE).write_text(value if isinstance(value, str) else json.dumps(value))

    def test_a_missing_day_is_a_holiday_only_once_a_later_day_has_an_index(self):
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        self.addCleanup(INDEXES.clear)
        later = datetime(2026, 11, 24, 3, 0, tzinfo=timezone.utc)  # Monday 23 November in New York
        self.write_state({'last_index_day': '2026-11-18', 'pending': []})
        INDEXES['20261120'] = '1067983|Berkshire|424B2|2026-11-20|z\n'  # 19 Nov missing, 20 Nov there: a holiday
        filings.refresh([{'symbol': 'AAPL'}], self.root, later, get=get, interval=0)
        # Read through the weekend (no filings), stopping before Monday 23 Nov, whose index is not out yet.
        self.assertEqual(self.state()['last_index_day'], '2026-11-22')
        INDEXES.clear()
        self.write_state({'last_index_day': '2026-11-18', 'pending': []})
        filings.refresh([{'symbol': 'AAPL'}], self.root, later, get=get, interval=0)
        self.assertEqual(self.state()['last_index_day'], '2026-11-18')  # nothing after the missing days: read again

    def test_a_long_gap_resumes_from_yesterday_and_bad_state_counts_as_none(self):
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        self.write_state({'last_index_day': '2026-08-01', 'pending': []})
        self.assertEqual(filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)['index'], 'not used')
        self.assertEqual(self.state()['last_index_day'], '2026-11-18')
        for bad in ('[1, 2]', '{"last_index_day": "not a date"}', '{"pending": "x"}'):
            self.write_state(bad)
            self.assertIn('fetched', filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0))

    def test_an_index_error_keeps_pending_companies(self):
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        self.write_state({'last_index_day': '2026-11-17', 'pending': [320193]})

        def broken(url, headers=None, timeout=None):
            if '/daily-index/' in url:
                return mock.Mock(status_code=500, raise_for_status=mock.Mock(side_effect=__import__('requests').HTTPError('500')))
            if 'submissions' in url:
                raise __import__('requests').ConnectionError('down')
            return get(url, headers, timeout)
        counts = filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=broken, interval=0)
        self.assertTrue(counts['index'].startswith('unavailable'))
        self.assertEqual((counts['due'], self.state()['pending']), (1, [320193]))  # still due, still pending

    def test_a_company_the_run_did_not_reach_stays_pending(self):
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        INDEXES['20261119'] = '320193|Apple Inc.|10-Q|2026-11-19|x\n'
        self.addCleanup(INDEXES.clear)
        later = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)
        import requests

        def failing(url, headers=None, timeout=None):
            if 'submissions' in url:  # the company's own list fails this run
                raise requests.ConnectionError('down')
            return get(url, headers, timeout)
        counts = filings.refresh([{'symbol': 'AAPL'}], self.root, later, get=failing, interval=0)
        self.assertEqual((counts['failed'], counts['pending']), (1, 1))
        INDEXES.clear()  # the next run reads no new index, but the pending company is still due
        self.assertEqual(filings.refresh([{'symbol': 'AAPL'}], self.root, later, get=get, interval=0)['fetched'], 1)

    def test_results_releases_are_dated_in_new_york(self):
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        self.assertEqual(filings.result_dates(self.root, 'AAPL'), ['2015-10-27', '2026-11-02'])  # New York's date, not UTC's

    def test_the_history_is_indias_shape_for_the_chart_announcements(self):
        import build_chart_artifacts
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        payload = filings.history([{'symbol': 'AAPL'}, {'symbol': 'NONE'}], self.root, self.now.isoformat())
        self.assertEqual([entry['symbol'] for entry in payload['records']], ['AAPL'])
        # The shared filing-history spec's fields (artifacts.py: source, coverage, records).
        self.assertEqual(payload['coverage'], {'companies': 1, 'filings': 3})
        self.assertEqual(payload['records'][0]['filings'][0]['caption'], '8-K: Results of operations and financial condition')
        events = build_chart_artifacts._filing_events(payload, '2026-11-20')['AAPL']
        self.assertEqual(len(events), 3)
        self.assertEqual(events[-1]['category'], 'Regulatory filing')

    def test_no_contact_fetches_nothing_and_a_rate_limit_stops_the_rest(self):
        with mock.patch.dict(os.environ, {'SEC_CONTACT': ''}):
            self.assertEqual(filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=mock.Mock(side_effect=AssertionError)), {'skipped': 'no SEC_CONTACT'})

        def limited(url, headers=None, timeout=None):
            return get(url, headers) if url == filings.TICKERS_URL else mock.Mock(status_code=429)
        counts = filings.refresh([{'symbol': 'AAPL'}, {'symbol': 'BRK.B'}], self.root, self.now, get=limited, interval=0, workers=1)
        self.assertTrue(counts['throttled'])
        self.assertEqual(counts['fetched'], 0)


if __name__ == '__main__':
    unittest.main()
