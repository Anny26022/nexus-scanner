import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import build_filing_history_artifact
import fetch_company_filings
from pipeline_utils import load_json, save_json


class FilingHistoryTests(unittest.TestCase):
    def test_first_fetch_backfills_every_lodr_page_then_deduplicates(self):
        pages = iter([
            ([{"news_id": "legacy", "news_date": "2026-09-01"}], 1, None),
            ([{"news_id": "one", "news_date": "2026-09-03"}], 3, None),
            ([{"news_id": "two", "news_date": "2026-08-03"}], 3, None),
            ([{"news_id": "three", "news_date": "2026-07-03"}], 3, None),
        ])
        with mock.patch.object(fetch_company_filings, "fetch_page", side_effect=lambda *args: next(pages)):
            result = fetch_company_filings.fetch_filings({"Symbol": "ABC", "ISIN": "INE000000001"})
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["history"]["lodr_backfill_complete"])
        self.assertEqual(result["history"]["lodr_total_pages"], 3)
        self.assertEqual([item["news_id"] for item in result["history"]["filings"]], ["one", "legacy", "two", "three"])

    def test_completed_history_stops_on_an_unchanged_retained_page(self):
        known = {"news_id":"known", "news_date":"2026-09-25", "source_endpoint":"lodr"}
        existing = {"lodr_backfill_complete":True, "lodr_total_pages":3, "filings":[known]}
        with mock.patch.object(fetch_company_filings, "fetch_page", side_effect=[
            ([],1,None), ([known],4,None),
        ]) as pages:
            result = fetch_company_filings.fetch_filings({"Symbol":"ABC","ISIN":"INE000000001"},existing)
        self.assertEqual(pages.call_count,2)
        self.assertTrue(result["refresh_complete"])
        self.assertEqual(result["history"]["fetch_status"]["lodr"]["pages_fetched"],1)
        self.assertTrue(result["history"]["lodr_backfill_complete"])
        self.assertEqual(result["history"]["lodr_total_pages"],4)

    def test_catches_up_multiple_unseen_pages_in_both_feeds(self):
        known = [{"news_id":"old","source_endpoint":endpoint} for endpoint in ("company_filings","lodr")]
        existing = {"lodr_backfill_complete":True, "filings":known}
        calls = []
        def fetch(url, isin, headers, page=1):
            calls.append((url,page))
            return ([{"news_id":f"new{page}"}] if page < 3 else [{"news_id":"old"}],5,None)
        with mock.patch.object(fetch_company_filings,"fetch_page",side_effect=fetch):
            result = fetch_company_filings.fetch_filings({"Symbol":"ABC","ISIN":"INE000000001"},existing)
        self.assertEqual(len(calls),6)
        self.assertTrue(result["refresh_complete"])
        self.assertEqual({r["news_id"] for r in result["current"]}, {"new1"})
        for endpoint in ("company_filings","lodr"):
            self.assertEqual(result["history"]["fetch_status"][endpoint]["pages_fetched"],3)
            self.assertEqual({r["news_id"] for r in result["history"]["filings"] if r["source_endpoint"]==endpoint}, {"old","new1","new2"})

    def test_mixed_overlap_page_does_not_hide_the_next_unseen_page(self):
        known = {"news_id":"old","source_endpoint":"lodr"}
        existing = {"lodr_backfill_complete":True,"filings":[known]}
        with mock.patch.object(fetch_company_filings,"fetch_page",side_effect=[
            ([],1,None), ([{"news_id":"new"},known],3,None),
            ([{"news_id":"missed"}],3,None), ([known],3,None),
        ]) as pages:
            result = fetch_company_filings.fetch_filings({"Symbol":"ABC","ISIN":"INE000000001"},existing)
        self.assertEqual(pages.call_count,4)
        self.assertIn("missed", {r["news_id"] for r in result["history"]["filings"]})

    def test_revision_retention_and_non_conflicting_enrichment(self):
        old = {"news_id":"same","caption":"Dividend approved","news_body":"Approved payout","source_endpoint":"lodr"}
        revised = {**old,"caption":"Dividend rejected","news_body":"Rejected payout"}
        retained = fetch_company_filings.dedupe_filings([old,revised,revised])
        self.assertEqual(len(retained),2)
        self.assertEqual({r["caption"] for r in retained},{old["caption"],revised["caption"]})
        enriched = fetch_company_filings.dedupe_filings([{"news_id":"same","caption":"Dividend"},
                    {"news_id":"same","caption":"Dividend","news_body":"Full body","file_url":"https://example.com/a.pdf"}])
        self.assertEqual(len(enriched),1)
        self.assertEqual(enriched[0]["news_body"],"Full body")

    def test_failed_refresh_preserves_success_time_and_retries_past_cached_first_page(self):
        existing = {"lodr_backfill_complete":True,
                    "fetch_status":{"lodr":{"last_success_at":"previous","refresh_complete":True}},
                    "filings":[{"news_id":"old","source_endpoint":"lodr"}]}
        with mock.patch.object(fetch_company_filings,"fetch_page",side_effect=[
            ([],1,None), ([{"news_id":"new"}],3,None), (None,None,"timeout"),
        ]):
            failed = fetch_company_filings.fetch_filings({"Symbol":"ABC","ISIN":"INE000000001"},existing)
        status = failed["history"]["fetch_status"]["lodr"]
        self.assertFalse(failed["refresh_complete"])
        self.assertEqual(status["last_success_at"],"previous")
        self.assertEqual(status["pages_fetched"],1)
        self.assertEqual(status["error"],"timeout")
        with mock.patch.object(fetch_company_filings,"fetch_page",side_effect=[
            ([],1,None), ([{"news_id":"new"}],3,None),
            ([{"news_id":"missed"}],3,None), ([{"news_id":"old"}],3,None),
        ]) as pages:
            retried = fetch_company_filings.fetch_filings({"Symbol":"ABC","ISIN":"INE000000001"},failed["history"])
        self.assertEqual(pages.call_count,4)
        self.assertTrue(retried["refresh_complete"])
        self.assertIn("missed",{r["news_id"] for r in retried["history"]["filings"]})

    def test_failed_endpoints_retain_history_without_claiming_fresh_success(self):
        statuses = {endpoint:{"last_success_at":"previous","refresh_complete":True}
                    for endpoint in ("company_filings","lodr")}
        existing = {"lodr_backfill_complete":True,"filings":[{"news_id":"old"}],"fetch_status":statuses}
        with mock.patch.object(fetch_company_filings,"fetch_page",return_value=(None,None,"offline")):
            result = fetch_company_filings.fetch_filings({"Symbol":"ABC","ISIN":"INE000000001"},existing)
        self.assertEqual(result["status"],"error")
        self.assertFalse(result["refresh_complete"])
        self.assertEqual(result["history"]["filings"],existing["filings"])
        for endpoint in statuses:
            status = result["history"]["fetch_status"][endpoint]
            self.assertEqual(status["last_success_at"],"previous")
            self.assertEqual(status["pages_fetched"],0)
            self.assertFalse(status["refresh_complete"])
            self.assertTrue(status["last_attempt_at"])

    def test_failed_backfill_remains_pending_for_the_next_run(self):
        with mock.patch.object(fetch_company_filings, "fetch_page", side_effect=[
            ([], 1, None), ([{"news_id": "one"}], 2, None), (None, None, "timeout"),
        ]):
            result = fetch_company_filings.fetch_filings({"Symbol": "ABC", "ISIN": "INE000000001"})
        self.assertFalse(result["history"]["lodr_backfill_complete"])
        self.assertEqual(result["error"], "timeout")

    def test_publishes_persistent_cache_as_a_flat_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            save_json(root / "filing_history_data" / "filing_history.json", {
                "updated_at": "2026-09-25T10:00:00Z",
                "symbols": {"ABC": {"isin": "INE000000001", "lodr_backfill_complete": True, "fetch_status":{"lodr":{"refresh_complete":False,"last_success_at":"previous"}}, "filings": [{"news_id": "one"}]}},
            })
            with mock.patch.object(build_filing_history_artifact, "BASE_DIR", str(root)):
                self.assertEqual(build_filing_history_artifact.main(), 0)
            payload = load_json(root / "filing_history.json")
        self.assertEqual(payload["coverage"]["lodr_backfill_complete"], 1)
        self.assertEqual(payload["records"][0]["symbol"], "ABC")
        self.assertFalse(payload["records"][0]["fetch_status"]["lodr"]["refresh_complete"])
        self.assertEqual(payload["records"][0]["fetch_status"]["lodr"]["last_success_at"],"previous")

    def test_checkpoint_records_completed_and_pending_symbols(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "filing_history_data" / "filing_history.json"
            path.parent.mkdir()
            with mock.patch.object(fetch_company_filings, "HISTORY_FILE", str(path)):
                fetch_company_filings._save_history({
                    "DONE": {"lodr_backfill_complete": True},
                    "PENDING": {"lodr_backfill_complete": False},
                })
            payload = load_json(path)
        self.assertEqual(payload["coverage"], {"symbols": 2, "lodr_backfill_complete": 1, "lodr_backfill_pending": 1})

    def test_completed_cache_skips_batch_checkpoints_but_pending_cache_does_not(self):
        self.assertFalse(fetch_company_filings.has_pending_backfill(
            {"ABC": {"lodr_backfill_complete": True}}, {"ABC"}
        ))
        self.assertTrue(fetch_company_filings.has_pending_backfill(
            {"ABC": {"lodr_backfill_complete": False}}, {"ABC"}
        ))
        self.assertTrue(fetch_company_filings.has_pending_backfill({}, {"ABC"}))
