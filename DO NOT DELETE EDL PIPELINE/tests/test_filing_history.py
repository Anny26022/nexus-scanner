import sys
import copy
import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
import pipeline_utils
from filing_classification import classify_filings
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
    def test_classifier_matches_frozen_version_contract(self):
        fixture = load_json(ROOT / 'tests/fixtures/filing_classification_contract.json')
        self.assertEqual(build_filing_history_artifact.VERSION, fixture['version'],
                         'Review and regenerate the frozen contract for the new classifier VERSION.')
        outputs = [build_filing_history_artifact.classify_filing(row) for row in fixture['filings']]
        digest = hashlib.sha256(json.dumps(outputs, sort_keys=True, ensure_ascii=False,
                                          separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(digest, fixture['classification_sha256'],
                         'Classification behavior changed: bump VERSION before updating the frozen contract.')

    def test_unchanged_company_skips_normalization_and_classification(self):
        filings = [
            {'news_date': '2026-10-07', 'caption': 'Dividend approved', 'file_url': 'https://example.com/a.pdf'},
            {'news_date': '2026-10-07', 'caption': 'Dividend approved', 'file_url': 'https://example.com/a.pdf',
             'descriptor': 'Dividend', 'source_endpoint': 'lodr'},
        ]
        expected = classify_filings(copy.deepcopy(filings))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'])
            stats = Counter()
            with mock.patch.object(build_filing_history_artifact, 'classify_filings', side_effect=AssertionError('normalized again')):
                observed = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'], stats)
            self.assertEqual(observed, expected)
            self.assertEqual(stats['unchanged_companies'], 1)
            self.assertEqual(stats['reused_filings'], 1)
            self.assertEqual(stats['fresh_filings'], 0)
            cached = load_json(path)
            self.assertIsInstance(cached['filings'][0]['classification'], str)
            self.assertEqual(len(cached['entries']), 1)

    def test_changed_company_reuses_old_classifications_and_updates_identity(self):
        filings = [{'news_date': '2026-10-07', 'caption': 'Dividend approved', 'file_url': 'https://example.com/a.pdf'}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            original = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'])
            # A metadata revision changes identity/output without changing topic evidence.
            filings[0]['news_date'] = '2026-10-08'
            filings.append({'caption': 'Board approves stock split', 'news_id': 'new'})
            stats = Counter()
            with mock.patch.object(build_filing_history_artifact, 'classify_filing', wraps=build_filing_history_artifact.classify_filing) as classify:
                observed = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'], stats)
            self.assertEqual(observed, classify_filings(copy.deepcopy(filings)))
            self.assertNotEqual(observed[0]['filingId'], original[0]['filingId'])
            self.assertEqual(classify.call_count, 1)
            self.assertEqual(stats['reused_filings'], 1)
            self.assertEqual(stats['fresh_filings'], 1)

    def test_entry_cache_migrates_only_when_legacy_rules_match(self):
        filings = [{'caption': 'Dividend approved'}]
        expected = classify_filings(copy.deepcopy(filings))
        entries = {build_filing_history_artifact.classification_key(row): row['classification'] for row in expected}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            save_json(path, {'rules': ['old source hash'], 'entries': entries})
            with mock.patch.object(build_filing_history_artifact, 'classify_filing', side_effect=AssertionError('reclassified migration')):
                self.assertEqual(build_filing_history_artifact.classify_cached(
                    copy.deepcopy(filings), path, ['semantic rules'], legacy_rules=['old source hash']), expected)
            stats = Counter()
            build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['changed rules'], stats)
            self.assertEqual(stats['invalidated_companies'], 1)
            self.assertEqual(stats['fresh_filings'], 1)

    def test_semantic_contract_ignores_python_hash_but_tracks_rules(self):
        with mock.patch.object(build_filing_history_artifact, 'file_fingerprint', return_value='labels') as fingerprint:
            original = build_filing_history_artifact.classification_rules()
            fingerprint.assert_called_once_with(ROOT / 'filing_source_labels.json')
            with mock.patch.object(build_filing_history_artifact, 'VERSION', build_filing_history_artifact.VERSION + 1):
                self.assertNotEqual(build_filing_history_artifact.classification_rules(), original)
            with mock.patch.object(build_filing_history_artifact, 'CACHE_VERSION', build_filing_history_artifact.CACHE_VERSION + 1):
                self.assertNotEqual(build_filing_history_artifact.classification_rules(), original)
        with mock.patch.object(build_filing_history_artifact, 'file_fingerprint', return_value='new labels'):
            self.assertNotEqual(build_filing_history_artifact.classification_rules(), original)

    def test_malformed_company_checkpoint_rebuilds_from_raw_history(self):
        filings = [{'caption': 'Company wins supply order worth Rs 200 crore'}]
        expected = classify_filings(copy.deepcopy(filings))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'])
            saved = load_json(path)
            del saved['filings'][0]['classification']
            save_json(path, saved)
            self.assertEqual(build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules']), expected)
            saved = load_json(path)
            saved['entries'] = {}
            save_json(path, saved)
            stats = Counter()
            self.assertEqual(build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'], stats), expected)
            self.assertEqual(stats['fresh_filings'], 1)

    def test_boolean_document_indexes_rebuild_without_cross_filing_metadata(self):
        filings = [
            {'news_id': 'first', 'caption': 'Dividend approved',
             'documentExtraction': {'status': 'failed', 'attemptedAt': 'first'}},
            {'news_id': 'second', 'caption': 'Stock split approved',
             'documentExtraction': {'status': 'failed', 'attemptedAt': 'second'}},
        ]
        expected = classify_filings(copy.deepcopy(filings))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'])
            checkpoint = load_json(path)
            for malformed in (True, False):
                with self.subTest(source=malformed):
                    corrupted = copy.deepcopy(checkpoint)
                    # true aliases index 1 and false aliases index 0; both would
                    # pass a loose integer check and copy the wrong PDF metadata.
                    corrupted['document_sources'] = [True, 1] if malformed else [0, False]
                    save_json(path, corrupted)
                    stats = Counter()
                    observed = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'], stats)
                    self.assertEqual(observed, expected)
                    self.assertEqual(stats['rebuilt_companies'], 1)
                    self.assertEqual(stats['unchanged_companies'], 0)
                    self.assertEqual(load_json(path)['document_sources'], [0, 1])

    def test_cache_ignores_attempt_time_and_survives_empty_inputs_or_write_errors(self):
        filings = [{'caption': 'Dividend approved', 'documentExtraction': {
            'status': 'failed', 'attemptedAt': 'old', 'pages': []}}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            expected = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'])
            saved = path.read_bytes()
            self.assertEqual(build_filing_history_artifact.classify_cached([], path, ['rules']), [])
            self.assertEqual(path.read_bytes(), saved)
            revised = copy.deepcopy(filings)
            revised[0]['documentExtraction']['attemptedAt'] = 'new'
            revised[0]['documentExtraction']['error'] = 'TimeoutExpired'
            stats = Counter()
            with mock.patch.object(build_filing_history_artifact, 'classify_filing') as classify, \
                    mock.patch.object(build_filing_history_artifact, 'classify_filings', side_effect=AssertionError('retry normalized history')):
                observed = build_filing_history_artifact.classify_cached(revised, path, ['rules'], stats)
                self.assertEqual(observed[0]['classification'], expected[0]['classification'])
                self.assertEqual(observed[0]['documentExtraction']['attemptedAt'], 'new')
                classify.assert_not_called()
            self.assertEqual(observed, classify_filings(copy.deepcopy(revised)))
            self.assertEqual(stats['unchanged_companies'], 1)
            self.assertEqual(stats['rebuilt_companies'], 0)
            self.assertEqual(path.read_bytes(), saved)
            with mock.patch.object(build_filing_history_artifact, 'save_json', side_effect=OSError('disk full')):
                observed = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['new rules'])
                self.assertEqual(observed, expected)
            self.assertEqual(path.read_bytes(), saved)

    def test_retry_metadata_uses_first_merged_observation_and_new_evidence_rebuilds(self):
        filings = [
            {'caption': 'Dividend approved'},
            {'caption': 'Regulation 30 disclosure', 'file_url': 'https://example.com/a.pdf',
             'source_endpoint': 'lodr', 'documentExtraction': {'status': 'failed', 'attemptedAt': 'first'}},
            {'caption': 'Regulation 30 disclosure', 'file_url': 'https://example.com/a.pdf',
             'source_endpoint': 'company', 'documentExtraction': {'status': 'failed', 'attemptedAt': 'second'}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'])
            filings[1]['documentExtraction']['attemptedAt'] = 'new first'
            filings[2]['documentExtraction']['attemptedAt'] = 'new second'
            with mock.patch.object(build_filing_history_artifact, 'classify_filings', side_effect=AssertionError('retry normalized history')):
                observed = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'])
            self.assertEqual(observed, classify_filings(copy.deepcopy(filings)))
            self.assertEqual(observed[1]['documentExtraction']['attemptedAt'], 'new first')
            filings[1]['documentExtraction'] = {'status': 'extracted', 'pages': [
                {'page': 1, 'text': 'Company wins supply order worth Rs 200 crore'}]}
            stats = Counter()
            observed = build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules'], stats)
            self.assertEqual(observed, classify_filings(copy.deepcopy(filings)))
            self.assertEqual(stats['rebuilt_companies'], 1)
            self.assertEqual(stats['fresh_filings'], 1)

    def test_classification_cache_preserves_merged_labels_and_invalidates_inputs(self):
        filings = [
            {'news_id': 'one', 'caption': 'Dividend approved', 'descriptor': 'Dividend', 'file_url': 'https://example.com/a.pdf'},
            {'news_id': 'two', 'caption': 'Dividend approved', 'descriptor': 'Board Meeting', 'file_url': 'https://example.com/a.pdf'},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cache.json'
            expected = classify_filings(copy.deepcopy(filings))
            self.assertEqual(build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules']), expected)
            with mock.patch.object(build_filing_history_artifact, 'classify_filing', wraps=build_filing_history_artifact.classify_filing) as classify:
                self.assertEqual(build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules']), expected)
                classify.assert_not_called()
                for change in ('caption', 'documentExtraction', 'descriptor'):
                    revised = copy.deepcopy(filings)
                    revised[0][change] = {'status': 'ok', 'pages': ['Dividend approved']} if change == 'documentExtraction' else 'Results announced'
                    self.assertEqual(build_filing_history_artifact.classify_cached(revised, path, ['rules']), classify_filings(copy.deepcopy(revised)))
                self.assertGreaterEqual(classify.call_count, 3)
                classify.reset_mock()
                build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['new rules'])
                classify.assert_called()
            path.write_text('{broken')
            self.assertEqual(build_filing_history_artifact.classify_cached(copy.deepcopy(filings), path, ['rules']), expected)

    def test_http_sessions_are_reused_per_thread_not_shared(self):
        barrier = threading.Barrier(2)
        def worker():
            first = pipeline_utils.http_session()
            barrier.wait(timeout=5)
            self.assertIs(first, pipeline_utils.http_session())
            return first
        with ThreadPoolExecutor(max_workers=2) as pool:
            one = pool.submit(worker)
            two = pool.submit(worker)
            self.assertIsNot(one.result(), two.result())

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
        self.assertEqual({(r["news_id"], r["source_endpoint"]) for r in result["current"]},
                         {("new1", "company_filings"), ("new1", "lodr")})
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

    def test_idless_url_enrichment_merges_but_conflicting_urls_remain_versions(self):
        bare = {"news_date":"2026-10-06", "descriptor":"Dividend", "caption":"Dividend approved",
                "source_endpoint":"lodr"}
        enriched = {**bare,"file_url":"https://example.com/a.pdf"}
        other = {**bare,"file_url":"https://example.com/b.pdf"}
        for items in ([bare,enriched], [enriched,bare]):
            with self.subTest(items=items):
                records = fetch_company_filings.dedupe_filings(items)
                self.assertEqual(len(records),1)
                self.assertEqual(records[0]["file_url"], enriched["file_url"])
        versions = fetch_company_filings.dedupe_filings([bare,enriched,other])
        self.assertEqual({record["file_url"] for record in versions}, {enriched["file_url"],other["file_url"]})
        self.assertEqual(len(versions),2)
        self.assertEqual(fetch_company_filings.dedupe_filings([{"file_url":enriched["file_url"]}]),
                         [{"file_url":enriched["file_url"]}])

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
                "symbols": {"ABC": {"isin": "INE000000001", "lodr_backfill_complete": True, "fetch_status":{"lodr":{"refresh_complete":False,"last_success_at":"previous"}}, "filings": [{"news_id": "one", "caption": "Dividend approved"}]}},
            })
            with mock.patch.object(build_filing_history_artifact, "BASE_DIR", str(root)):
                self.assertEqual(build_filing_history_artifact.main(), 0)
            payload = load_json(root / "filing_history.json")
            published = (root / 'filing_history.json').read_bytes()
            with mock.patch.object(build_filing_history_artifact, 'BASE_DIR', str(root)), \
                    mock.patch.object(build_filing_history_artifact, 'classify_filings', side_effect=AssertionError('reprocessed history')):
                self.assertEqual(build_filing_history_artifact.main(), 0)
            self.assertEqual((root / 'filing_history.json').read_bytes(), published)
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
