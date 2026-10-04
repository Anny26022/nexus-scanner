import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edl_pipeline.scanner.reference import compare_symbol_sets
from edl_pipeline.scanner.presets import list_presets
from audit_scanner_reference import audit_reference

# ``audit_reference`` imports the normal CLI context loader, so this unit test
# checks the complete-reference contract at the pure report boundary instead.


class ScannerReferenceTests(unittest.TestCase):
    def test_normalizes_symbols_and_reports_both_directions(self):
        result = compare_symbol_sets(["abc", "ABC", " ", "def"], ["ABC", "ghi"])
        self.assertEqual(result["reference_count"], 2)
        self.assertEqual(result["local_count"], 2)
        self.assertEqual(result["shared_count"], 1)
        self.assertEqual(result["reference_only"], ["DEF"])
        self.assertEqual(result["local_only"], ["GHI"])
        self.assertEqual(result["jaccard"], 0.333333)
        self.assertFalse(result["exact"])

    def test_empty_sets_are_an_exact_match(self):
        result = compare_symbol_sets([], [])
        self.assertTrue(result["exact"])
        self.assertEqual(result["jaccard"], 1.0)

    def test_library_has_the_45_preset_ids_required_for_full_parity(self):
        preset_ids = {preset["id"] for preset in list_presets()}
        self.assertEqual(len(preset_ids), 45)
        self.assertIn("lib-persistent-momentum", preset_ids)

    def test_audit_accepts_human_facing_preset_names(self):
        # Reference result captures use the visible preset name, while the
        # local library uses ``lib-*`` IDs. Completeness must resolve both.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            ohlcv = root / "ohlcv_data"
            ohlcv.mkdir()
            dates = pd.date_range("2025-01-01", periods=60, freq="B")
            pd.DataFrame({
                "Date": dates.strftime("%Y-%m-%d"),
                "Open": range(100, 160), "High": range(101, 161),
                "Low": range(99, 159), "Close": range(100, 160),
                "Volume": [1_000_000] * 60,
            }).to_csv(ohlcv / "TEST.csv", index=False)
            report = audit_reference(root, {
                "as_of_date": "2025-03-25",
                "screens": {"Persistent Momentum": []},
                "universe_symbols": ["TEST", "NOT_LOCAL"],
            })
        self.assertEqual(report["provided_preset_count"], 1)
        self.assertFalse(report["complete"])
        self.assertIn("lib-persistent-momentum", report["screens"])
        self.assertEqual(report["universe_comparison"]["shared_universe_count"], 1)
        self.assertEqual(report["universe_comparison"]["reference_only_count"], 1)
