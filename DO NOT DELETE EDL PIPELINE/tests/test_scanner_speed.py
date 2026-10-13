"""Equivalence and cache-lifetime coverage for scanner CPU optimizations."""
import copy
from datetime import datetime
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'src')]

import build_chart_artifacts as charts
from edl_pipeline.scanner import history, trend, context
from edl_pipeline.scanner.calculation_cache import calculation_cache, memoized


class ScannerSpeedTests(unittest.TestCase):
    def test_indexed_snapshot_matches_full_scans_with_ties_and_date_bounds(self):
        stocks = [{'symbol': symbol, 'as_of_date': '2026-09-01'} for symbol in ('a', 'B', 'NONE')]
        earnings = [
            {'symbol': 'A', 'announcement_date': '2026-08-01', 'observed_on': '2026-08-02', 'latest_quarter': 'Q1', 'qoq_percent_net_profit_latest': 12},
            {'symbol': 'a', 'announcement_date': '2026-08-01', 'observed_on': '2026-08-02', 'latest_quarter': 'Q1', 'qoq_percent_net_profit_latest': 99},
            {'symbol': 'B', 'announcement_date': '2026-08-05', 'observed_on': '2026-09-03'},
            {'symbol': 'A', 'announcement_date': 'bad', 'observed_on': '2026-08-02'},
        ]
        holdings = [
            {'symbol': 'a', 'period_end': '2026-03-31', 'observed_on': '2026-04-02', 'fii_holding_percent': 10.1234},
            {'symbol': 'A', 'period_end': '2026-06-30', 'observed_on': '2026-07-02', 'fii_holding_percent': 11.2345},
            {'symbol': 'A', 'period_end': '2026-06-30', 'observed_on': '2026-07-02', 'fii_holding_percent': 99},
            {'symbol': 'A', 'period_end': '2026-09-30', 'observed_on': '2026-10-02', 'fii_holding_percent': 20},
            {'symbol': 'B', 'period_end': 'bad', 'observed_on': '2026-07-02'},
        ]
        original = copy.deepcopy((stocks, earnings, holdings))
        def snapshot():
            with mock.patch.object(history, '_write_gzip_json') as write:
                history.build_snapshot(Path('/unused'), stocks, {}, {}, '2026-09-01', earnings, holdings)
            return json.dumps(write.call_args.args[1], ensure_ascii=False, separators=(',', ':'))
        with mock.patch.object(history, '_observations_by_symbol', return_value=None):
            baseline = snapshot()
        self.assertEqual(snapshot(), baseline)
        self.assertEqual((stocks, earnings, holdings), original)
        result = json.loads(baseline)['stocks'][0]
        self.assertEqual(result['qoq_percent_net_profit_latest'], 12)
        self.assertEqual(result['fii_percent_change_qoq'], 1.1111)

    def test_one_shot_observations_and_empty_stocks_keep_original_behavior(self):
        observations = [{'symbol': s, 'announcement_date': '2026-08-01', 'observed_on': '2026-08-02'} for s in ('A', 'B')]
        stocks = [{'symbol': s} for s in ('A', 'B')]
        with mock.patch.object(history, '_write_gzip_json') as write:
            history.build_snapshot(Path('/unused'), stocks, {}, {}, '2026-09-01', iter(observations))
            rows = write.call_args.args[1]['stocks']
            self.assertEqual(rows[0]['latest_earnings_date'], '2026-08-01')
            self.assertIsNone(rows[1]['latest_earnings_date'])
            history.build_snapshot(Path('/unused'), [], {}, {}, '2026-09-01', [None], [None])
            self.assertEqual(write.call_args.args[1]['stocks'], [])

    def test_chart_date_cache_keeps_parser_acceptance_and_is_bounded(self):
        values = ['2026-10-08', '2026-1-2', '2026-10-08T12:00:00Z', '2026-02-30', None, 20261008, [], {'date': 'x'}]
        charts._parsed_date.cache_clear()
        for value in values:
            try:
                expected = datetime.strptime(str(value or '')[:10], '%Y-%m-%d').date().isoformat()
            except ValueError:
                expected = None
            self.assertEqual(charts._date(value), expected)
            self.assertEqual(charts._date(value), expected)
        self.assertGreaterEqual(charts._parsed_date.cache_info().hits, len(values))
        for index in range(16385):
            charts._date(str(index))
        self.assertEqual(charts._parsed_date.cache_info().currsize, 16384)
        charts._parsed_date.cache_clear()

    def frame(self):
        close = 100 + np.sin(np.arange(300) / 7) * 5 + np.arange(300) / 10
        return pd.DataFrame({'Date': pd.bdate_range(end='2026-10-08', periods=300),
                             'Open': close, 'High': close + 2, 'Low': close - 2,
                             'Close': close, 'Volume': 100.})

    def test_calculations_reuse_only_within_scope_and_respect_all_inputs(self):
        frame = self.frame()
        benchmark = frame[['Date', 'Close']].rename(columns={'Close': 'close'})
        baseline = trend._ma(frame, 'ema', 20)
        with calculation_cache():
            first = trend._ma(frame, 'ema', 20)
            self.assertIs(first, trend._ma(frame, 'ema', 20))
            self.assertIsNot(first, trend._ma(frame, 'sma', 20))
            self.assertIsNot(first, trend._ma(frame, 'ema', 50))
            pd.testing.assert_series_equal(first, baseline)
            aligned = context._aligned_relative_strength(frame, benchmark)
            self.assertIs(aligned, context._aligned_relative_strength(frame, benchmark))
            self.assertIsNot(aligned, context._aligned_relative_strength(frame.copy(), benchmark))
            self.assertIsNot(aligned, context._aligned_relative_strength(frame, benchmark.copy()))
            keyword = trend._ma(frame, ma_type='ema', period=20)
            self.assertIs(keyword, trend._ma(frame, ma_type='ema', period=20))
            with calculation_cache():
                nested = trend._ma(frame, 'ema', 20)
                self.assertIsNot(nested, first)
                self.assertIs(nested, trend._ma(frame, 'ema', 20))
            self.assertIs(first, trend._ma(frame, 'ema', 20))
        frame.loc[len(frame) - 1, 'Close'] += 10
        with calculation_cache():
            corrected = trend._ma(frame, 'ema', 20)
            self.assertIsNot(corrected, first)
            self.assertNotEqual(corrected.iloc[-1], first.iloc[-1])

    def test_persistence_matches_uncached_for_modes_durations_and_nan_warmup(self):
        frame = self.frame()
        frame.loc[90:92, 'Close'] = np.nan
        specs = [(side, days, mode) for side in ('above', 'below') for days in (1, 5, 20, 300, 301)
                 for mode in ('strict_close', 'extreme_reset', 'reclaim_by_extreme')]
        baseline = [trend._persisted(frame, trend._ma(frame, 'ema', 20), *spec) for spec in specs]
        with calculation_cache():
            actual = [trend._persisted(frame, trend._ma(frame, 'ema', 20), *spec) for spec in specs]
        self.assertEqual(actual, baseline)

    def test_scope_restores_after_exception_and_does_not_cache_errors(self):
        calls = []
        @memoized
        def compute(value):
            calls.append(value)
            if value == 'bad':
                raise ValueError('bad')
            return object()
        first = None
        with self.assertRaises(ValueError), calculation_cache():
            first = compute('ok')
            self.assertIs(first, compute('ok'))
            compute('bad')
        self.assertIsNot(first, compute('ok'))
        with calculation_cache():
            for _ in range(2):
                with self.assertRaises(ValueError):
                    compute('bad')
            self.assertIsNot(compute([]), compute([]))
        self.assertEqual(calls.count('bad'), 3)


if __name__ == '__main__':
    unittest.main()
