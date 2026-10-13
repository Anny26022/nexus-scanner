"""Benchmark verification stays strict for diagnostic reports and Python -O."""
import ast
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import benchmark_critical_path as benchmark
from edl_pipeline.artifacts import OHLCV_FETCH_LANE, PHASE2_SCRIPTS, REQUIRED_PHASE2_SCRIPTS
from edl_pipeline import runner


class CriticalPathBenchmarkTests(unittest.TestCase):
    def report(self):
        reference = {'fetch_ipo_provider_data.py', 'fetch_scanx_ipo_data.py'}
        scripts = set(PHASE2_SCRIPTS) | set(OHLCV_FETCH_LANE) | reference
        required = set(OHLCV_FETCH_LANE) | set(REQUIRED_PHASE2_SCRIPTS) | reference
        return {'config': {'fetch_ohlcv': True},
                'scripts': {name: {'elapsed': 1., 'validation_elapsed': .1,
                                   'required': name in required, 'ok': True} for name in scripts}}

    def replay(self, data):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'report.json'
            path.write_text(json.dumps(data))
            with contextlib.redirect_stdout(io.StringIO()) as output:
                benchmark.fetch_schedule(path)
            return output.getvalue()

    def test_full_report_replays_without_live_work(self):
        self.assertIn('not a live measurement', self.replay(self.report()))

    def test_failed_required_fetches_rejected_before_durations_are_read(self):
        for name in ('fetch_all_ohlcv.py', 'fetch_ipo_provider_data.py', 'fetch_nse_corporate_actions.py'):
            with self.subTest(script=name):
                data = self.report()
                data['scripts'][name]['ok'] = False
                data['scripts'][name].pop('elapsed')
                with self.assertRaisesRegex(SystemExit, 'failed required fetch scripts: ' + name):
                    self.replay(data)

    def test_missing_required_success_status_is_not_treated_as_success(self):
        data = self.report()
        data['scripts']['fetch_all_ohlcv.py'].pop('ok')
        with self.assertRaisesRegex(SystemExit, 'failed required fetch scripts: fetch_all_ohlcv.py'):
            self.replay(data)

    def test_optional_fetch_failure_remains_replayable(self):
        data = self.report()
        data['scripts']['fetch_company_filings.py']['ok'] = False
        self.assertIn('not a live measurement', self.replay(data))

    def test_model_checks_lane_order_not_only_mapping_equality(self):
        def reordered(lanes):
            return {lane: {name: None for name, _, _ in scripts}
                    for lane, scripts in reversed(list(lanes.items()))}
        with mock.patch.object(runner, 'run_script_lanes', side_effect=reordered):
            with self.assertRaisesRegex(SystemExit, 'Fetch lane order mismatch'):
                self.replay(self.report())

    def test_diagnostic_and_incomplete_reports_are_rejected_clearly(self):
        diagnostic = self.report()
        diagnostic['config']['fetch_ohlcv'] = False
        for name in OHLCV_FETCH_LANE:
            diagnostic['scripts'].pop(name)
        incomplete = self.report()
        incomplete['scripts'].pop('fetch_ipo_provider_data.py')
        for data in (diagnostic, incomplete):
            with self.subTest(config=data['config']):
                with self.assertRaisesRegex(SystemExit, 'requires a completed full OHLCV fetch report'):
                    self.replay(data)

    def test_optimized_cli_rejects_diagnostic_report_without_success_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'report.json'
            path.write_text(json.dumps({'config': {'fetch_ohlcv': False}, 'scripts': {}}))
            # -S removes site-packages: a diagnostic must be rejected without
            # importing requests/pandas or reading benchmark data artifacts.
            result = subprocess.run([sys.executable, '-O', '-S', str(Path(benchmark.__file__)), '--run-report', str(path)],
                                    capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires a completed full OHLCV fetch report', result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertNotIn('All compared records', result.stdout)

    def test_equivalence_gate_survives_optimized_python(self):
        for values in ("{'a': None}, {'a': 0}", "b'expected', b'changed'"):
            result = subprocess.run([sys.executable, '-O', '-c',
                                     'from tools.benchmark_critical_path import require_equal; '
                                     f'require_equal({values}, "test equivalence")'],
                                    cwd=benchmark.ROOT, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('test equivalence mismatch', result.stderr)
        self.assertIsNone(benchmark.require_equal({'a': None}, {'a': None}, 'matching'))

    def test_benchmark_contains_no_strippable_assertions(self):
        tree = ast.parse(Path(benchmark.__file__).read_text())
        self.assertFalse(any(isinstance(node, ast.Assert) for node in ast.walk(tree)))


if __name__ == '__main__':
    unittest.main()
