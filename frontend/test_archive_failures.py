import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from chart_publication import prepare_archives


class ArchiveFailureTests(unittest.TestCase):
    def test_both_parallel_archive_failures_are_consumed_and_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); charts = root / 'charts'; charts.mkdir()
            (root / 'filing_history.json.gz').write_bytes(b'not gzip')
            (root / 'filing_history_data').mkdir()
            (root / 'filing_history_data/filing_history.json').write_bytes(b'{}')
            output = io.StringIO()
            with patch('chart_publication.tempfile.TemporaryDirectory', side_effect=OSError('disk full')), \
                    contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(OSError, 'disk full'):
                    prepare_archives(charts)
            self.assertIn('Filing archive classified failed: disk full', output.getvalue())
            self.assertIn('Filing archive raw failed: disk full', output.getvalue())
