import gzip
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

from tools.generate_historical_snapshots_us import calculate_technicals_us, registered_session_dates


class GenerateHistoricalSnapshotsUsTests(unittest.TestCase):
    def test_calculate_technicals_us_computes_core_metrics(self):
        # 250 synthetic sessions with rising price and volume
        closes = np.linspace(50.0, 160.0, 250)
        opens = closes - 0.5
        highs = closes + 1.0
        lows = closes - 1.0
        volumes = np.full(250, 1_000_000.0)

        tech = calculate_technicals_us(opens, closes, highs, lows, volumes)

        self.assertEqual(tech['close'], 160.0)
        self.assertEqual(tech['high'], 161.0)
        self.assertEqual(tech['low'], 159.0)
        self.assertAlmostEqual(tech['sma10'], float(np.mean(closes[-10:])), places=1)
        self.assertAlmostEqual(tech['sma20'], float(np.mean(closes[-20:])), places=1)
        self.assertAlmostEqual(tech['sma50'], float(np.mean(closes[-50:])), places=1)
        self.assertAlmostEqual(tech['sma200'], float(np.mean(closes[-200:])), places=1)
        self.assertTrue(tech['close_above_sma20'])
        self.assertTrue(tech['close_above_sma50'])
        self.assertTrue(tech['sma50_above_sma200'])
        self.assertEqual(tech['rvol'], 1.0)
        self.assertGreater(tech['rsi14'], 70.0)  # Consistently rising price has high RSI
        self.assertAlmostEqual(tech['dist52wHighPct'], -0.62, places=2)

    def test_registered_session_dates(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest_path = Path(tmpdir) / 'us' / 'sessions.json'
            manifest_path.parent.mkdir(parents=True)
            self.assertEqual(registered_session_dates(manifest_path), set())

            manifest_path.write_text(json.dumps({
                'version': 1,
                'market': 'us',
                'sessions': [
                    {'date': '2024-01-02', 'revision': 'rev1'},
                    {'date': '2024-01-03', 'revision': 'rev2'},
                ]
            }))
            dates = registered_session_dates(manifest_path)
            self.assertEqual(dates, {'2024-01-02', '2024-01-03'})


if __name__ == '__main__':
    unittest.main()
