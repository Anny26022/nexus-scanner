import sys
import tempfile
import unittest
import gzip
import json
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fetch_ipo_provider_data import DETAIL_ENDPOINTS, _load_cache, _merge_listed_archive, _write_details_archive, fetch_all


class FakeClient:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def get_json(self, endpoint):
        if endpoint == "/api/ipos/open":
            return {"ipos": [{"id": "NSE_TEST", "symbol": "TEST"}]}
        if endpoint in ("/api/ipos/upcoming", "/api/ipos/closed"):
            return {"ipos": []}
        if endpoint == "/api/ipos/listed?days=60":
            return {"ipos": [{"id": "NSE_LISTED", "symbol": "LISTED"}]}
        return {"endpoint": endpoint}


class IpoProviderFetchTests(unittest.TestCase):
    def test_preserves_archive_and_updates_recent_issue(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "ipo_provider_listed_archive.json.gz"
            with gzip.open(archive, "wt", encoding="utf-8") as handle:
                json.dump({"ipos": [{"id": "OLD", "listing_price": 100}, {"id": "RECENT", "listing_price": None}]}, handle)
            rows = _merge_listed_archive(root, [{"id": "RECENT", "listing_price": 120}])
            self.assertEqual({row["id"]: row["listing_price"] for row in rows}, {"OLD": 100, "RECENT": 120})
            first_bytes = archive.read_bytes()
            self.assertEqual(len(_merge_listed_archive(root, [])), 2)
            self.assertEqual(archive.read_bytes(), first_bytes)

    def test_fetches_all_feed_groups_and_persists_detailed_issue_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), patch("fetch_ipo_provider_data.time.sleep"):
                payload = fetch_all(root, detail_limit=1)
            self.assertTrue(payload["available"])
            self.assertIn("freshness", payload["feeds"])
            self.assertIn("gmp_scorecard", payload["analytics"])
            detail = payload["details"]["NSE_TEST"]["data"]
            self.assertEqual(set(detail), set(DETAIL_ENDPOINTS))
            self.assertTrue((root / "ipo_provider_details_archive.json.gz").exists())
            self.assertIn("NSE_TEST", _load_cache(root)["details"])

    def test_published_details_archive_restores_without_actions_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _write_details_archive(root, {"NSE_TEST": {"fetched_at": "2026-10-04T00:00:00Z", "data": {}}}, "2026-10-04T00:00:00Z")
            self.assertIn("NSE_TEST", _load_cache(root)["details"])


if __name__ == "__main__":
    unittest.main()
