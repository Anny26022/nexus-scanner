import contextlib
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import subprocess
import unittest
from unittest import mock

import prune_actions_caches as retention


NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
MAIN = 'refs/heads/main'


def cache(identifier, key, days=3, ref=MAIN, version='v1', reused=False):
    created = NOW - timedelta(days=days)
    return {'id': identifier, 'key': key, 'ref': ref, 'version': version,
            'created_at': created.isoformat(),
            'last_accessed_at': (NOW - timedelta(hours=1) if reused else created).isoformat(),
            'size_in_bytes': 100}


def selected(caches, closed=()):
    return {c['id'] for c in retention.deletion_candidates(caches, MAIN, set(closed), NOW)}


class CacheRetentionTests(unittest.TestCase):
    def test_prices_keep_two_per_format_and_protect_recent_entries(self):
        caches = [cache(i, f'scanner-prices-v1-Linux-{i}-1-fetch', days=6-i) for i in range(1, 5)]
        caches += [cache(5, 'scanner-prices-v1-Linux-5-1-fetch', days=0),
                   cache(6, 'scanner-prices-v1-Linux-6-1-fetch', version='different-format'),
                   cache(7, 'scanner-prices-v1-Linux-7-1-fetch', ref='refs/heads/feature'),
                   cache(8, 'node-cache-Linux-lockfile')]
        self.assertEqual(selected(caches), {1, 2, 3})

    def test_enrichment_keeps_two_builds_and_latest_newer_fetch(self):
        caches = [cache(1, 'scanner-enrichment-v1-Linux-1-1-build', days=7),
                  cache(2, 'scanner-enrichment-v1-Linux-2-1-build', days=6),
                  cache(3, 'scanner-enrichment-v1-Linux-3-1-build', days=5),
                  cache(4, 'scanner-enrichment-v1-Linux-4-1-fetch', days=4),
                  cache(5, 'scanner-enrichment-v1-Linux-5-1-fetch', days=3)]
        self.assertEqual(selected(caches), {1, 4})
        caches.append(cache(6, 'scanner-enrichment-v1-Linux-6-1-build', days=2))
        self.assertEqual(selected(caches), {1, 2, 4, 5})

    def test_fetch_only_history_keeps_two_and_handles_rerun_keys(self):
        caches = [cache(i, f'scanner-enrichment-v1-Linux-100-{i}-fetch', days=6-i)
                  for i in range(1, 4)]
        self.assertEqual(selected(caches), {1})

    def test_eod2_keeps_two_snapshots(self):
        caches = [cache(i, f'eod2-data-v1-Linux-2026-{38+i}', days=20-i*3)
                  for i in range(1, 4)]
        self.assertEqual(selected(caches), {1})

    def test_legacy_requires_recent_reuse_of_both_split_caches(self):
        legacy = cache(1, 'scanner-history-v1-Linux-100')
        prices = cache(2, 'scanner-prices-v1-Linux-200-1-fetch', reused=True)
        fetch = cache(3, 'scanner-enrichment-v1-Linux-200-1-fetch', reused=True)
        build = cache(4, 'scanner-enrichment-v1-Linux-200-1-build', reused=True)
        self.assertEqual(selected([legacy, prices, fetch]), set())
        self.assertEqual(selected([legacy, prices, build]), {1})
        build['last_accessed_at'] = build['created_at']
        self.assertEqual(selected([legacy, prices, build]), set())

    def test_closed_prs_only_and_grace_period(self):
        caches = [cache(1, 'node-cache-a', ref='refs/pull/12/merge'),
                  cache(2, 'node-cache-b', ref='refs/pull/13/merge'),
                  cache(3, 'pip-cache', ref='refs/pull/12/merge', days=0),
                  cache(4, 'node-cache-a', ref=MAIN)]
        self.assertEqual(selected(caches, closed=[12]), {1})

    def run_cli(self, delete=False, active_status=None, workflow='Daily Data Refresh',
                cache_count=3, failures=None, active_after=None):
        caches = [cache(i, f'scanner-prices-v1-Linux-{i}-1-fetch', days=6-i)
                  for i in range(1, cache_count + 1)]
        def api(repository, suffix):
            if not suffix:
                return [{'default_branch': 'main'}]
            if suffix.startswith('actions/caches'):
                return [{'actions_caches': caches[:2]}, {'actions_caches': caches[2:]}]
            status = 'in_progress' if active_after is not None and remove.call_count >= active_after else active_status
            return [{'workflow_runs': [{'name': workflow}] if f'status={status}&' in suffix else []}]
        argv = ['prune', '--repo', 'owner/repo'] + (['--delete'] if delete else [])
        with mock.patch('sys.argv', argv), mock.patch.object(retention, 'api', side_effect=api), \
                mock.patch.object(retention.subprocess, 'run', side_effect=failures) as remove, \
                mock.patch.object(retention, 'datetime', wraps=datetime) as clock, contextlib.redirect_stdout(io.StringIO()):
            clock.now.return_value = NOW
            retention.main()
            return remove.call_args_list

    def test_cli_dry_run_and_active_refresh_never_delete(self):
        self.assertEqual(self.run_cli(), [])
        for workflow in ('Daily Data Refresh', 'Weekly Adjusted OHLCV Refresh'):
            for status in ('in_progress', 'queued', 'waiting', 'pending', 'requested'):
                with self.subTest(workflow=workflow, status=status):
                    self.assertEqual(self.run_cli(delete=True, active_status=status, workflow=workflow), [])

    def test_cli_delete_targets_only_selected_id(self):
        calls = self.run_cli(delete=True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[0][-1], 'repos/owner/repo/actions/caches/1')
        self.assertEqual(calls[0].kwargs['timeout'], 60)

    def test_new_refresh_stops_remaining_deletions(self):
        for workflow in ('Daily Data Refresh', 'Weekly Adjusted OHLCV Refresh'):
            with self.subTest(workflow=workflow):
                calls = self.run_cli(delete=True, cache_count=4, workflow=workflow, active_after=1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0].args[0][-1], 'repos/owner/repo/actions/caches/1')

    def test_failed_or_timed_out_delete_does_not_abort_remaining_candidates(self):
        for error in (subprocess.CalledProcessError(1, ['gh']), subprocess.TimeoutExpired(['gh'], 60)):
            with self.subTest(error=type(error).__name__):
                calls = self.run_cli(delete=True, cache_count=4, failures=[error, None])
                self.assertEqual([call.args[0][-1] for call in calls],
                                 ['repos/owner/repo/actions/caches/1', 'repos/owner/repo/actions/caches/2'])

    def test_api_calls_are_bounded_and_fail_closed(self):
        with mock.patch.object(retention.subprocess, 'check_output', side_effect=subprocess.TimeoutExpired(['gh'], 60)) as api:
            with self.assertRaises(subprocess.TimeoutExpired):
                retention.api('owner/repo', 'actions/runs?status=in_progress')
            self.assertEqual(api.call_args.kwargs['timeout'], 60)

    def test_cleanup_and_refresh_workflows_share_concurrency_group(self):
        root = Path(__file__).resolve().parents[1] / '.github/workflows'
        for name in ('cache-retention.yml', 'daily_refresh.yml', 'weekly_eod2_refresh.yml'):
            with self.subTest(workflow=name):
                self.assertIn('  group: daily-data-refresh\n', (root / name).read_text())
                self.assertIn('  queue: max\n', (root / name).read_text())
                self.assertIn('  cancel-in-progress: false\n', (root / name).read_text())
