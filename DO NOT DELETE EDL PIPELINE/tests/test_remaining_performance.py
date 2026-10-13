"""Equivalence and failure contracts for the remaining CPU/I/O optimizations."""

import csv
import gzip
import json
import math
import tempfile
import unittest
from concurrent.futures import Future
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

import import_eod2_ohlcv as eod2
from screen_trend_conditions import _load_delivery_history
from edl_pipeline.breadth.aggregates import (
    BreadthAccumulator, INTEGER_COLUMNS, VOLUME_FIELDS, _blank_record, _increment_flags,
)
from edl_pipeline.breadth.config import BreadthMethodology
from edl_pipeline.breadth.indicators import prepare_history
from test_breadth_v2 import make_ohlcv


def eod2_fixture(root, count=8, sessions=25):
    source = root / 'source'; (source / 'daily').mkdir(parents=True)
    mapping = {'sym2isin': {}, 'isin2hist': {}}
    master = []
    dates = pd.bdate_range('2020-01-01', periods=sessions).strftime('%Y-%m-%d')
    for i in range(count):
        symbol, isin = f'SYM{i:04d}', f'ISIN{i}'
        master.append({'Symbol': symbol, 'ISIN': isin})
        mapping['sym2isin'][symbol] = isin
        mapping['isin2hist'][isin] = [
            {'symbol': f'OLD{i}', 'from_date': dates[0], 'to_date': dates[3]},
            {'symbol': symbol, 'from_date': dates[4], 'to_date': dates[-3]},
        ]
        for name, close in ((f'old{i}', 9), (symbol.lower(), 10)):
            with (source / f'daily/{name}.csv').open('w', newline='') as handle:
                writer = csv.writer(handle)
                writer.writerow(['Date', 'Open', 'High', 'Low', 'Close', 'Volume', 'DLV_QTY', 'Series'])
                writer.writerows([day, close, close + 1, close - 1, close, 100, 50, 'EQ'] for day in dates)
    (source / 'isin_symbol_map.json').write_text(json.dumps(mapping))
    (source / 'meta.json').write_text(json.dumps({'lastUpdate': dates[-1]}))
    # Retain newer sessions and replace locally incorrect overlapping prices.
    existing = 'Date,Open,High,Low,Close,Volume\r\n2020-01-01,20,21,19,20,100\r\n2030-01-01,30,31,29,30,200\r\n'
    for label in ('serial', 'parallel'):
        output = root / label / 'ohlcv'; output.mkdir(parents=True)
        for item in master:
            (output / f"{item['Symbol']}.csv").write_bytes(existing.encode())
    return source, master


def artifact_bytes(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*.csv')}


class RemainingPerformanceTests(unittest.TestCase):
    def test_native_predicates_match_nullable_pandas_for_missing_and_boundary_values(self):
        method = BreadthMethodology()
        history = prepare_history(make_ohlcv([100 + i % 29 for i in range(300)]), method)
        history.loc[history.index[-10:], 'Daily_Return'] = [0, 4, -4, 4.5, -4.5, np.nan, np.inf, -np.inf, .1, -.1]
        native = _increment_flags(history, method)
        nullable = history.copy()
        for name in nullable:
            if name != 'Date':
                nullable[name] = nullable[name].astype('boolean' if nullable[name].dtype == bool else 'Float64')
        fallback = _increment_flags(nullable, method)
        self.assertEqual(native[0], fallback[0])
        np.testing.assert_array_equal(native[1], fallback[1])

    def test_integer_counters_match_original_scalar_replay_and_float_order(self):
        method = BreadthMethodology()
        actual = BreadthAccumulator(method, include_contributions=True)
        records, contributions = {}, {}
        for symbol, start in [('A', '2024-01-01'), ('B', '2023-01-01'), ('C', '2024-01-01')]:
            raw = make_ohlcv([100 + i % 29 for i in range(220)], start)
            raw['Volume'] = [1e16, 0, math.nan, 0.1] * 55
            history = prepare_history(raw, method)
            # Direct callers may repeat dates; each repeated increment must count.
            history = pd.concat([history, history.tail(1)], ignore_index=True)
            names, flags = _increment_flags(history, method)
            for day, volume, mask in zip(history['Date'], history['Volume'], flags):
                record = records.setdefault(day, _blank_record(day))
                audit = contributions.setdefault(day, {})
                for index in np.flatnonzero(mask):
                    field = names[index]
                    record[field] += float(volume) if field in VOLUME_FIELDS else 1
                    audit.setdefault(field, []).append(symbol)
            actual.update(history, symbol)
        expected = [records[day] for day in sorted(records)]
        self.assertEqual(json.dumps(actual.records()), json.dumps(expected))
        expected_audit = [{'date': day, 'metrics': {field: sorted(values) for field, values in contributions[day].items()}}
                          for day in sorted(contributions)[-method.output_sessions:]]
        self.assertEqual(actual.contribution_records(), expected_audit)
        self.assertTrue(all(type(row['advances']) is int for row in actual.records()))

    def test_integer_counters_promote_before_native_overflow(self):
        method = BreadthMethodology()
        actual = BreadthAccumulator(method)
        history = prepare_history(make_ohlcv([100]), method)
        actual.update(history)
        limit = np.iinfo(np.int64).max
        actual._counts[0, INTEGER_COLUMNS['eligible_with_candle']] = limit
        actual._total_updates = int(limit)
        actual.update(history)
        self.assertEqual(actual.records()[0]['eligible_with_candle'], int(limit) + 1)
        self.assertEqual(actual._counts.dtype, object)

    def test_delivery_window_preserves_official_precedence_and_csv_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); official = root / 'official'; official.mkdir()
            fallback = root / 'eod2'; fallback.mkdir()
            rows = [
                {'symbol': 'ABC', 'date': '2026-09-30', 'delivery_percent': 40},
                {'symbol': 'ABC', 'date': '2026-09-30', 'delivery_percent': None},
                {'symbol': 'ABC', 'date': '2020-01-01', 'delivery_percent': 99},
                {'symbol': 'OTHER', 'date': '2026-09-30', 'delivery_percent': 20},
            ]
            # Payload dates, not the filename, determine membership.
            (official / '2000-01-01.json').write_text(json.dumps({'records': rows}))
            (official / '2000-01-01.json.gz').write_bytes(gzip.compress(json.dumps({'records': [
                {'symbol': 'ABC', 'date': '2026-09-29', 'delivery_percent': 61},
            ]}).encode(), mtime=0))
            (official / '2000-01-02.json').write_text('malformed')
            (fallback / 'ABC.csv').write_text(
                'Date,delivery_percent\n2026-09-30,99\n2026-09-28,71\n2026-09-28,88\n2020-01-01,5\n')
            windows = {'ABC': {'2026-09-28', '2026-09-29', '2026-09-30'}}
            full = _load_delivery_history(official, None, fallback)
            bounded = _load_delivery_history(official, None, fallback, windows=windows)
            self.assertEqual(bounded, {'ABC': [row for row in full['ABC'] if row['date'] in windows['ABC']]})
            self.assertIsNone(next(row for row in bounded['ABC'] if row['date'] == '2026-09-30')['delivery_percent'])
            frozen_csv = (fallback / 'ABC.csv').read_bytes()
            with mock.patch.object(Path, 'open', side_effect=AssertionError('unneeded fallback reread')):
                self.assertEqual(_load_delivery_history(
                    official, None, fallback, windows={'ABC': {'2026-09-30'}},
                    cached_records={official / '2000-01-01.json': rows,
                                    official / '2000-01-01.json.gz': [], official / '2000-01-02.json': []},
                    csv_payloads={fallback / 'ABC.csv': frozen_csv}
                )['ABC'][0]['delivery_percent'], None)

    def test_covered_delivery_csv_still_preserves_encoding_and_parser_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); official = root / 'official'; official.mkdir()
            fallback = root / 'fallback'; fallback.mkdir()
            (official / '2026-09-30.json').write_text(json.dumps({'records': [
                {'symbol': 'ABC', 'date': '2026-09-30', 'delivery_percent': 60},
            ]}))
            path = fallback / 'ABC.csv'
            for raw, error in ((b'Date,delivery_percent\n\xff,60\n', UnicodeDecodeError),
                               (b'Date,delivery_percent\n' + b'x' * (csv.field_size_limit() + 1), csv.Error)):
                path.write_bytes(raw)
                with self.assertRaises(error):
                    _load_delivery_history(official, None, fallback)
                with self.assertRaises(error):
                    _load_delivery_history(official, None, fallback,
                                           windows={'ABC': {'2026-09-30'}}, csv_payloads={path: raw})

    def test_eod2_spawn_workers_keep_every_byte_and_report_and_skip_unchanged_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, master = eod2_fixture(root)
            (source / 'daily/empty.csv').write_text('Date,Open,High,Low,Close,Volume\ninvalid,1,1,1,1,1\n')
            mapping = json.loads((source / 'isin_symbol_map.json').read_text())
            mapping['sym2isin']['EMPTY'] = 'EMPTY'
            (source / 'isin_symbol_map.json').write_text(json.dumps(mapping))
            master += [{'Symbol': 'EMPTY', 'ISIN': 'EMPTY'}, {'Symbol': 'UNMAPPED', 'ISIN': 'NONE'}, {}]
            serial = eod2.import_eod2_ohlcv(source, master, root / 'serial/ohlcv', workers=1)
            parallel = eod2.import_eod2_ohlcv(source, master, root / 'parallel/ohlcv', workers=2)
            self.assertEqual(json.dumps(parallel), json.dumps(serial))
            self.assertEqual(artifact_bytes(root / 'parallel'), artifact_bytes(root / 'serial'))
            with mock.patch.object(Path, 'write_bytes', side_effect=AssertionError('unchanged rewrite')):
                self.assertEqual(eod2.import_eod2_ohlcv(source, master, root / 'parallel/ohlcv', workers=2), serial)

    def test_eod2_duplicate_destinations_use_serial_read_after_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, master = eod2_fixture(root, count=1)
            master *= 2
            with mock.patch.object(eod2, 'ProcessPoolExecutor', side_effect=AssertionError('unsafe parallelism')):
                serial = eod2.import_eod2_ohlcv(source, master, root / 'serial/ohlcv', workers=1)
                parallel = eod2.import_eod2_ohlcv(source, master, root / 'parallel/ohlcv', workers=2)
            self.assertEqual(parallel, serial)
            self.assertEqual(artifact_bytes(root / 'parallel'), artifact_bytes(root / 'serial'))

    def test_eod2_worker_failure_is_observed_in_order_and_cancels_bounded_queue(self):
        futures = []
        executor = mock.Mock()
        def submit(function, task):
            future = Future()
            if not futures:
                future.set_result('first')
            elif len(futures) == 1:
                future.set_exception(ValueError('second failed'))
            futures.append(future)
            return future
        executor.submit.side_effect = submit
        with mock.patch.object(eod2, 'ProcessPoolExecutor', return_value=executor):
            results = eod2._ordered_preparations(iter(range(5000)), 2)
            self.assertEqual(next(results), 'first')
            with self.assertRaisesRegex(ValueError, 'second failed'):
                next(results)
        self.assertEqual(len(futures), 5)
        self.assertTrue(all(future.cancelled() for future in futures[2:]))
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    def test_eod2_later_preparation_failure_keeps_earlier_commits_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, master = eod2_fixture(root)
            # A malformed local CSV is read successfully but fails its original
            # merge validation in the second security's worker.
            bad = root / 'parallel/ohlcv' / f"{master[1]['Symbol']}.csv"
            bad.write_text('bad_header\ninvalid\n')
            before = artifact_bytes(root / 'parallel')
            with self.assertRaises(KeyError):
                eod2.import_eod2_ohlcv(source, master, root / 'parallel/ohlcv', workers=2)
            after = artifact_bytes(root / 'parallel')
            self.assertNotEqual(after[f"ohlcv/{master[0]['Symbol']}.csv"], before[f"ohlcv/{master[0]['Symbol']}.csv"])
            for item in master[1:]:
                key = f"ohlcv/{item['Symbol']}.csv"
                self.assertEqual(after[key], before[key])

    def test_eod2_parent_write_failure_does_not_commit_speculative_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, master = eod2_fixture(root)
            before = artifact_bytes(root / 'parallel')
            original = eod2._write_csv_bytes_if_changed
            def fail_second(path, data):
                if path.name == f"{master[1]['Symbol']}.csv":
                    raise OSError('disk full')
                original(path, data)
            with mock.patch.object(eod2, '_write_csv_bytes_if_changed', side_effect=fail_second):
                with self.assertRaisesRegex(OSError, 'disk full'):
                    eod2.import_eod2_ohlcv(source, master, root / 'parallel/ohlcv', workers=2)
            after = artifact_bytes(root / 'parallel')
            for item in master[1:]:
                key = f"ohlcv/{item['Symbol']}.csv"
                self.assertEqual(after[key], before[key])


if __name__ == '__main__':
    unittest.main()
