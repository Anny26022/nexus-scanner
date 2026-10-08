"""Output and failure equivalence for bounded refresh optimizations."""
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock
from dataclasses import replace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'src')]
from json_records import object_members, record_artifact
from announcement_artifacts import build_announcements, object_bytes, put_object
from edl_pipeline.validators import strict_json_decoder, validate_json, validate_gzip_json
from edl_pipeline.breadth.pipeline import _save_json
import build_chart_artifacts as charts
import import_eod2_ohlcv as eod2
from edl_pipeline.breadth.aggregates import BreadthAccumulator
from edl_pipeline.breadth.config import BreadthMethodology
from edl_pipeline.breadth.indicators import prepare_history
from test_breadth_v2 import make_ohlcv


def breadth_digest(accumulator_class):
    method = replace(BreadthMethodology(), output_sessions=5)
    accumulators = [accumulator_class(method, include_contributions=True) for _ in range(3)]
    for n, (symbol, start, count, groups) in enumerate([
        ('A', '2023-01-01', 310, (0, 1, 2)),
        ('B', '2024-01-01', 270, (0, 1)),
        ('C', '2022-01-01', 40, (0, 2))]):
        raw = make_ohlcv([100 + i % 17 for i in range(count)], start)
        raw['Volume'] = [[1e16, 0, float('nan'), 0.1][(i + n) % 4] for i in range(count)]
        history = prepare_history(raw, method)
        accumulators[groups[0]].update(history, symbol, peers=[accumulators[i] for i in groups[1:]])
    payload = [(a.records(), a.contribution_records()) for a in accumulators]
    return hashlib.sha256(json.dumps(payload, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


class PipelineSpeedTests(unittest.TestCase):
    def test_breadth_keeps_audited_scalar_bytes_with_overlap_and_fractional_volumes(self):
        self.assertEqual(breadth_digest(BreadthAccumulator), '437c446f5ac2bcb6245b05cd44edaf9bc6714d7c0bcbcf56139cdb4a153c60cc')

    def test_record_decoder_matches_python_across_chunk_boundaries(self):
        payload = {'before': {'text': '₹\\\n"😃'}, 'records': [
            None, True, -0.0, 1e100, {'symbol': 'A', 'nested': [[1, 2], {}]}],
            'after': [None, 'value']}
        source = json.dumps(payload, ensure_ascii=False)
        for size in (1, 2, 7, 1024):
            with self.subTest(size=size):
                restored = {}
                for key, value, is_record in object_members(io.StringIO(source), chunk_size=size):
                    if is_record:
                        restored[key].append(value)
                    else:
                        restored[key] = value
                self.assertEqual(restored, json.loads(source))

    def test_decoder_does_not_read_ahead_through_the_whole_archive(self):
        handle = io.StringIO(json.dumps({'records': [{'symbol': str(i)} for i in range(1000)]}))
        iterator = object_members(handle, chunk_size=64)
        self.assertEqual(next(iterator), ('records', [], False))
        self.assertEqual(next(iterator), ('records', {'symbol': '0'}, True))
        self.assertLessEqual(handle.tell(), 64)
        self.assertEqual(sum(is_record for _, _, is_record in iterator), 999)

    def test_record_batched_breadth_writer_preserves_standard_encoder_bytes(self):
        payload = {'metadata': {'text': '₹😃', 'null': None, 'negativeZero': -0.0, None: 'null key', 1.5: 'number key'},
                   'universes': {'all': {'records': [{'date': '2026-10-08', 'metrics': {'A': [1e100, True]}}]}},
                   'sectors': [{'name': 'A', 'records': [{'value': 1.123456789}]}]}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'breadth.json'
            _save_json(path, payload)
            self.assertEqual(path.read_bytes(), json.dumps(payload, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode())

    def test_gzip_filing_validation_streams_and_checks_the_complete_trailer(self):
        with tempfile.TemporaryDirectory() as folder:
            stream, full = (Path(folder) / name for name in ('filing_history.json.gz', 'full.json.gz'))
            for raw in (b'{"records":[{"value":1.25}],"source":"test"}',
                        b'{"records":[],"records":[1,2],"source":"test"}',
                        b'{"records":[1e999],"source":"test"}',
                        b'{"records":[NaN],"source":"test"}',
                        b'{"records":[1,],"source":"test"}',
                        b'{"records":[1],"source":"test"} trailing',
                        b'{"records":null,"source":"test"}'):
                packed = gzip.compress(raw, mtime=0)
                stream.write_bytes(packed); full.write_bytes(packed)
                args = {'required_fields': ('records', 'source'), 'nested_min_counts': (('records', 1),)}
                before, after = validate_gzip_json(full, **args), validate_gzip_json(stream, **args)
                self.assertEqual((before.ok, before.count), (after.ok, after.count))
            packed = gzip.compress(b'{"records":[1],"source":"test"}', mtime=0)
            stream.write_bytes(packed)
            with mock.patch('edl_pipeline.validators.strict_json_load', side_effect=AssertionError('full load')):
                self.assertTrue(validate_gzip_json(stream).ok)
            corrupt = bytearray(packed); corrupt[-8] ^= 1
            for damaged in (packed[:-1], bytes(corrupt), packed + gzip.compress(b'x', mtime=0)):
                stream.write_bytes(damaged)
                self.assertFalse(validate_gzip_json(stream).ok)

    def test_streaming_validator_keeps_shape_finiteness_and_tail_checks(self):
        sources = ['{"records":[{"value":1.25}],"source":"test"}',
                   '{"records":[],"records":[1,2],"source":"test"}',
                   '[{"records":[],"source":"test"}]',
                   '{"records":[1e999],"source":"test"}',
                   '{"records":[NaN],"source":"test"}',
                   '{"records":[{"bad":Infinity}],"source":"test"}',
                   '{"records":[1,],"source":"test"}',
                   '{"records":[1],"source":"test"} trailing',
                   '{"records":[1],"source":"test"',
                   '{"records":null,"source":"test"}']
        with tempfile.TemporaryDirectory() as folder:
            stream, full = (Path(folder) / name for name in ('filing_history.json', 'full.json'))
            for source in sources:
                stream.write_text(source); full.write_text(source)
                args = {'required_fields': ('records', 'source'), 'nested_min_counts': (('records', 1),)}
                a, b = validate_json(stream, **args), validate_json(full, **args)
                self.assertEqual((a.ok, a.count), (b.ok, b.count), source)
                if a.ok:
                    self.assertEqual(a.size_bytes, b.size_bytes)
        for source in ('{"records":[1,]}', '{"records":[-Infinity]}', '{"records":[]}x'):
            with self.assertRaises(ValueError):
                list(object_members(io.StringIO(source), strict_json_decoder(), chunk_size=1))

    def test_streamed_announcements_and_cached_objects_keep_every_byte(self):
        from test_announcement_artifacts import filing
        payload = {'updated_at': '2026-10-07', 'records': [
            {'symbol': symbol, 'filings': [filing('2025-01-01', symbol + str(i)) for i in range(101)]}
            for symbol in ('A', 'B')]}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / 'filing_history.json'
            source.write_text(json.dumps(payload))
            before, after, cache = root / 'before', root / 'after', root / 'cache'
            expected = build_announcements(payload, before, {'A', 'B', 'MISSING'}, '2026-10-06')
            actual = build_announcements(record_artifact(source), after, {'A', 'B', 'MISSING'}, '2026-10-06', cache)
            self.assertEqual(actual, expected)
            self.assertEqual({p.name: p.read_bytes() for p in before.iterdir()},
                             {p.name: p.read_bytes() for p in after.iterdir()})
            # A warm run must not recompress retained immutable pages.
            with mock.patch('announcement_artifacts.gzip.compress', side_effect=AssertionError('cache miss')):
                self.assertEqual(build_announcements(record_artifact(source), after, {'A', 'B', 'MISSING'}, '2026-10-06', cache), expected)
            value = {'proof': 'exact bytes'}
            digest = put_object(after, value, cache)
            cached = next(p for p in cache.glob('*.json.gz') if gzip.decompress(p.read_bytes()) == json.dumps(value, sort_keys=True, separators=(',', ':')).encode())
            data = bytearray(cached.read_bytes()); data[9] ^= 1; cached.write_bytes(data)
            self.assertEqual(put_object(after, value, cache), digest)
            self.assertEqual(cached.read_bytes(), object_bytes(value))
            build_announcements(record_artifact(source), after, {'A', 'B', 'MISSING'}, '2026-10-06', cache)
            self.assertFalse(cached.exists())
            self.assertFalse(cached.with_suffix('.sha256').exists())
            self.assertTrue((after / (digest + '.json.gz')).exists())

    def test_parallel_charts_match_sequential_objects_and_failed_worker_keeps_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'all_stocks_fundamental_analysis.json').write_text(json.dumps([
                {'symbol': f'S{i:02d}', 'as_of_date': '2026-10-06'} for i in range(32)]))
            (root / 'ohlcv_data').mkdir()
            for i in range(32):
                (root / 'ohlcv_data' / f'S{i:02d}.csv').write_text('Date,Open,High,Low,Close,Volume\n2026-10-06,10,11,9,10,100\n')
            with mock.patch.object(charts, 'BASE_DIR', str(root)), mock.patch.object(charts.os, 'cpu_count', return_value=1):
                self.assertEqual(charts.main(), 0)
            before = {str(p.relative_to(root / 'chart_artifacts')): p.read_bytes()
                      for p in (root / 'chart_artifacts').rglob('*') if p.is_file()}
            with mock.patch.object(charts, 'BASE_DIR', str(root)), mock.patch.object(charts.os, 'cpu_count', return_value=2):
                self.assertEqual(charts.main(), 0)
            after = {str(p.relative_to(root / 'chart_artifacts')): p.read_bytes()
                     for p in (root / 'chart_artifacts').rglob('*') if p.is_file()}
            self.assertEqual(after, before)
            with mock.patch.object(charts, 'BASE_DIR', str(root)), mock.patch.object(charts, '_chart_object', side_effect=RuntimeError('worker failed')), mock.patch.object(charts.os, 'cpu_count', return_value=1):
                with self.assertRaisesRegex(RuntimeError, 'worker failed'):
                    charts.main()
            self.assertEqual((root / 'chart_artifacts/index.json').read_bytes(), before['index.json'])

    def test_announcements_overlap_candles_and_failure_keeps_previous_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'all_stocks_fundamental_analysis.json').write_text(json.dumps([
                {'symbol': 'A', 'as_of_date': '2026-10-06'}]))
            started, release = threading.Event(), threading.Event()
            original_announcement, original_chart = charts.build_announcements, charts._chart_object
            def announcement(*args, **kwargs):
                started.set()
                self.assertTrue(release.wait(5))
                return original_announcement(*args, **kwargs)
            def candle(task):
                self.assertTrue(started.wait(5))
                release.set()
                return original_chart(task)
            with mock.patch.object(charts, 'BASE_DIR', str(root)), \
                    mock.patch.object(charts, 'build_announcements', side_effect=announcement), \
                    mock.patch.object(charts, '_chart_object', side_effect=candle):
                self.assertEqual(charts.main(), 0)
            before = (root / 'chart_artifacts/index.json').read_bytes()
            with mock.patch.object(charts, 'BASE_DIR', str(root)), \
                    mock.patch.object(charts, 'build_announcements', side_effect=RuntimeError('announcement failed')):
                with self.assertRaisesRegex(RuntimeError, 'announcement failed'):
                    charts.main()
            self.assertEqual((root / 'chart_artifacts/index.json').read_bytes(), before)

    def test_eod2_parses_current_segment_once_and_reapplies_changed_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); data = root / 'source'; (data / 'daily').mkdir(parents=True)
            mapping = {'sym2isin': {'A': 'ISIN'}, 'isin2hist': {'ISIN': [
                {'symbol': 'A', 'from_date': '2020-01-01', 'to_date': '2026-10-06'}]}}
            (data / 'isin_symbol_map.json').write_text(json.dumps(mapping))
            (data / 'daily/a.csv').write_text('Date,Open,High,Low,Close,Volume,DLV_QTY\n2026-10-06,10,11,9,10,100,50\n')
            destination = root / 'ohlcv'; destination.mkdir()
            (destination / 'A.csv').write_text('Date,Open,High,Low,Close,Volume\n2026-10-06,20,21,19,20,100\n2026-10-07,30,31,29,30,200\n')
            master = [{'Symbol': 'A', 'ISIN': 'ISIN'}]
            with mock.patch.object(eod2, 'source_rows', wraps=eod2.source_rows) as read:
                first = eod2.import_eod2_ohlcv(data, master, destination)
                self.assertEqual(read.call_count, 1)
            expected = (destination / 'A.csv').read_bytes()
            with mock.patch.object(Path, 'write_bytes', side_effect=AssertionError('unchanged rewrite')):
                self.assertEqual(eod2.import_eod2_ohlcv(data, master, destination), first)
            (destination / 'A.csv').write_bytes(expected.replace(b'10.0', b'99.0'))
            self.assertEqual(eod2.import_eod2_ohlcv(data, master, destination), first)
            self.assertEqual((destination / 'A.csv').read_bytes(), expected)
            rows = list(csv.DictReader(io.StringIO(expected.decode())))
            self.assertEqual([r['Date'] for r in rows], ['2026-10-06', '2026-10-07'])
            self.assertEqual(rows[0]['Close'], '10.0')
            self.assertEqual(rows[1]['Close'], '30')


if __name__ == '__main__':
    unittest.main()
