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
    {'accessionNumber': '0000320193-26-000101', 'filingDate': '2026-11-02', 'acceptanceDateTime': '2026-11-02T21:30:23.000Z',
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


def get(url, headers=None, timeout=None):
    assert headers['User-Agent'] == 'NexusScanner ops@example.org'
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
        # Not due again within a week, unless a new earnings date has been reported since.
        self.assertEqual(filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)['due'], 0)
        self.assertEqual(filings.refresh([{'symbol': 'AAPL', 'latest_earnings_date': '2026-11-20'}], self.root, self.now, get=get, interval=0)['due'], 1)

    def test_results_releases_are_dated_in_new_york(self):
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        self.assertEqual(filings.result_dates(self.root, 'AAPL'), ['2015-10-27', '2026-11-02'])  # 21:30 UTC is 16:30 in New York

    def test_the_history_is_indias_shape_for_the_chart_announcements(self):
        import build_chart_artifacts
        filings.refresh([{'symbol': 'AAPL'}], self.root, self.now, get=get, interval=0)
        payload = filings.history([{'symbol': 'AAPL'}, {'symbol': 'NONE'}], self.root, self.now.isoformat())
        self.assertEqual([entry['symbol'] for entry in payload['records']], ['AAPL'])
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
