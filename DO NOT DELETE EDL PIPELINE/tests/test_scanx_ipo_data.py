import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fetch_scanx_ipo_data import (
    _load_details_archive,
    _load_listed_archive,
    _merge_listed_archive,
    _write_details_archive,
    fetch_all,
)


class FakeClient:
    calls = []

    def __init__(self, *_args, **_kwargs):
        pass

    def post_json(self, endpoint, body):
        self.calls.append((endpoint, body))
        if endpoint == "ipolisting":
            return {"status": "success", "data": [{"symbol": "NEW", "custom_symbol": "new-ltd"}]}
        if endpoint == "ActiveUpcomingIpo":
            return {"status": "success", "data": []}
        if endpoint == "listedIpos":
            page = body["data"]["page_value"]
            return {"status": "success", "data": [{
                "ipo_symbol_name": "NEW", "ipo_isin": "INE1", "ipo_listed_date": "2026-09-25T00:00",
                "ipo_issue_price": 100, "seo_symbol": "new-ltd",
            }] if page == 0 else []}
        if endpoint == "history":
            return {"status": "success", "data": [{
                "symbol": "NEW", "isin": "INE1", "listing_date": "2026-09-25 17:00:00",
                "ceiling_price": 100, "issue_size": 500_000_000,
                "catsubscription_data": {"retail_times": 3.2, "qib_times": 7.5},
                "financials": [{"date": "2026-03-31", "unit": "Lakh"}],
            }]}
        raise AssertionError(endpoint)


class ScanxIpoDataTests(unittest.TestCase):
    def setUp(self):
        FakeClient.calls = []

    def test_bootstraps_listed_archive_and_rich_details(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch("fetch_scanx_ipo_data.ScanxIpoClient", FakeClient), \
                patch("fetch_scanx_ipo_data.time.sleep"):
            root = Path(folder)
            payload = fetch_all(root, detail_limit=1)
            self.assertTrue(payload["available"])
            self.assertTrue(payload["coverage"]["full_history_bootstrap"])
            self.assertEqual(payload["coverage"]["listed_records"], 1)
            self.assertEqual(payload["details"]["new-ltd"]["data"]["financials"][0]["unit"], "Lakh")
            self.assertTrue((root / "scanx_ipo_listed_archive.json.gz").exists())
            self.assertTrue((root / "scanx_ipo_details_archive.json.gz").exists())
            self.assertEqual(len(_load_listed_archive(root)), 1)
            self.assertIn("new-ltd", _load_details_archive(root))

    def test_existing_archive_uses_only_recent_listed_pages(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch("fetch_scanx_ipo_data.ScanxIpoClient", FakeClient), \
                patch("fetch_scanx_ipo_data.time.sleep"):
            root = Path(folder)
            _merge_listed_archive(root, [{
                "ipo_symbol_name": "OLD", "ipo_isin": "INE0", "ipo_listed_date": "2020-01-01",
                "seo_symbol": "old-ltd",
            }])
            payload = fetch_all(root, detail_limit=0)
            pages = [body["data"]["page_value"] for endpoint, body in FakeClient.calls if endpoint == "listedIpos"]
            self.assertEqual(pages, [0])
            self.assertEqual({row["ipo_symbol_name"] for row in payload["records"]}, {"NEW", "OLD"})

    def test_published_archives_restore_without_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            rows = _merge_listed_archive(root, [{
                "ipo_symbol_name": "OLD", "ipo_isin": "INE0", "ipo_listed_date": "2020-01-01",
            }])
            _write_details_archive(root, {"old-ltd": {"data": {"symbol": "OLD"}}}, "2026-10-04T00:00:00Z")
            for name in ("listed.json.gz", "details.json.gz"):
                (root / "scanx_ipo_history_data" / name).unlink()
            self.assertEqual(_load_listed_archive(root), rows)
            self.assertEqual(_load_details_archive(root)["old-ltd"]["data"]["symbol"], "OLD")


if __name__ == "__main__":
    unittest.main()
