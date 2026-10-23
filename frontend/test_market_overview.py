import gzip
import json
import unittest

import tempfile
from pathlib import Path

from market_overview import BREADTH_SESSIONS, benchmark_series, market_overview


def gz(payload):
    return gzip.compress(json.dumps(payload).encode())


def breadth_record(date, above_50=40.0):
    return {'date': date, 'advances': 1000, 'declines': 800, 'above_50_pct': above_50, 'extra_field': 1}


class MarketOverviewTest(unittest.TestCase):
    def test_returns_none_without_breadth(self):
        self.assertIsNone(market_overview({}, '2026-10-22'))

    def test_caps_breadth_at_session_and_keeps_recent_window(self):
        dates = [f'2026-{month:02d}-{day:02d}' for month in range(1, 11) for day in range(1, 29)]
        records = [breadth_record(date) for date in dates] + [breadth_record('2026-12-01')]
        result = market_overview({'market_breadth_v2.json.gz': gz({'records': records})}, '2026-10-22')
        self.assertEqual(len(result['breadth']), BREADTH_SESSIONS)
        self.assertEqual(result['breadth'][-1]['date'], '2026-10-22')
        self.assertNotIn('extra_field', result['breadth'][-1])
        self.assertIsNone(result['breadth'][-1]['new_52w_high'])

    def test_drops_non_finite_and_boolean_numbers(self):
        record = {'date': '2026-10-22', 'advances': True, 'declines': float('inf'), 'above_50_pct': 12.5}
        result = market_overview({'market_breadth_v2.json.gz': gzip.compress(json.dumps({'records': [record]}).encode())}, '2026-10-22')
        self.assertIsNone(result['breadth'][0]['advances'])
        self.assertIsNone(result['breadth'][0]['declines'])
        self.assertEqual(result['breadth'][0]['above_50_pct'], 12.5)

    def test_sectors_skip_tiny_groups_and_sort_by_breadth(self):
        sectors = [
            {'name': 'Small', 'stock_count': 2, 'above_sma50_percent': 100},
            {'name': 'Banks', 'stock_count': 30, 'above_sma50_percent': 20},
            {'name': 'IT Software', 'stock_count': 40, 'above_sma50_percent': 70},
        ]
        result = market_overview({
            'market_breadth_v2.json.gz': gz({'records': [breadth_record('2026-10-22')]}),
            'sector_analytics.json.gz': gz({'sectors': sectors}),
        }, '2026-10-22')
        self.assertEqual([s['name'] for s in result['sectors']], ['IT Software', 'Banks'])

    def test_index_cards_use_session_capped_closes(self):
        indices = [{'symbol': 'NIFTY', 'name': 'Nifty 50', 'records': [
            {'date': '2026-10-20', 'close': 100.0},
            {'date': '2026-10-21', 'close': 110.0},
            {'date': '2026-10-22', 'close': 99.0},
        ]}, {'symbol': 'UNLISTED', 'records': [{'date': '2026-10-21', 'close': 1}, {'date': '2026-10-22', 'close': 2}]}]
        result = market_overview({
            'market_breadth_v2.json.gz': gz({'records': [breadth_record('2026-10-21')]}),
            'all_indices_history_v2.json.gz': gz({'indices': indices}),
        }, '2026-10-21')
        self.assertEqual(len(result['indices']), 1)
        card = result['indices'][0]
        self.assertEqual((card['date'], card['close'], card['changePct'], card['series']), ('2026-10-21', 110.0, 10.0, [100.0, 110.0]))


class BenchmarkSeriesTest(unittest.TestCase):
    def test_merges_csv_history_with_fresher_index_closes_and_caps_at_session(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / 'indices_ohlcv_data'
            folder.mkdir()
            (folder / 'NIFTY.csv').write_text('Date,Open,High,Low,Close,Volume\n2026-10-19,1,1,1,100,1\n2026-10-20,1,1,1,101,1\nbad,1,1,1,x,1\n')
            indices = {'indices': [{'symbol': 'NIFTY', 'name': 'Nifty 50', 'records': [
                {'date': '2026-10-20', 'close': 102.0}, {'date': '2026-10-21', 'close': 103.0}, {'date': '2026-10-22', 'close': 104.0}]}]}
            result = benchmark_series(root, {'all_indices_history_v2.json.gz': gz(indices)}, '2026-10-21')
        self.assertEqual(result['records'], [['2026-10-19', 100.0], ['2026-10-20', 102.0], ['2026-10-21', 103.0]])
        self.assertEqual((result['symbol'], result['name'], result['asOfDate']), ('NIFTY', 'Nifty 50', '2026-10-21'))

    def test_returns_none_without_enough_history(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(benchmark_series(root, {}, '2026-10-21'))


if __name__ == '__main__':
    unittest.main()
