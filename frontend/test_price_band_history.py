import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import price_band_history as pbh
from packed_snapshot import pack_snapshot


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

    def test_rebuilds_the_ledger_from_packed_and_plain_archives(self):
        archives = {
            "2026-10-21": {"revision": "a" * 64, "stocks": [{"symbol": "A", "circuitLimit": "20"}, {"symbol": "B", "circuitLimit": "5"}]},
            "2026-10-22": pack_snapshot({"revision": "b" * 64, "stocks": [
                {"symbol": "A", "circuitLimit": "10", "metrics": {"x": 1}}, {"symbol": "B"}]}),
        }

        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *exc): return False
            def read(self): return self.body

        def urlopen(request, timeout):
            session = request.full_url.rsplit("/", 1)[1].split(".")[0]
            return Response(gzip.compress(json.dumps(archives[session]).encode()))

        with tempfile.TemporaryDirectory() as directory, patch.object(pbh.urllib.request, "urlopen", urlopen):
            output = Path(directory)
            (output / "sessions.json").write_text(json.dumps({"version": 1, "sessions": [
                {"date": date, "revision": data["revision"]} for date, data in archives.items()]}))
            pbh.rebuild(output, "https://data.example.com", workers=1)
            ledger = json.loads((output / pbh.LEDGER_NAME).read_text())
        self.assertEqual(ledger["bands"], {"A": [["2026-10-21", "20"], ["2026-10-22", "10"]], "B": [["2026-10-21", "5"]]})
        self.assertEqual(ledger["through"], "2026-10-22")


if __name__ == "__main__":
    unittest.main()
