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

from fetch_ipo_provider_data import DETAIL_ENDPOINTS, _load_cache, _merge_listed_archive, _write_details_archive, fetch_all, main


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
    def test_detail_budget_prioritizes_missing_then_oldest_within_active_group(self):
        class ManyIssues(FakeClient):
            def get_json(self, endpoint):
                if endpoint == "/api/ipos/open":
                    return {"ipos": [{"id": identifier} for identifier in ("NEWER", "OLDEST", "MISSING", "FRESH")]}
                return super().get_json(endpoint)

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _write_details_archive(root, {
                "NEWER": {"fetched_at": "2001-01-01T00:00:00Z", "data": {}},
                "OLDEST": {"fetched_at": "2000-01-01T00:00:00Z", "data": {}},
                "FRESH": {"fetched_at": "2099-01-01T00:00:00Z", "data": {}},
            }, "2001-01-01T00:00:00Z")
            with patch("fetch_ipo_provider_data.IpoProviderClient", ManyIssues), \
                    patch("fetch_ipo_provider_data._refresh_detail", return_value=({"issue": {}}, [])) as refresh:
                fetch_all(root, detail_limit=3)
            self.assertEqual([call.args[1] for call in refresh.call_args_list], ["MISSING", "OLDEST", "NEWER"])

    def test_partial_detail_refresh_preserves_last_complete_timestamp_and_retries(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = {"fetched_at": "2000-01-01T00:00:00Z", "data": {"issue": {"price": 100}, "gmp_history": [1]}}
            _write_details_archive(root, {"NSE_TEST": previous}, previous["fetched_at"])
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), \
                    patch("fetch_ipo_provider_data._refresh_detail", return_value=({"issue": {"price": 110}}, ["gmp_history: unavailable"])) as refresh:
                for _ in range(2):
                    detail = fetch_all(root, detail_limit=1)["details"]["NSE_TEST"]
                    self.assertEqual(detail["fetched_at"], previous["fetched_at"])
                    self.assertEqual(detail["data"], {"issue": {"price": 110}, "gmp_history": [1]})
                    self.assertEqual(detail["errors"], ["gmp_history: unavailable"])
                self.assertEqual(refresh.call_count, 2)

    def test_preserves_archive_and_updates_recent_issue(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "ipo_provider_listed_archive.json.gz"
            with gzip.open(archive, "wt", encoding="utf-8") as handle:
                json.dump({"ipos": [{"id": "OLD", "listing_price": 100}, {"id": "RECENT", "listing_price": None}]}, handle)
            rows = _merge_listed_archive(root, [{"id": "RECENT", "listing_price": 120}])
            self.assertEqual({row["id"]: row["listing_price"] for row in rows}, {"OLD": 100, "RECENT": 120})
            first_bytes = archive.read_bytes()
            (root / "ipo_provider_history_data" / "listed.json.gz").unlink()
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
            (root / "ipo_provider_history_data" / "details.json").unlink()
            self.assertIn("NSE_TEST", _load_cache(root)["details"])

    def test_outage_fallback_restores_both_archives_without_actions_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            rows = _merge_listed_archive(root, [{"id": "OLD", "listing_price": 100}])
            details = {"OLD": {"fetched_at": "2026-10-01T00:00:00Z", "data": {"issue": {"price": 100}}}}
            _write_details_archive(root, details, "2026-10-01T00:00:00Z")
            for name in ("listed.json.gz", "details.json"):
                (root / "ipo_provider_history_data" / name).unlink()
            with patch("fetch_ipo_provider_data.BASE_DIR", root), patch("fetch_ipo_provider_data.fetch_all", side_effect=RuntimeError("outage")):
                self.assertEqual(main(), 0)
            payload = json.loads((root / "ipo_provider_data.json").read_text())
            self.assertFalse(payload["recent_feed_available"])
            self.assertEqual(payload["records"], rows)
            self.assertEqual(payload["details"], details)
            for name, key, expected in (("ipo_provider_listed_archive.json.gz", "ipos", rows),
                                        ("ipo_provider_details_archive.json.gz", "details", details)):
                with gzip.open(root / name, "rt") as handle:
                    self.assertEqual(json.load(handle)[key], expected)

    def test_failed_detail_refresh_preserves_data_and_retries_with_bounded_attempts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = {"fetched_at": "2000-01-01T00:00:00Z", "data": {"issue": {"price": 100}}}
            _write_details_archive(root, {"NSE_TEST": previous}, previous["fetched_at"])
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), patch("fetch_ipo_provider_data._refresh_detail", return_value=({}, ["outage"])) as refresh:
                for _ in range(2):
                    payload = fetch_all(root, detail_limit=1)
                    self.assertEqual(payload["details"]["NSE_TEST"]["fetched_at"], previous["fetched_at"])
                    self.assertEqual(payload["details"]["NSE_TEST"]["data"], previous["data"])
                self.assertEqual(refresh.call_count, 2)

    def test_failed_initial_refresh_does_not_set_freshness(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), patch("fetch_ipo_provider_data._refresh_detail", return_value=({}, ["outage"])):
                payload = fetch_all(Path(folder), detail_limit=1)
            self.assertNotIn("fetched_at", payload["details"]["NSE_TEST"])


if __name__ == "__main__":
    unittest.main()
