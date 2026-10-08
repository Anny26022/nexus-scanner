"""Runtime optimizations must preserve bytes, counts and atomic publication."""

import copy
import math
import runpy
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'src') not in sys.path:
    sys.path.insert(0, str(ROOT / 'src'))

from pipeline_utils import save_json, save_json_records
import pipeline_utils
import build_filing_history_artifact as filings_builder
from filing_classification import classify_filings, RULES, _rule_matches, _cached_rule_matches
from edl_pipeline.breadth.aggregates import BreadthAccumulator
from edl_pipeline.breadth.config import BreadthMethodology
from edl_pipeline.breadth.indicators import prepare_history
from test_breadth_v2 import make_ohlcv


class RefreshRuntimeTests(unittest.TestCase):
    def test_benchmark_full_serializer_fixture_and_explicit_cap(self):
        benchmark = runpy.run_path(str(ROOT.parent / 'tools/benchmark_refresh_runtime.py'))
        # Fixture-sizing coverage must also run in shallow CI checkouts;
        # baseline Git/source equivalence is checked by the CLI itself.
        benchmark['benchmark_filings'].__globals__['baseline_module'] = lambda *args: filings_builder
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'filings.json'
            save_json(path, {'symbols': {f'SYM{i:03d}': {'filings': []} for i in range(81)}})
            full = benchmark['benchmark_filings'](path, 0)
            capped = benchmark['benchmark_filings'](path, 0, 2)
            self.assertEqual(full['serialization']['fixture_symbols'], 81)
            self.assertEqual(capped['serialization']['fixture_symbols'], 2)
            self.assertGreater(full['serialization']['bytes'], capped['serialization']['bytes'])

    def test_rule_memoization_preserves_order_and_bounds_memory(self):
        _cached_rule_matches.cache_clear()
        texts = ('', 'financial results dividend approved',
                 'not approved tax court order acquisition', 'a' * 4097)
        for text in texts:
            expected = tuple(key for key, _, _, rx in RULES if rx.search(text))
            self.assertEqual(_rule_matches(text), expected)
            self.assertEqual(_rule_matches(text), expected)
        self.assertEqual(_cached_rule_matches.cache_info().currsize, 3)
        for i in range(3000):
            _rule_matches(f'new disclosure {i}')
        self.assertEqual(_cached_rule_matches.cache_info().currsize, 2048)
        _cached_rule_matches.cache_clear()

    def test_streamed_records_are_byte_identical(self):
        cases = [
            {}, {'records': []}, {'records': [None, False, 0, -0.0]},
            {'before': '₹ café \n " \\', 'records': [
                {'symbol': 'α', 'values': [math.nan, math.inf, -math.inf, 1e200],
                 'tuple': (None, True, {'missing': math.nan})},
                {'nested': [{'caption': 'Dividend 😃', 'return': 0.000001}]}],
             'after': {'count': 2}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            before, after = (Path(directory) / name for name in ('before.json', 'after.json'))
            for data in cases:
                for ascii_only in (True, False):
                    with self.subTest(data=data, ensure_ascii=ascii_only):
                        frozen = copy.deepcopy(data)
                        save_json(before, data, ensure_ascii=ascii_only)
                        save_json_records(after, data, ensure_ascii=ascii_only)
                        self.assertEqual(after.read_bytes(), before.read_bytes())
                        self.assertEqual(repr(data), repr(frozen))

    def test_streaming_failure_keeps_previous_artifact_and_cleans_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'artifact.json'
            save_json(path, {'records': ['previous']})
            previous = path.read_bytes()
            for failure in ('encode', 'replace', 'write'):
                with self.subTest(failure=failure):
                    if failure == 'encode':
                        context = mock.patch('pipeline_utils.json.dumps', side_effect=TypeError('bad record'))
                    elif failure == 'replace':
                        context = mock.patch.object(Path, 'replace', side_effect=OSError('disk full'))
                    else:
                        create = pipeline_utils.NamedTemporaryFile
                        def failed_write(*args, **kwargs):
                            handle = create(*args, **kwargs)
                            handle.write = mock.Mock(side_effect=OSError('disk full'))
                            return handle
                        context = mock.patch('pipeline_utils.NamedTemporaryFile', side_effect=failed_write)
                    with context, self.assertRaises((TypeError, OSError)):
                        save_json_records(path, {'records': ['new']})
                    self.assertEqual(path.read_bytes(), previous)
                    self.assertEqual(list(Path(directory).iterdir()), [path])
            # Fail after valid records have already been written, not only at the header.
            with self.assertRaises(TypeError):
                save_json_records(path, {'records': ['valid', object()]})
            self.assertEqual(path.read_bytes(), previous)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_cold_classification_reuses_text_without_merging_observations(self):
        rows = [{'caption': 'Dividend approved', 'news_date': f'2026-09-{day:02d}',
                 'news_id': str(day), 'file_url': f'https://example.com/{day}.pdf'}
                for day in range(1, 10)]
        expected = classify_filings(copy.deepcopy(rows))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'classification.json'
            with mock.patch.object(filings_builder, 'classify_filing',
                                   wraps=filings_builder.classify_filing) as classify:
                observed = filings_builder.classify_cached(copy.deepcopy(rows), path, ['rules'])
                self.assertEqual(observed, expected)
                self.assertEqual(len({row['filingId'] for row in observed}), len(rows))
                self.assertEqual(classify.call_count, 1)
                classify.reset_mock()
                self.assertEqual(filings_builder.classify_cached(copy.deepcopy(rows), path, ['rules']), expected)
                classify.assert_not_called()
                revised = copy.deepcopy(rows)
                revised[0]['news_body'] = 'The dividend is not approved.'
                self.assertEqual(filings_builder.classify_cached(revised, path, ['rules']),
                                 classify_filings(copy.deepcopy(revised)))
                self.assertEqual(classify.call_count, 1)

    def test_breadth_fanout_matches_separate_updates_with_different_membership(self):
        for limit in (0, 2, 250):
            method = replace(BreadthMethodology(), output_sessions=limit)
            before = [BreadthAccumulator(method, include_contributions=(i != 3)) for i in range(4)]
            after = [BreadthAccumulator(method, include_contributions=(i != 3)) for i in range(4)]
            # Out-of-order symbol date ranges, short IPOs, zero and missing volumes,
            # ties, exact threshold returns, and float sums sensitive to regrouping.
            for index, (symbol, start, closes, members) in enumerate([
                ('A', '2024-01-01', [100 + i % 17 for i in range(400)], [0, 1, 3]),
                ('B', '2025-01-01', [100, 104, 99.84, 99.84], [0, 2, 3]),
                ('C', '2023-01-01', [100 + i % 5 for i in range(40)], [0, 1, 2]),
                (None, '2026-01-01', [100, 100, 95.5, 99.7975], [0, 3]),
            ]):
                raw = make_ohlcv(closes, start)
                raw['Volume'] = [([1e16, 0, math.nan, 0.1][(i + index) % 4]) for i in range(len(raw))]
                history = prepare_history(raw, method)
                for i in members:
                    before[i].update(history, symbol)
                after[members[0]].update(history, symbol, peers=[after[i] for i in members[1:]])
            for old, new in zip(before, after):
                self.assertEqual(old.records(), new.records())
                self.assertEqual(old.contribution_records(), new.contribution_records())

    def test_fanout_rejects_duplicate_targets_or_different_formulas_before_mutation(self):
        method = BreadthMethodology()
        first = BreadthAccumulator(method)
        other = BreadthAccumulator(replace(method, advance_threshold=5))
        history = prepare_history(make_ohlcv([100, 110]), method)
        for peers in ([first], [other], [other, other], iter([other])):
            with self.assertRaises(ValueError):
                first.update(history, 'A', peers=peers)
        self.assertEqual(first.records(), [])
        self.assertEqual(other.records(), [])


if __name__ == '__main__':
    unittest.main()
