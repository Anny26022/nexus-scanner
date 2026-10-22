import gzip
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from session_history import archive_daily_snapshot, register_sessions, restore_evening_sessions


class SessionHistoryTests(unittest.TestCase):
    def snapshot(self, root, session, revision):
        manifest = {'sessionDate': session, 'revision': revision}
        folder = root / 'revisions' / revision
        folder.mkdir(parents=True, exist_ok=True)
        data = {'asOfDate': session, 'revision': revision, 'totalStocks': 1,
                'stocks': [{'symbol': 'TEST', 'close': 123}]}
        compressed = gzip.compress(json.dumps(data).encode(), mtime=0)
        (folder / 'stocks.json.gz').write_bytes(compressed)
        return manifest, compressed

    def test_rollover_and_same_session_correction_preserve_backfilled_sessions(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'EDL_CHART_STORAGE': 'local'}):
            root = Path(directory)
            path = root / 'sessions.json'
            old = {'date': '2026-10-16', 'revision': 'a' * 64, 'isHistorical': True}
            register_sessions(path, [old])
            for session, revision in [('2026-10-19', 'b' * 64), ('2026-10-21', 'c' * 64),
                                      ('2026-10-21', 'd' * 64)]:
                manifest, compressed = self.snapshot(root, session, revision)
                register_sessions(path, [archive_daily_snapshot(root, manifest)])
                self.assertEqual((root / f'snapshots/{session}.json.gz').read_bytes(), compressed)
            sessions = json.loads(path.read_text())['sessions']
            self.assertEqual([s['date'] for s in sessions], ['2026-10-21', '2026-10-19', '2026-10-16'])
            self.assertEqual(sessions[0]['revision'], 'd' * 64)
            self.assertEqual(sessions[-1], old)

    def test_r2_readback_must_match_before_session_is_returned(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'EDL_CHART_STORAGE': 'r2'}):
            root = Path(directory)
            manifest, compressed = self.snapshot(root, '2026-10-21', 'a' * 64)
            store = Mock()
            store.cache_command.return_value = b'corrupted'
            with patch('session_history.R2Store', return_value=store), patch('session_history.charts_enabled', return_value=True):
                with self.assertRaisesRegex(RuntimeError, 'read-back mismatch'):
                    archive_daily_snapshot(root, manifest)
                self.assertFalse((root / 'sessions.json').exists())
                store.cache_command.return_value = compressed
                self.assertEqual(archive_daily_snapshot(root, manifest)['revision'], 'a' * 64)
            manifest['sessionDate'] = '2026-10-22'
            with self.assertRaisesRegex(ValueError, 'revision/session mismatch'):
                archive_daily_snapshot(root, manifest)

    def test_recovery_selects_last_same_day_evening_daily_commit_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            output = repo / 'frontend/public/data'
            def git(*args, **kwargs):
                return subprocess.check_output(['git', '-C', str(repo), *args], **kwargs)
            git('init', '-q')
            git('config', 'user.name', 'Test')
            git('config', 'user.email', 'test@example.com')
            for revision, timestamp, message in [
                ('a' * 64, '2026-10-19T16:30:00+05:30', 'Automated Daily Data Refresh'),
                ('b' * 64, '2026-10-19T17:30:00+05:30', 'Automated Daily Data Refresh'),
                ('c' * 64, '2026-10-19T20:30:00+05:30', 'Automated Daily Data Refresh'),
                ('d' * 64, '2026-10-20T20:30:00+05:30', 'Automated Daily Data Refresh'),
                ('e' * 64, '2026-10-21T20:30:00+05:30', 'Automated weekly adjusted OHLCV refresh'),
            ]:
                manifest, compressed = self.snapshot(output, '2026-10-19', revision)
                if revision == 'c' * 64:
                    expected = compressed
                (output / 'current.json').write_text(json.dumps(manifest))
                git('add', '.')
                git('commit', '-qm', message, env=dict(os.environ,
                    GIT_AUTHOR_DATE=timestamp, GIT_COMMITTER_DATE=timestamp))
            restored = repo / 'restored'
            sessions = repo / 'sessions.json'
            selected = restore_evening_sessions(repo, '2026-10-17', '2026-10-22', restored, sessions)
            self.assertEqual(selected['2026-10-19']['revision'], 'c' * 64)
            self.assertEqual((restored / '2026-10-19.json.gz').read_bytes(), expected)
            self.assertEqual(len(json.loads(sessions.read_text())['sessions']), 1)
