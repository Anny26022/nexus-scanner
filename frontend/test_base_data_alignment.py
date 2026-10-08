"""Ensure release-coverage checks cannot silently substitute a different session."""
import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('base_alignment', Path(__file__).resolve().parents[1] / 'scripts/check_base_data_alignment.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BaseDataAlignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'ohlcv_data').mkdir()

    def stocks(self, rows):
        with gzip.open(self.root / 'all_stocks_fundamental_analysis.json.gz', 'wt') as target:
            json.dump(rows, target)

    def test_future_candle_does_not_fill_missing_release_session(self):
        self.stocks([{'symbol': 'TEST', 'as_of_date': '2026-09-30'}])
        (self.root / 'ohlcv_data/TEST.csv').write_text('Date,Close\n2026-09-29,100\n2026-10-01,101\n')
        report = module.audit(self.root)
        self.assertFalse(report['complete'])
        self.assertEqual(report['historyCounts'], {'missing_session': 1})
        self.assertEqual(report['examples']['missing_session'][0]['latestAtCutoff'], '2026-09-29')

    def test_complete_coverage_excludes_ineligible_stocks(self):
        self.stocks([{'symbol': 'TEST', 'as_of_date': '2026-09-30'},
                     {'symbol': 'EXCLUDED', 'default_screener_eligible': False}])
        (self.root / 'ohlcv_data/TEST.csv').write_text('Date,Close\n2026-09-30,100\n2026-10-01,101\n')
        self.assertTrue(module.audit(self.root)['complete'])

    def test_metadata_mismatch_cannot_pass_with_aligned_candles(self):
        self.stocks([{'symbol': 'TEST', 'as_of_date': '2026-09-29'},
                     {'symbol': 'OTHER', 'as_of_date': '2026-09-30'}])
        for symbol in ('TEST', 'OTHER'):
            (self.root / f'ohlcv_data/{symbol}.csv').write_text('Date,Close\n2026-09-30,100\n')
        with self.assertRaises(ValueError):
            module.audit(self.root)
        report = module.audit(self.root, '2026-09-30')
        self.assertEqual(report['alignedFraction'], 1)
        self.assertFalse(report['complete'])
