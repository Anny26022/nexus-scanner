import json
import tempfile
import unittest
from pathlib import Path

import price_band_history as pbh


class PriceBandHistoryTest(unittest.TestCase):
    def test_folds_sessions_into_band_changes_and_skips_gaps(self):
        ledger = pbh.empty_ledger()
        pbh.apply_session(ledger, "2021-10-01", [{"symbol": "A", "circuitLimit": "20"}, {"symbol": "B", "circuitLimit": "No band"}])
        pbh.apply_session(ledger, "2021-10-04", [{"symbol": "A", "circuitLimit": "20.0"}, {"symbol": "B", "circuitLimit": None}])
        pbh.apply_session(ledger, "2021-10-05", [{"symbol": "A", "circuitLimit": "10%"}])
        pbh.apply_session(ledger, "2021-10-06", [{"symbol": "A", "circuitLimit": "10"}, {"symbol": "B", "circuitLimit": "5"}])
        self.assertEqual(ledger["bands"], {"A": [["2021-10-01", "20"], ["2021-10-05", "10"]], "B": [["2021-10-01", "No Band"], ["2021-10-06", "5"]]})
        self.assertEqual((ledger["from"], ledger["through"]), ("2021-10-01", "2021-10-06"))

    def test_republishing_a_folded_date_changes_nothing(self):
        ledger = pbh.apply_session(pbh.empty_ledger(), "2026-10-22", [{"symbol": "A", "circuitLimit": "5"}])
        pbh.apply_session(ledger, "2026-10-22", [{"symbol": "A", "circuitLimit": "20"}])
        self.assertEqual(ledger["bands"]["A"], [["2026-10-22", "5"]])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / pbh.LEDGER_NAME
            pbh.write_ledger(path, ledger)
            self.assertEqual(pbh.load_ledger(path), json.loads(path.read_text()))

    def test_normalizes_band_text(self):
        self.assertEqual([pbh.normalize_band(v) for v in ["20", " 5 % ", "2.0", "No Band", "-", "", None, "abc"]],
                         ["20", "5", "2", "No Band", None, None, None, None])


if __name__ == "__main__":
    unittest.main()
