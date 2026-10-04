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
    LISTED_PAGE_SIZE,
    _listed_key,
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


class FullPageClient(FakeClient):
    def post_json(self, endpoint, body):
        if endpoint != "listedIpos":
            return super().post_json(endpoint, body)
        self.calls.append((endpoint, body))
        page = body["data"]["page_value"]
        if page > 1:
            return {"status": "success", "data": []}
        return {"status": "success", "data": [{
            "ipo_symbol_name": f"NEW{page}_{index}",
            "ipo_listed_date": f"2026-09-{25 - page:02d}T00:00",
            "seo_symbol": f"new-{page}-{index}",
        } for index in range(LISTED_PAGE_SIZE)]}


class EmptyHistoryClient(FakeClient):
    def post_json(self, endpoint, body):
        if endpoint == "history":
            self.calls.append((endpoint, body))
            return {"status": "success", "data": []}
        return super().post_json(endpoint, body)


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
                patch("fetch_scanx_ipo_data.ScanxIpoClient", FullPageClient), \
                patch("fetch_scanx_ipo_data.time.sleep"):
            root = Path(folder)
            _merge_listed_archive(root, [{
                "ipo_symbol_name": "OLD", "ipo_isin": "INE0", "ipo_listed_date": "2020-01-01",
                "seo_symbol": "old-ltd",
            }])
            payload = fetch_all(root, detail_limit=0)
            pages = [body["data"]["page_value"] for endpoint, body in FakeClient.calls if endpoint == "listedIpos"]
            self.assertEqual(pages, [0, 1])
            self.assertFalse(payload["coverage"]["full_history_bootstrap"])
            self.assertIn("OLD", {row["ipo_symbol_name"] for row in payload["records"]})
            self.assertEqual(len(payload["records"]), 1 + (2 * LISTED_PAGE_SIZE))

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

    def test_placeholder_isin_falls_back_to_symbol_and_listing_date(self):
        first = {"ipo_isin": "NA", "ipo_symbol_name": "ONE", "ipo_listed_date": "2026-01-01"}
        second = {"ipo_isin": "NA", "ipo_symbol_name": "TWO", "ipo_listed_date": "2026-01-02"}
        self.assertNotEqual(_listed_key(first), _listed_key(second))
        with tempfile.TemporaryDirectory() as folder:
            rows = _merge_listed_archive(Path(folder), [first, second])
            self.assertEqual(len(rows), 2)

    def test_corrupt_archives_are_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "scanx_ipo_listed_archive.json.gz").write_bytes(gzip.compress(b'{"ipos":[')[:-2])
            (root / "scanx_ipo_details_archive.json.gz").write_bytes(gzip.compress(b'{"details":')[:-3])
            self.assertEqual(_load_listed_archive(root), [])
            self.assertEqual(_load_details_archive(root), {})

    def test_empty_detail_refresh_preserves_cached_data(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch("fetch_scanx_ipo_data.ScanxIpoClient", EmptyHistoryClient), \
                patch("fetch_scanx_ipo_data.time.sleep"):
            root = Path(folder)
            previous = {
                "fetched_at": "2000-01-01T00:00:00Z", "available": True,
                "data": {"symbol": "NEW", "financials": [{"date": "2025-03-31"}]}, "errors": [],
            }
            _write_details_archive(root, {"new-ltd": previous}, previous["fetched_at"])
            payload = fetch_all(root, detail_limit=1)
            refreshed = payload["details"]["new-ltd"]
            self.assertEqual(refreshed["data"], previous["data"])
            self.assertEqual(refreshed["fetched_at"], previous["fetched_at"])
            self.assertTrue(refreshed["available"])
            self.assertIn("no records", refreshed["errors"][0])

    def test_full_bootstrap_refuses_silent_page_cap_truncation(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch("fetch_scanx_ipo_data.ScanxIpoClient", FullPageClient), \
                patch("fetch_scanx_ipo_data.MAX_LISTED_PAGES", 2), \
                patch("fetch_scanx_ipo_data.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "refusing truncated archive"):
                fetch_all(Path(folder), detail_limit=0)


if __name__ == "__main__":
    unittest.main()
