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

    def test_independent_chain_starts_on_first_free_worker_with_three_worker_cap(self):
        first_three = threading.Barrier(3)
        independent_started = threading.Event()
        lock = threading.Lock()
        active = 0
        peak = 0
        def run(script, phase_label='', required=False):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            try:
                if script == 'independent':
                    independent_started.set()
                else:
                    first_three.wait(timeout=5)
                    if script != 'enrichment':
                        self.assertTrue(independent_started.wait(timeout=5))
                return ScriptResult(True, required)
            finally:
                with lock:
                    active -= 1
        groups = {name: [(name, '', False)] for name in
                  ('enrichment', 'ohlcv', 'reference', 'independent')}
        with mock.patch('edl_pipeline.runner.run_script', side_effect=run):
            results = run_script_lanes(groups)
        self.assertEqual(peak, 3)
        self.assertEqual(list(results), list(groups))
        self.assertTrue(all(result.ok for lane in results.values() for result in lane.values()))

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
        self.assertLess(calls.index('fetch_nse_delivery_data.py'), calls.index('filter_mainboard_universe.py'))

    def test_completed_session_failure_stops_before_universe_filter(self):
        def result(script, phase_label='', required=False):
            return ScriptResult(script != 'fetch_nse_delivery_data.py', required)
        with mock.patch('edl_pipeline.runner.run_script', side_effect=result) as run, \
                mock.patch('edl_pipeline.runner.download_nse_listing_dates', return_value=True), \
                mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(PipelineConfig()), 1)
        self.assertNotIn('filter_mainboard_universe.py', [call.args[0] for call in run.call_args_list])
        self.assertTrue(run.call_args.kwargs['required'])

    def test_invalid_quotes_stop_before_enrichment_and_classification(self):
        def result(script, phase_label='', required=False):
            return ScriptResult(script != 'validate_market_quotes.py', required)
        with mock.patch('edl_pipeline.runner.run_script', side_effect=result) as run, \
                mock.patch('edl_pipeline.runner.download_nse_listing_dates', return_value=True), \
                mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(PipelineConfig()), 1)
        scripts = [call.args[0] for call in run.call_args_list]
        self.assertLess(scripts.index('filter_mainboard_universe.py'), scripts.index('validate_market_quotes.py'))
        for script in ('fetch_fundamental_data.py', 'fetch_company_filings.py',
                       'bulk_market_analyzer.py', 'build_filing_history_artifact.py', 'build_chart_artifacts.py'):
            self.assertNotIn(script, scripts)
        self.assertTrue(run.call_args.kwargs['required'])

    def test_rebalanced_lanes_keep_filings_separate_and_fetches_unique(self):
        captured = {}
        def lanes(groups):
            captured.update(groups)
            return {name: {script: ScriptResult(script != 'fetch_all_ohlcv.py', required)
                          for script, _, required in scripts} for name, scripts in groups.items()}
        with mock.patch('edl_pipeline.runner.run_script', return_value=ScriptResult(True, True)), \
                mock.patch('edl_pipeline.runner.run_script_lanes', side_effect=lanes), \
                mock.patch('edl_pipeline.runner.download_nse_listing_dates', return_value=True), \
                mock.patch('edl_pipeline.runner.save_json'), mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(PipelineConfig()), 1)
        self.assertEqual([script for script, _, _ in captured['enrichment']], ['fetch_company_filings.py'])
        expected = set(PHASE2_SCRIPTS) | set(OHLCV_FETCH_LANE) | {
            'fetch_ipo_provider_data.py', 'fetch_scanx_ipo_data.py'}
        seen = [script for scripts in captured.values() for script, _, _ in scripts]
        self.assertEqual(set(seen), expected)
        self.assertEqual(len(seen), len(expected))
        self.assertEqual(len(captured), 4)
        self.assertEqual([script for script, _, _ in captured['reference']],
                         ['fetch_ipo_provider_data.py', 'fetch_scanx_ipo_data.py'])
        self.assertEqual([script for script, _, _ in captured['independent']],
                         [script for script in PHASE2_SCRIPTS if script != 'fetch_company_filings.py'])

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

    def test_reference_overlaps_enrichment_but_does_not_delay_base_failure(self):
        for fail_base, fail_reference in ((False, False), (True, False), (False, True)):
            started = threading.Event()
            release = threading.Event()
            reported = []
            calls = []
            def run(script, phase_label='', required=False):
                calls.append(script)
                if script == 'refresh_official_index_constituents.py':
                    self.assertFalse(required)
                    started.set()
                    self.assertTrue(release.wait(timeout=5))
                    return ScriptResult(not fail_reference, required)
                if script == 'bulk_market_analyzer.py':
                    self.assertFalse(started.is_set())
                    if fail_base:
                        return ScriptResult(False, required)
                if script == PHASE4_SCRIPTS[0]:
                    self.assertTrue(started.wait(timeout=5))
                    self.assertFalse(release.is_set())
                if script == 'build_chart_artifacts.py':
                    release.set()
                return ScriptResult(True, required)
            with self.subTest(fail_base=fail_base, fail_reference=fail_reference), \
                    tempfile.TemporaryDirectory() as directory, \
                    mock.patch('edl_pipeline.runner.BASE_DIR', directory), \
                    mock.patch('edl_pipeline.runner.run_script', side_effect=run), \
                    mock.patch('edl_pipeline.runner.download_nse_listing_dates', return_value=True), \
                    mock.patch('edl_pipeline.runner.compress_output', return_value=(100, 10)), \
                    mock.patch('edl_pipeline.runner.validate_final_artifacts', return_value=[]), \
                    mock.patch('edl_pipeline.runner.write_pipeline_report', side_effect=reported.append), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(PipelineConfig(cleanup_intermediate=False)), int(fail_base))
            if fail_base:
                self.assertNotIn('refresh_official_index_constituents.py', calls)
                self.assertNotIn('refresh_official_index_constituents.py', reported[-1]['scripts'])
                self.assertNotIn(PHASE4_SCRIPTS[0], calls)
            else:
                self.assertEqual(calls.count('refresh_official_index_constituents.py'), 1)
                result = reported[-1]['scripts']['refresh_official_index_constituents.py']
                self.assertEqual(result['ok'], not fail_reference)
                self.assertFalse(result['required'])
                positions = [calls.index(script) for script in PHASE4_SCRIPTS if script != OHLCV_DERIVED_SCRIPT]
                self.assertEqual(positions, sorted(positions))

    def test_independent_builds_overlap_without_racing_consumers_or_skipping_failure(self):
        for fail_filing in (False, True):
            filing_started, breadth_started = threading.Event(), threading.Event()
            release_filing, release_breadth = threading.Event(), threading.Event()
            filing_done, breadth_done = threading.Event(), threading.Event()
            calls = []
            def run(script, phase_label='', required=False):
                calls.append(script)
                if script == 'build_filing_history_artifact.py':
                    filing_started.set()
                    self.assertTrue(release_filing.wait(5))
                    filing_done.set()
                    return ScriptResult(not fail_filing, required)
                if script == OHLCV_DERIVED_SCRIPT:
                    breadth_started.set()
                    self.assertTrue(release_breadth.wait(5))
                    breadth_done.set()
                if script == PHASE4_SCRIPTS[0]:
                    self.assertTrue(filing_started.wait(5))
                    self.assertTrue(breadth_started.wait(5))
                    self.assertFalse(filing_done.is_set())
                    self.assertFalse(breadth_done.is_set())
                if script == 'process_historical_market_breadth.py':
                    release_breadth.set()
                if script == 'standardize_stock_artifact.py':
                    release_filing.set()
                if script == 'build_rs_ratings.py':
                    self.assertTrue(breadth_done.is_set())
                if script == 'build_chart_artifacts.py':
                    self.assertTrue(filing_done.is_set())
                return ScriptResult(True, required)
            config = PipelineConfig(cleanup_intermediate=False)
            checkpoint = {'config': {'fetch_ohlcv': True, 'fetch_optional': False, 'cleanup_intermediate': False},
                          'exit_code': 0, 'total_time_seconds': 0, 'scripts': {}}
            with self.subTest(fail_filing=fail_filing), \
                    mock.patch('edl_pipeline.runner.pipeline_utils.load_json', return_value=checkpoint), \
                    mock.patch('edl_pipeline.runner.run_script', side_effect=run), \
                    mock.patch('edl_pipeline.runner.compress_output', return_value=(100, 10)) as compress, \
                    mock.patch('edl_pipeline.runner.validate_final_artifacts', return_value=[]), \
                    mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(config, phase='build'), int(fail_filing))
            self.assertEqual(calls.count(OHLCV_DERIVED_SCRIPT), 1)
            self.assertEqual(calls.count('build_filing_history_artifact.py'), 1)
            if fail_filing:
                compress.assert_not_called()

    def test_old_fetch_checkpoint_does_not_repeat_completed_reference(self):
        config = PipelineConfig(cleanup_intermediate=False)
        reference = 'refresh_official_index_constituents.py'
        checkpoint = {'config': {'fetch_ohlcv': True, 'fetch_optional': False, 'cleanup_intermediate': False},
                      'exit_code': 0, 'total_time_seconds': 1,
                      'scripts': {reference: ScriptResult(True, False).to_dict()}}
        with mock.patch('edl_pipeline.runner.pipeline_utils.load_json', return_value=checkpoint), \
                mock.patch('edl_pipeline.runner.run_script', return_value=ScriptResult(True, True)) as run, \
                mock.patch('edl_pipeline.runner.compress_output', return_value=(100, 10)), \
                mock.patch('edl_pipeline.runner.validate_final_artifacts', return_value=[]), \
                mock.patch('edl_pipeline.runner.write_pipeline_report'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(config, phase='build'), 0)
        self.assertNotIn(reference, [call.args[0] for call in run.call_args_list])

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
            'independent': {},
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
