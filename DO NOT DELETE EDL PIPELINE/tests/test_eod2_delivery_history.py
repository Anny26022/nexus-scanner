import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from screen_trend_conditions import _load_delivery_history, _requires_delivery


class Eod2DeliveryHistoryTests(unittest.TestCase):
    def test_both_delivery_conditions_request_dated_history(self):
        self.assertTrue(_requires_delivery({"kind": "DELIVERY_PCT_SPIKE", "params": {}}))
        self.assertTrue(_requires_delivery({"kind": "DELIVERY_PERCENT", "params": {}}))

    def test_official_delivery_wins_and_eod2_fills_missing_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            official = root / "official"; official.mkdir()
            eod2 = root / "eod2"; eod2.mkdir()
            (official / "2026-09-25.json").write_text(json.dumps({"date": "2026-09-25", "records": [{
                "symbol": "ABC", "date": "2026-09-25", "delivery_percent": 61.0,
            }]}))
            with (eod2 / "ABC.csv").open("w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["Date", "Series", "traded_quantity", "deliverable_quantity", "delivery_percent"])
                writer.writeheader()
                writer.writerows([
                    {"Date": "2020-01-02", "Series": "EQ", "traded_quantity": 100, "deliverable_quantity": 70, "delivery_percent": 70},
                    {"Date": "2026-09-25", "Series": "EQ", "traded_quantity": 100, "deliverable_quantity": 99, "delivery_percent": 99},
                ])
            records = {row["date"]: row for row in _load_delivery_history(official, ["ABC"], eod2)["ABC"]}
            self.assertEqual(records["2020-01-02"]["delivery_percent"], "70")
            self.assertEqual(records["2026-09-25"]["delivery_percent"], 61.0)
