import contextlib
import io
import sys
import threading
import tempfile
from collections import Counter
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edl_pipeline.config import PipelineConfig
from edl_pipeline.artifacts import (
    OHLCV_DERIVED_SCRIPT,
    OHLCV_FETCH_LANE,
    PHASE2_SCRIPTS,
    PHASE4_SCRIPTS,
    SCRIPT_OUTPUT_SPECS,
)
from edl_pipeline.runner import (
    ScriptResult,
    build_pipeline_report,
    main,
    run_script,
    run_script_lanes,
)
from edl_pipeline.validators import ArtifactCheck


class RunnerTests(unittest.TestCase):
    def test_standardizer_is_last_enrichment_stage_with_matching_contracts(self):
        self.assertEqual(PHASE4_SCRIPTS[-1], "standardize_stock_artifact.py")
        self.assertLess(PHASE4_SCRIPTS.index(OHLCV_DERIVED_SCRIPT), PHASE4_SCRIPTS.index("build_rs_ratings.py"))
        self.assertLess(PHASE4_SCRIPTS.index("build_shareholding_history.py"), PHASE4_SCRIPTS.index("standardize_stock_artifact.py"))
        self.assertEqual(
            SCRIPT_OUTPUT_SPECS["add_corporate_events.py"][0].required_fields,
            ("Event Markers", "Recent Announcements", "News Feed"),
        )
        self.assertIn(
            "schema_version",
            SCRIPT_OUTPUT_SPECS["standardize_stock_artifact.py"][0].required_fields,
        )

    def test_main_returns_nonzero_when_foundation_stage_fails(self):
        with mock.patch("edl_pipeline.runner.run_script", return_value=ScriptResult(False, True)):
            with mock.patch("edl_pipeline.runner.write_pipeline_report"):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(PipelineConfig(fetch_ohlcv=False, fetch_optional=False, cleanup_intermediate=False)), 1)

    def test_listing_download_failure_stops_before_universe_filter(self):
        with mock.patch('edl_pipeline.runner.run_script', return_value=ScriptResult(True, True)) as run, \
                mock.patch('edl_pipeline.runner.download_nse_listing_dates', return_value=False), \
                mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(PipelineConfig()), 1)
        self.assertNotIn('filter_mainboard_universe.py', [call.args[0] for call in run.call_args_list])

    def test_main_respects_ohlcv_and_optional_flags(self):
        calls = []

        def fake_run_script(script, phase_label="", required=False):
            calls.append(script)
            return ScriptResult(True, required)

        with mock.patch("edl_pipeline.runner.run_script", side_effect=fake_run_script):
            with mock.patch("edl_pipeline.runner.download_nse_listing_dates", return_value=True):
                with mock.patch("edl_pipeline.runner.compress_output", return_value=(100, 10)):
                    with mock.patch("edl_pipeline.runner.validate_final_artifacts", return_value=[]):
                        with mock.patch("edl_pipeline.runner.write_pipeline_report"):
                            with contextlib.redirect_stdout(io.StringIO()):
                                code = main(PipelineConfig(fetch_ohlcv=False, fetch_optional=False, cleanup_intermediate=False))

        self.assertEqual(code, 0)
        self.assertNotIn("fetch_all_ohlcv.py", calls)
        self.assertNotIn("fetch_indices_ohlcv.py", calls)
        self.assertNotIn("fetch_etf_data.py", calls)
        self.assertIn("refresh_official_index_constituents.py", calls)
        self.assertIn("bulk_market_analyzer.py", calls)

    def test_missing_completed_session_stops_before_universe_consumers(self):
        def run(script, phase_label='', required=False):
            return ScriptResult(script != 'fetch_nse_delivery_data.py', required)
        with mock.patch('edl_pipeline.runner.run_script', side_effect=run) as scripts, \
                mock.patch('edl_pipeline.runner.download_nse_listing_dates', return_value=True), \
                mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(PipelineConfig()), 1)
        called = [call.args[0] for call in scripts.call_args_list]
        self.assertNotIn('filter_mainboard_universe.py', called)
        self.assertNotIn('fetch_all_ohlcv.py', called)
        self.assertTrue(scripts.call_args_list[-1].kwargs['required'])

    def test_fetch_lanes_overlap_but_keep_each_lane_ordered(self):
        barrier = threading.Barrier(2)
        completed = []

        def fake_run_script(script, phase_label="", required=False):
            if script.endswith("-first.py"):
                barrier.wait(timeout=2)
            completed.append(script)
            return ScriptResult(True, required)

        lanes = {
            "one": [("one-first.py", "one", False), ("one-second.py", "one", False)],
            "two": [("two-first.py", "two", False), ("two-second.py", "two", False)],
        }
        with mock.patch("edl_pipeline.runner.run_script", side_effect=fake_run_script):
            results = run_script_lanes(lanes)

        self.assertEqual(list(results), ["one", "two"])
        self.assertLess(completed.index("one-first.py"), completed.index("one-second.py"))
        self.assertLess(completed.index("two-first.py"), completed.index("two-second.py"))

    def test_ohlcv_run_executes_each_fetch_once_with_safe_dependencies(self):
        calls = []

        def fake_run_script(script, phase_label="", required=False):
            calls.append(script)
            return ScriptResult(True, required)

        with mock.patch("edl_pipeline.runner.run_script", side_effect=fake_run_script):
            with mock.patch("edl_pipeline.runner.download_nse_listing_dates", return_value=True):
                with mock.patch("edl_pipeline.runner.compress_output", return_value=(100, 10)):
                    with mock.patch("edl_pipeline.runner.validate_final_artifacts", return_value=[]):
                        with mock.patch("edl_pipeline.runner.write_pipeline_report"):
                            with contextlib.redirect_stdout(io.StringIO()):
                                code = main(
                                    PipelineConfig(
                                        fetch_ohlcv=True,
                                        fetch_optional=False,
                                        cleanup_intermediate=False,
                                    )
                                )

        self.assertEqual(code, 0)
        expected_fetches = set(PHASE2_SCRIPTS) | set(OHLCV_FETCH_LANE) | {"fetch_indices_ohlcv.py", "fetch_nse_delivery_data.py"}
        for script in expected_fetches:
            self.assertEqual(calls.count(script), 1, script)
        self.assertLess(calls.index('fetch_nse_delivery_data.py'), calls.index('filter_mainboard_universe.py'))
        self.assertLess(calls.index('filter_mainboard_universe.py'), calls.index('fetch_fundamental_data.py'))
        lane_positions = [calls.index(script) for script in OHLCV_FETCH_LANE]
        self.assertEqual(lane_positions, sorted(lane_positions))
        self.assertGreater(calls.index("fetch_indices_ohlcv.py"), calls.index("fetch_all_indices.py"))
        self.assertGreater(calls.index("fetch_indices_ohlcv.py"), calls.index("fetch_all_ohlcv.py"))

    def test_no_ohlcv_fetches_session_once_before_filter_and_stops_if_it_fails(self):
        for succeeds in (True, False):
            calls = []
            def run(script, phase_label='', required=False):
                calls.append(script)
                if script == 'fetch_nse_delivery_data.py':
                    self.assertTrue(required)
                return ScriptResult(succeeds or script != 'fetch_nse_delivery_data.py', required)
            with self.subTest(succeeds=succeeds), tempfile.TemporaryDirectory() as directory, \
                    mock.patch('edl_pipeline.runner.BASE_DIR', directory), \
                    mock.patch('edl_pipeline.runner.run_script', side_effect=run), \
                    mock.patch('edl_pipeline.runner.download_nse_listing_dates', return_value=True), \
                    mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(PipelineConfig(fetch_ohlcv=False), phase='fetch'), int(not succeeds))
            self.assertEqual(calls.count('fetch_nse_delivery_data.py'), 1)
            if succeeds:
                self.assertLess(calls.index('fetch_nse_delivery_data.py'), calls.index('filter_mainboard_universe.py'))
            else:
                self.assertNotIn('filter_mainboard_universe.py', calls)

    def test_split_refresh_executes_the_same_scripts_once_and_resumes_checks(self):
        calls = []
        def run(script, phase_label='', required=False):
            calls.append(script)
            return ScriptResult(True, required, validations=[ArtifactCheck('fixture', 'json', True)])
        config = PipelineConfig(cleanup_intermediate=False)
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch('edl_pipeline.runner.BASE_DIR', directory), \
                mock.patch('edl_pipeline.runner.run_script', side_effect=run), \
                mock.patch('edl_pipeline.runner.download_nse_listing_dates'), \
                mock.patch('edl_pipeline.runner.compress_output', return_value=(100, 10)), \
                mock.patch('edl_pipeline.runner.validate_final_artifacts', return_value=[]), \
                mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(config), 0)
            expected = Counter(calls)
            calls.clear()
            self.assertEqual(main(config, phase='fetch'), 0)
            self.assertNotIn('bulk_market_analyzer.py', calls)
            self.assertTrue((Path(directory) / 'fetch_checkpoint.json').exists())
            self.assertEqual(main(config, phase='build'), 0)
            self.assertEqual(Counter(calls), expected)
            self.assertTrue(all(count == 1 for count in expected.values()))

    def test_build_rejects_failed_fetch_checkpoint(self):
        with mock.patch('edl_pipeline.runner.pipeline_utils.load_json', return_value={
                'config': {'fetch_ohlcv': True, 'fetch_optional': False, 'cleanup_intermediate': True},
                'exit_code': 1}), mock.patch('edl_pipeline.runner.run_script') as run:
            with self.assertRaises(ValueError):
                main(PipelineConfig(fetch_ohlcv=True, fetch_optional=False, cleanup_intermediate=True), phase='build')
            run.assert_not_called()

    def test_build_rejects_missing_or_malformed_checkpoint_clearly(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch('edl_pipeline.runner.BASE_DIR', directory):
            for content in (None, '{broken', '[]'):
                path = Path(directory) / 'fetch_checkpoint.json'
                if content is not None:
                    path.write_text(content)
                with self.assertRaisesRegex(ValueError, 'Cannot build from a missing'):
                    main(PipelineConfig(), phase='build')

    def test_required_fetch_failure_stops_before_index_and_build(self):
        failed = ScriptResult(False, True, error='missing sessions')
        lanes = {
            'enrichment': {'fetch_company_filings.py': ScriptResult(True, True)},
            'ohlcv': {'fetch_all_ohlcv.py': failed},
            'reference': {},
        }
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch('edl_pipeline.runner.BASE_DIR', directory), \
                mock.patch('edl_pipeline.runner.run_script_lanes', return_value=lanes), \
                mock.patch('edl_pipeline.runner.run_script', return_value=ScriptResult(True, True)) as run, \
                mock.patch('edl_pipeline.runner.download_nse_listing_dates'), \
                mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(PipelineConfig(cleanup_intermediate=False)), 1)
        self.assertNotIn('fetch_indices_ohlcv.py', [call.args[0] for call in run.call_args_list])
        self.assertNotIn('bulk_market_analyzer.py', [call.args[0] for call in run.call_args_list])

    def test_required_output_validation_failure_marks_script_failed(self):
        completed = mock.Mock(returncode=0)
        failed_check = ArtifactCheck("required.json", "json", False, "missing")

        with mock.patch("edl_pipeline.runner.os.path.exists", return_value=True):
            with mock.patch("edl_pipeline.runner.subprocess.run", return_value=completed):
                with mock.patch("edl_pipeline.runner.validate_script_outputs", return_value=[failed_check]):
                    with contextlib.redirect_stdout(io.StringIO()):
                        result = run_script("required.py", required=True)

        self.assertFalse(result.ok)
        self.assertEqual(result.error, "validation")
        self.assertEqual(result.validations, [failed_check])

    def test_optional_output_validation_failure_stays_warning(self):
        completed = mock.Mock(returncode=0)
        failed_check = ArtifactCheck("optional.json", "json", False, "missing")

        with mock.patch("edl_pipeline.runner.os.path.exists", return_value=True):
            with mock.patch("edl_pipeline.runner.subprocess.run", return_value=completed):
                with mock.patch("edl_pipeline.runner.validate_script_outputs", return_value=[failed_check]):
                    with contextlib.redirect_stdout(io.StringIO()):
                        result = run_script("optional.py", required=False)

        self.assertTrue(result.ok)
        self.assertEqual(result.validations, [failed_check])

    def test_pipeline_report_serializes_script_and_final_checks(self):
        check = ArtifactCheck("artifact.json.gz", "gzip_json", True, count=3)
        report = build_pipeline_report(
            {"script.py": ScriptResult(True, True, validations=[check])},
            total_time=1.23456,
            raw_size=100,
            gz_size=20,
            final_checks=[check],
            config=PipelineConfig(fetch_ohlcv=False, fetch_optional=True, cleanup_intermediate=False),
            exit_code=0,
        )

        self.assertEqual(report["total_time_seconds"], 1.235)
        self.assertEqual(report["base_dir"], ".")
        self.assertEqual(report["config"]["fetch_optional"], True)
        self.assertEqual(report["scripts"]["script.py"]["validations"][0]["path"], "artifact.json.gz")
        self.assertEqual(report["final_artifacts"][0]["count"], 3)


if __name__ == "__main__":
    unittest.main()
