import sys
import tempfile
import unittest
import gzip
import json
import subprocess
import requests
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fetch_ipo_provider_data import ACTIVE_DETAIL_REFRESH_LIMIT, DETAIL_ENDPOINTS, IpoProviderClient, ProviderBackoff, _load_cache, _merge_listed_archive, _refresh_detail, _write_details_archive, fetch_all, main


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
    def test_stale_active_and_recently_listed_details_refresh_but_history_stays_missing_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            complete = {name:{} for name in DETAIL_ENDPOINTS}
            _merge_listed_archive(root, [{'id':'HISTORICAL'}])
            _write_details_archive(root, {identifier:{'fetched_at':'2000-01-01T00:00:00Z', 'data':complete}
                                         for identifier in ('NSE_TEST','NSE_LISTED','HISTORICAL')}, 'fixture')
            updated = {**complete, 'documents':[{'title':'New prospectus'}]}
            with patch('fetch_ipo_provider_data.IpoProviderClient', FakeClient), \
                    patch('fetch_ipo_provider_data._refresh_detail', return_value=(updated, [])) as fetch:
                payload = fetch_all(root)
                self.assertEqual([call.args[1] for call in fetch.call_args_list], ['NSE_TEST','NSE_LISTED'])
                self.assertTrue(all(call.args[2] == set(DETAIL_ENDPOINTS) for call in fetch.call_args_list))
                self.assertEqual(payload['details']['NSE_TEST']['data']['documents'], updated['documents'])
                fetch.reset_mock()
                fetch_all(root)
                fetch.assert_not_called()  # Fresh active records do not refresh twice in a day.

    def test_active_refresh_is_bounded_rotates_and_does_not_cap_missing_history(self):
        class BusyClient(FakeClient):
            def get_json(self, endpoint):
                if endpoint == '/api/ipos/open':
                    return {'ipos':[{'id':f'ACTIVE_{i}'} for i in range(8)]}
                if endpoint == '/api/ipos/listed?days=60':
                    return {'ipos':[{'id':'RECENT'}]}
                return super().get_json(endpoint)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            complete = {name:{} for name in DETAIL_ENDPOINTS}
            _merge_listed_archive(root, [{'id':'MISSING_HISTORY'}])
            _write_details_archive(root, {
                **{f'ACTIVE_{i}':{'fetched_at':'2000-01-01T00:00:00Z', 'data':complete} for i in range(8)},
                'RECENT':{'fetched_at':'1999-01-01T00:00:00Z', 'data':complete},
            }, 'fixture')
            with patch('fetch_ipo_provider_data.IpoProviderClient', BusyClient), \
                    patch('fetch_ipo_provider_data._refresh_detail', return_value=(complete, [])) as fetch:
                fetch_all(root)
                self.assertEqual(ACTIVE_DETAIL_REFRESH_LIMIT, 6)
                self.assertEqual([call.args[1] for call in fetch.call_args_list],
                                 [*[f'ACTIVE_{i}' for i in range(5)], 'MISSING_HISTORY', 'RECENT'])
                fetch.reset_mock()
                fetch_all(root)
                self.assertEqual([call.args[1] for call in fetch.call_args_list], ['ACTIVE_5','ACTIVE_6','ACTIVE_7'])

    def test_active_refresh_failure_preserves_old_sections_then_retries_only_failed_section(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            complete = {name:{'retained':True} for name in DETAIL_ENDPOINTS}
            _write_details_archive(root, {
                'NSE_TEST':{'fetched_at':'2000-01-01T00:00:00Z', 'data':complete},
                'NSE_LISTED':{'fetched_at':'2099-01-01T00:00:00Z', 'data':complete},
            }, 'fixture')
            with patch('fetch_ipo_provider_data.IpoProviderClient', FakeClient), \
                    patch('fetch_ipo_provider_data._refresh_detail', return_value=(
                        {'documents':[{'title':'Updated'}]}, ['gmp_history: failed'])):
                payload = fetch_all(root)
            self.assertEqual(payload['details']['NSE_TEST']['data']['gmp_history'], {'retained':True})
            self.assertEqual(payload['details']['NSE_TEST']['fetched_at'], '2000-01-01T00:00:00Z')
            with patch('fetch_ipo_provider_data.IpoProviderClient', FakeClient), \
                    patch('fetch_ipo_provider_data._refresh_detail', return_value=({'gmp_history':[1]}, [])) as fetch:
                fetch_all(root)
            self.assertEqual(fetch.call_args.args[2], {'gmp_history'})

    def test_http_and_transport_outages_back_off_but_missing_objects_do_not(self):
        for status in (401, 403, 408, 429, 500, 501, 505, 599, 404, 302):
            with self.subTest(status=status):
                client = IpoProviderClient()
                try:
                    with patch.object(client.session, 'get', return_value=Mock(status_code=status)):
                        error = ValueError if status in (404, 302) else ProviderBackoff
                        with self.assertRaises(error):
                            client.get_json("/api/ipos/TEST")
                finally:
                    client.session.close()
        for error in (requests.Timeout('secret'), requests.ConnectionError('secret')):
            client = IpoProviderClient()
            try:
                with patch.object(client.session, 'get', side_effect=error):
                    with self.assertRaisesRegex(ProviderBackoff, '^Provider requested backoff$'):
                        client.get_json('/api/ipos/TEST')
            finally:
                client.session.close()

    def test_request_pacing_counts_response_time_without_an_additional_full_delay(self):
        for elapsed, expected in ((0.10, 0.18), (0.28, None), (0.50, None)):
            with self.subTest(elapsed=elapsed), patch('fetch_ipo_provider_data.time.perf_counter', side_effect=[0, elapsed]), \
                    patch('fetch_ipo_provider_data.time.sleep') as sleep:
                values, errors = _refresh_detail(FakeClient(), 'NSE_TEST', {'issue'})
            self.assertIn('issue', values)
            self.assertFalse(errors)
            if expected is None:
                sleep.assert_not_called()
            else:
                self.assertAlmostEqual(sleep.call_args.args[0], expected)
        client = Mock(); client.get_json.side_effect = ProviderBackoff()
        with patch('fetch_ipo_provider_data.time.sleep') as sleep:
            values, errors = _refresh_detail(client, 'NSE_TEST')
        client.get_json.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(values, {})
        self.assertIn('provider requested backoff', errors[0])

    def test_provider_session_reuses_bootstrap_cookies_and_closes_on_exit_or_failure(self):
        session = requests.Session()
        session.cookies.set('ipd_nonce', 'ephemeral-secret')
        response = Mock(status_code=200)
        response.json.return_value = {'value': 'data'}
        with patch('fetch_ipo_provider_data.requests.Session', return_value=session), \
                patch.object(session, 'get', return_value=response) as get, patch.object(session, 'close') as close:
            with IpoProviderClient() as client:
                self.assertEqual(client.get_json('/api/ipos/A'), {'value': 'data'})
                self.assertEqual(client.get_json('/api/ipos/B'), {'value': 'data'})
                self.assertEqual(client.nonce, 'ephemeral-secret')
            self.assertEqual(get.call_count, 3)
            self.assertEqual(get.call_args.kwargs['headers']['X-IPO-Session'], 'ephemeral-secret')
            self.assertFalse(get.call_args.kwargs['allow_redirects'])
            close.assert_called_once()
        with patch('fetch_ipo_provider_data.requests.Session', return_value=session), \
                patch.object(session, 'get', side_effect=requests.Timeout()), patch.object(session, 'close') as close:
            with self.assertRaises(ProviderBackoff):
                with IpoProviderClient():
                    pass
            close.assert_called_once()

    def test_next_run_collects_a_new_ipo_without_revisiting_completed_details(self):
        class NewIssueClient(FakeClient):
            def get_json(self, endpoint):
                if endpoint == "/api/ipos/open":
                    return {"ipos":[{"id":"NSE_TEST"}, {"id":"NSE_NEW"}]}
                return super().get_json(endpoint)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            complete = {name:{} for name in DETAIL_ENDPOINTS}
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), \
                    patch("fetch_ipo_provider_data._refresh_detail", return_value=(complete, [])):
                fetch_all(root)
            with patch("fetch_ipo_provider_data.IpoProviderClient", NewIssueClient), \
                    patch("fetch_ipo_provider_data._refresh_detail", return_value=(complete, [])) as fetch:
                payload = fetch_all(root)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(fetch.call_args.args[1], "NSE_NEW")
            self.assertEqual(payload["detail_coverage"]["incomplete"], 0)

    def test_feed_backoff_preserves_completed_feeds_and_stops_requests(self):
        requested = []
        class LimitedClient(FakeClient):
            def get_json(self, endpoint):
                requested.append(endpoint)
                if endpoint == "/api/ipos/upcoming":
                    raise ProviderBackoff()
                return super().get_json(endpoint)
        with tempfile.TemporaryDirectory() as folder:
            with patch("fetch_ipo_provider_data.IpoProviderClient", LimitedClient), \
                    patch("fetch_ipo_provider_data._refresh_detail") as refresh:
                payload = fetch_all(Path(folder), missing_budget_seconds=60)
            self.assertIn("open", payload["feeds"])
            self.assertEqual(payload["analytics"], {})
            self.assertFalse(payload["refresh_complete"])
            self.assertEqual(requested, ["/api/ipos/open", "/api/ipos/upcoming"])
            refresh.assert_not_called()

    def test_detail_backoff_retains_successful_sections_of_current_issue(self):
        class LimitedClient(FakeClient):
            def get_json(self, endpoint):
                if endpoint.endswith("/gmp"):
                    raise ProviderBackoff()
                return super().get_json(endpoint)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch("fetch_ipo_provider_data.IpoProviderClient", LimitedClient), \
                    patch("fetch_ipo_provider_data.time.sleep"):
                payload = fetch_all(root, missing_budget_seconds=60)
            self.assertEqual(payload["detail_coverage"]["attempted"], 1)
            item = next(iter(_load_cache(root)["details"].values()))
            self.assertIn("issue", item["data"])
            self.assertNotIn("fetched_at", item)

    def test_normal_run_fills_missing_sections_and_skips_complete_history(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            complete = {name: {} for name in DETAIL_ENDPOINTS}
            _merge_listed_archive(root, [{"id":"COMPLETE"}, {"id":"PARTIAL"}])
            _write_details_archive(root, {
                "COMPLETE":{"fetched_at":"2099-01-01T00:00:00Z", "data":complete},
                "PARTIAL":{"fetched_at":"2000-01-01T00:00:00Z", "data":{key:value for key,value in complete.items() if key != "documents"}},
            }, "2099-01-01T00:00:00Z")
            def refresh(client, identifier, endpoints=None):
                return {name:{} for name in (endpoints or DETAIL_ENDPOINTS)}, []
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), \
                    patch("fetch_ipo_provider_data._refresh_detail", side_effect=refresh) as fetch:
                payload = fetch_all(root, missing_budget_seconds=60)
            self.assertGreater(fetch.call_count, 1)
            self.assertNotIn("COMPLETE", [call.args[1] for call in fetch.call_args_list])
            partial = next(call for call in fetch.call_args_list if call.args[1] == "PARTIAL")
            self.assertEqual(partial.args[2], {"documents"})
            self.assertEqual(payload["detail_coverage"]["incomplete"], 0)
            self.assertEqual(payload["details"]["PARTIAL"]["fetched_at"], payload["fetched_at"])
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), \
                    patch("fetch_ipo_provider_data._refresh_detail") as fetch:
                fetch_all(root, missing_budget_seconds=60)
            fetch.assert_not_called()

    def test_completion_lane_stops_at_deadline_and_resumes_next_run(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            complete = {name:{} for name in DETAIL_ENDPOINTS}
            elapsed = {"seconds":0}
            clock = SimpleNamespace(monotonic=lambda: elapsed["seconds"])
            def refresh(*args):
                elapsed["seconds"] += 60
                return complete, []
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), \
                    patch("fetch_ipo_provider_data.time", clock), \
                    patch("fetch_ipo_provider_data._refresh_detail", side_effect=refresh) as fetch:
                first = fetch_all(root, missing_budget_seconds=30)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(first["detail_coverage"]["incomplete"], 1)
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), \
                    patch("fetch_ipo_provider_data._refresh_detail", return_value=(complete, [])) as fetch:
                second = fetch_all(root, missing_budget_seconds=30)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(second["detail_coverage"]["incomplete"], 0)

    def test_provider_backoff_preserves_progress_without_fetching_remaining_issues(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _merge_listed_archive(root, [{"id":"THIRD"}])
            complete = {name:{} for name in DETAIL_ENDPOINTS}
            with patch("fetch_ipo_provider_data.IpoProviderClient", FakeClient), \
                    patch("fetch_ipo_provider_data._refresh_detail", side_effect=[(complete, []), ({}, ["issue: provider requested backoff"])]) as fetch:
                payload = fetch_all(root, missing_budget_seconds=30)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(payload["detail_coverage"]["complete"], 1)
            cached = _load_cache(root)["details"]
            self.assertEqual(len(cached), 2)
            self.assertNotIn("THIRD", cached)
            self.assertTrue(any("provider requested backoff" in error for error in payload["errors"]))

    def test_request_errors_and_legacy_cache_never_retain_session_headers(self):
        secret = "synthetic-session-token"
        error = subprocess.CalledProcessError(22, ["curl", "--header", "X-IPO-Session: " + secret])
        with patch.object(FakeClient, "get_json", side_effect=error), patch("fetch_ipo_provider_data.time.sleep"):
            _, errors = _refresh_detail(FakeClient(), "NSE_TEST")
        self.assertEqual(len(errors), len(DETAIL_ENDPOINTS))
        self.assertNotIn(secret, json.dumps(errors))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "ipo_provider_history_data" / "details.json"
            path.parent.mkdir()
            path.write_text(json.dumps({"details": {"OLD": {"errors": ["issue: " + str(error)], "data": {}}}}))
            with patch("fetch_ipo_provider_data.BASE_DIR", root), patch("fetch_ipo_provider_data.fetch_all", side_effect=error):
                main()
            self.assertNotIn(secret, (root / "ipo_provider_data.json").read_text())
            with gzip.open(root / "ipo_provider_details_archive.json.gz", "rt") as handle:
                self.assertNotIn(secret, handle.read())

    def test_live_issues_precede_missing_history_outside_recent_feed(self):
        class BusyClient(FakeClient):
            def get_json(self, endpoint):
                if endpoint == "/api/ipos/open":
                    return {"ipos": [{"id": f"ACTIVE_{index}"} for index in range(5)]}
                if endpoint == "/api/ipos/listed?days=60":
                    return {"ipos": []}
                return super().get_json(endpoint)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _merge_listed_archive(root, [{"id": "ARCHIVED", "listing_date_iso": "2000-01-01"}])
            with patch("fetch_ipo_provider_data.IpoProviderClient", BusyClient), \
                    patch("fetch_ipo_provider_data._refresh_detail", return_value=({"issue": {}}, [])) as refresh:
                fetch_all(root)
            self.assertEqual(refresh.call_count, 6)
            self.assertEqual(refresh.call_args_list[-1].args[1], "ARCHIVED")

    def test_failed_attempt_rotates_behind_never_attempted_issue(self):
        class TwoIssues(FakeClient):
            def get_json(self, endpoint):
                if endpoint == "/api/ipos/open":
                    return {"ipos": [{"id": "A_FAILURE"}, {"id": "B_NEW"}]}
                return super().get_json(endpoint)
        with tempfile.TemporaryDirectory() as folder:
            with patch("fetch_ipo_provider_data.IpoProviderClient", TwoIssues), \
                    patch("fetch_ipo_provider_data._refresh_detail", return_value=({}, ["issue: failed"])) as refresh:
                fetch_all(Path(folder), detail_limit=1)
                fetch_all(Path(folder), detail_limit=1)
            self.assertEqual([call.args[1] for call in refresh.call_args_list], ["A_FAILURE", "B_NEW"])

    def test_catalogue_failure_marks_refresh_incomplete_even_with_other_feeds(self):
        class PartialClient(FakeClient):
            def get_json(self, endpoint):
                if endpoint == "/api/ipos/open":
                    raise ValueError("invalid response")
                return super().get_json(endpoint)
        with tempfile.TemporaryDirectory() as folder:
            with patch("fetch_ipo_provider_data.IpoProviderClient", PartialClient):
                payload = fetch_all(Path(folder), detail_limit=0)
            self.assertTrue(payload["available"])
            self.assertFalse(payload["refresh_complete"])
            self.assertEqual(payload["errors"], ["open: invalid provider response"])

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
                "FRESH": {"fetched_at": "2099-01-01T00:00:00Z", "data": {name:{} for name in DETAIL_ENDPOINTS}},
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
                    self.assertEqual(detail["errors"], ["gmp_history: request failed"])
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
