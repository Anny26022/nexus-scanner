"""Offline checks for incremental refresh and adaptive requests."""
import asyncio
import gzip
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
import export_tijori_overviews as exporter


class ExportTests(unittest.IsolatedAsyncioTestCase):
    async def request_sequence(self, responses, total, stopped=False):
        clock = [0.0]
        sleep = asyncio.sleep
        async def advance(delay):
            clock[0] += delay
            await sleep(0)
        async def handler(request):
            status, headers = responses.pop(0)
            return httpx.Response(status, headers=headers, text='ok')
        fake_time = SimpleNamespace(monotonic=lambda: clock[0], time=lambda: 0)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            fetcher = exporter.Fetcher(client, 8, 8)
            with patch.object(exporter, 'time', fake_time), patch.object(exporter.asyncio, 'sleep', advance):
                for _ in range(total):
                    if stopped:
                        with self.assertRaises(httpx.HTTPStatusError):
                            await fetcher.request(exporter.BASE + '/company/test/')
                        with self.assertRaisesRegex(RuntimeError, 'collection_stopped'):
                            await fetcher.request(exporter.BASE + '/company/test/')
                    else:
                        await fetcher.request(exporter.BASE + '/company/test/')
            return fetcher, clock[0]

    async def test_successes_gradually_raise_limits(self):
        fetcher, _ = await self.request_sequence([(200, {})] * 20, 20)
        self.assertEqual((fetcher.capacity, fetcher.rate), (3, 3))

    async def test_rate_limit_honors_retry_after_and_recovers(self):
        fetcher, elapsed = await self.request_sequence([(429, {'Retry-After': '45'}), (200, {})], 1)
        self.assertEqual(fetcher.requests, 2)
        self.assertEqual((fetcher.capacity, fetcher.rate), (1, 1))
        self.assertGreaterEqual(elapsed, 45)

    async def test_http_date_retry_after_is_honored(self):
        _, elapsed = await self.request_sequence([(429, {'Retry-After': 'Thu, 01 Jan 1970 00:01:00 GMT'}), (200, {})], 1)
        self.assertGreaterEqual(elapsed, 60)

    async def test_three_rate_limits_stop_further_requests(self):
        fetcher, _ = await self.request_sequence([(429, {})] * 3, 1, stopped=True)
        self.assertTrue(fetcher.stopped)
        self.assertEqual(fetcher.requests, 3)

    async def test_server_error_backs_off_then_recovers(self):
        fetcher, elapsed = await self.request_sequence([(503, {}), (200, {})], 1)
        self.assertEqual(fetcher.requests, 2)
        self.assertGreaterEqual(elapsed, 2)

    async def run_refresh(self, status, compressed=False, new_stock=False, candidate=False, recovered=False, last_modified=False, sitemap_status=200, cached_sitemap=False, new_unmapped=False, bad_sitemap=False):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            url = exporter.BASE + '/company/test/'
            old = {'symbol': 'TEST', 'name': 'Test', 'status': 'available', 'sourceUrl': url,
                   'sourceSymbol': 'TEST', 'fetchedAt': 'old', 'etag': 'v1',
                   'memory_overview': {'the_read': ['saved'], 'what_to_watch': []}}
            if last_modified:
                old.pop('etag')
                old['lastModified'] = 'Tue, 06 Oct 2026 00:00:00 GMT'
            if cached_sitemap:
                (root / 'sitemap.xml').write_text(f'<urlset><url><loc>{url}</loc></url></urlset>')
            if candidate:
                old = {'symbol': 'TEST', 'name': 'Test', 'status': 'extraction_error', 'candidateUrl': url}
            (root / 'universe.json').write_text(json.dumps({'manifest': {'sessionDate': '2026-10-06', 'revision': 'r'}, 'stocks': [{'symbol': 'TEST', 'name': 'Test'}]}))
            if compressed:
                (root / 'tijori-overviews.json.gz').write_bytes(gzip.compress(json.dumps({'records': [old]}).encode()))
            else:
                (root / 'responses.jsonl').write_text(json.dumps(old) + '\n')
            public = root / 'public/data'
            public.mkdir(parents=True)
            stocks = [{'symbol': 'TEST', 'name': 'Test'}]
            if new_stock:
                stocks.append({'symbol': 'NEW', 'name': 'Other'})
            (public / 'current.json').write_text(json.dumps({'sessionDate': '2026-10-07', 'revision': 'new', 'datasetUrl': '/data/stocks.json', 'totalStocks': len(stocks)}))
            (public / 'stocks.json').write_text(json.dumps({'stocks': stocks}))
            calls = []
            async def handler(request):
                calls.append(request)
                if request.url.path == '/sitemap.xml':
                    xml = f'<urlset><url><loc>{url}</loc><lastmod>2026-10-06</lastmod></url><url><loc>{exporter.BASE}/company/other/</loc><lastmod>2026-10-05</lastmod></url></urlset>'
                    return httpx.Response(sitemap_status, text='<html>Not a sitemap</html>' if bad_sitemap else xml if sitemap_status == 200 else 'unavailable')
                if request.url.path == '/company/other/':
                    payload = {'symbol': 'OTHER' if new_unmapped else 'NEW', 'company_id': 2, 'memory_overview': {'the_read': ['new listing'], 'what_to_watch': []}}
                    return httpx.Response(200, text='<script id="company_details_data">' + json.dumps(payload) + '</script>')
                if request.url.path == '/api/v1/ind/company_search/':
                    return httpx.Response(200, json=[])
                if last_modified:
                    return httpx.Response(304 if request.headers.get('If-Modified-Since') == old['lastModified'] else 412)
                if recovered:
                    payload = {'symbol': 'TEST', 'memory_overview': {'the_read': ['recovered'], 'what_to_watch': []}}
                    return httpx.Response(200, text='<script id="company_details_data">' + json.dumps(payload) + '</script>')
                return httpx.Response(status)
            original_client = httpx.AsyncClient
            def client(**options):
                return original_client(transport=httpx.MockTransport(handler), **options)
            argv = ['export', '--output', str(root), '--sitemap', str(root / 'sitemap.xml'), '--refresh', '--public-root', str(root / 'public')]
            with patch('sys.argv', argv), patch.object(exporter.httpx, 'AsyncClient', client):
                await exporter.main()
            if bad_sitemap and cached_sitemap:
                self.assertEqual((root / 'sitemap.xml').read_text(), f'<urlset><url><loc>{url}</loc></url></urlset>')
            return json.loads((root / 'tijori-overviews.json').read_text()), calls

    async def test_304_reuses_content_and_sends_etag(self):
        data, calls = await self.run_refresh(304)
        self.assertEqual(calls[-1].headers['If-None-Match'], 'v1')
        self.assertEqual(data['records'][0]['fetchedAt'], 'old')
        self.assertEqual(data['records'][0]['memory_overview']['the_read'], ['saved'])
        self.assertIn('checkedAt', data['records'][0])

    async def test_last_modified_validator_reuses_cached_report(self):
        data, calls = await self.run_refresh(304, last_modified=True)
        self.assertEqual(calls[-1].headers['If-Modified-Since'], 'Tue, 06 Oct 2026 00:00:00 GMT')
        self.assertNotIn('If-None-Match', calls[-1].headers)
        self.assertEqual(data['records'][0]['fetchedAt'], 'old')

    async def test_sitemap_failure_still_refreshes_saved_urls(self):
        for cached in (False, True):
            with self.subTest(cached_sitemap=cached):
                data, calls = await self.run_refresh(304, compressed=True, sitemap_status=403, cached_sitemap=cached)
                self.assertEqual(data['records'][0]['status'], 'available')
                self.assertIn('checkedAt', data['records'][0])
                self.assertTrue(data['metadata']['discoveryError'])
                self.assertFalse(data['metadata']['complete'])
                self.assertEqual(calls[-1].url.path, '/company/test/')

    async def test_non_sitemap_response_preserves_cached_sitemap(self):
        data, _ = await self.run_refresh(304, cached_sitemap=True, bad_sitemap=True)
        self.assertEqual(data['records'][0]['status'], 'available')
        self.assertIn('not a urlset', data['metadata']['discoveryError'])
        self.assertFalse(data['metadata']['complete'])

    async def test_unmapped_symbol_keeps_export_incomplete(self):
        data, _ = await self.run_refresh(304, new_stock=True, new_unmapped=True)
        self.assertEqual(data['records'][1]['status'], 'unmapped')
        self.assertFalse(data['metadata']['complete'])

    async def test_fresh_checkout_reuses_compressed_cache(self):
        data, calls = await self.run_refresh(304, compressed=True)
        self.assertEqual(calls[-1].headers['If-None-Match'], 'v1')
        self.assertEqual(data['records'][0]['memory_overview']['the_read'], ['saved'])

    async def test_refresh_uses_latest_universe_including_new_listings(self):
        data, _ = await self.run_refresh(304, compressed=True, new_stock=True)
        self.assertEqual(data['metadata']['universeRevision'], 'new')
        self.assertEqual({r['symbol'] for r in data['records']}, {'TEST', 'NEW'})
        self.assertTrue(all(r['status'] == 'available' for r in data['records']))

    async def test_visible_html_snapshot_and_watch_are_extracted(self):
        html = """<p class="symbol">AMAGI</p>
        <script id="companyId">59220</script>
        <script id="memoryOverviewKeyEvents">[{"label":"Listed"}]</script>
        <div id="company_memory_overview" data-company="Amagi Media Labs Ltd.">
          <span class="memory_card__updated_date">15 Sep 2026</span>
          <ul class="memory_the_read__list"><li>Cloud <b>SaaS</b> &amp; video.</li></ul>
          <ul class="memory_what_to_watch__list"><li>
            <span class="memory_watch__title">Margins</span>
            <span class="memory_watch__window">Next quarter</span>
            <div class="memory_watch__body">Watch <b>cash</b> conversion.</div>
          </li></ul>
        </div>"""
        data = exporter.parse_company(html, exporter.BASE + '/company/amagi/')
        self.assertEqual(data['symbol'], 'AMAGI')
        self.assertEqual(data['company_id'], 59220)
        self.assertEqual(data['memory_overview']['as_of'], '2026-09-15')
        self.assertEqual(data['memory_overview']['the_read'], ['Cloud SaaS & video.'])
        self.assertEqual(data['memory_overview']['what_to_watch'], [{'title': 'Margins', 'window': 'Next quarter', 'body': 'Watch cash conversion.'}])
        self.assertEqual(data['memory_overview']['key_events'], [{'label': 'Listed'}])

    async def test_unparseable_visible_date_is_null(self):
        html = '<p class="symbol">TEST</p><div id="company_memory_overview"><span class="memory_card__updated_date">Yesterday</span></div>'
        self.assertIsNone(exporter.parse_company(html, exporter.BASE)['memory_overview']['as_of'])

    async def test_malformed_optional_scripts_preserve_extraction_url(self):
        url = exporter.BASE + '/company/test/'
        for identifier in ('companyId', 'memoryOverviewKeyEvents'):
            html = f'<p class="symbol">TEST</p><div id="company_memory_overview"></div><script id="{identifier}">invalid</script>'
            with self.subTest(identifier=identifier):
                with self.assertRaises(exporter.ExtractionError) as caught:
                    exporter.parse_company(html, url)
                self.assertEqual(caught.exception.url, url)
                self.assertIn(identifier, str(caught.exception))

    async def test_visible_symbol_without_overview_is_not_an_extraction_error(self):
        data = exporter.parse_company('<p class="symbol">TEST</p>', exporter.BASE)
        self.assertEqual(data['symbol'], 'TEST')
        self.assertIsNone(data['memory_overview'])

    async def test_publication_is_symbol_keyed_and_revision_stable(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            row = {'symbol': 'TEST', 'name': 'Test', 'status': 'available', 'sourceUrl': 'https://source', 'etag': 'private', 'memory_overview': {'as_of': '2026-10-06', 'the_read': ['saved'], 'what_to_watch': []}}
            meta = {'exportedAt': 'first', 'universeSessionDate': '2026-10-06', 'universeRevision': 'r'}
            exporter.publish(root, [row, {'symbol': 'MISSING', 'status': 'error'}], meta)
            manifest_path = root / 'data/tijori/current.json'
            first = json.loads(manifest_path.read_text())
            path = root / first['datasetUrl'].lstrip('/')
            data = json.loads(gzip.decompress(path.read_bytes()))
            self.assertEqual(set(data), {'TEST'})
            self.assertNotIn('etag', data['TEST'])
            self.assertEqual(first['reportCount'], 1)
            exporter.publish(root, [row], {**meta, 'exportedAt': 'second'})
            second = json.loads(manifest_path.read_text())
            self.assertEqual(first['revision'], second['revision'])
            row['memory_overview']['the_read'] = ['changed']
            exporter.publish(root, [row], meta)
            self.assertNotEqual(first['revision'], json.loads(manifest_path.read_text())['revision'])
            self.assertTrue(path.exists())

    async def test_empty_publication_preserves_manifest(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'data/tijori/current.json'
            path.parent.mkdir(parents=True)
            path.write_text('existing')
            exporter.publish(root, [], {})
            self.assertEqual(path.read_text(), 'existing')

    async def test_missing_embedded_data_is_retryable_and_preserves_report(self):
        data, calls = await self.run_refresh(200)
        row = data['records'][0]
        self.assertEqual(row['status'], 'available')
        self.assertEqual(row['memory_overview']['the_read'], ['saved'])
        self.assertEqual(row['refreshError']['status'], 'extraction_error')
        self.assertEqual(row['refreshError']['candidateUrl'], str(calls[-1].url))
        self.assertFalse(data['metadata']['complete'])

    async def test_failed_extraction_retries_candidate_and_recovers(self):
        data, calls = await self.run_refresh(200, candidate=True)
        self.assertEqual(data['records'][0]['status'], 'extraction_error')
        self.assertFalse(data['metadata']['complete'])
        data, calls = await self.run_refresh(200, candidate=True, recovered=True)
        self.assertEqual(len(calls), 2)  # Sitemap and the saved candidate; no search.
        self.assertEqual(data['records'][0]['status'], 'available')
        self.assertEqual(data['records'][0]['memory_overview']['the_read'], ['recovered'])

    async def test_failed_refresh_keeps_previous_report(self):
        data, _ = await self.run_refresh(403)
        self.assertEqual(data['records'][0]['memory_overview']['the_read'], ['saved'])
        self.assertEqual(data['records'][0]['refreshError']['httpStatus'], 403)
        self.assertFalse(data['metadata']['complete'])


if __name__ == '__main__':
    unittest.main()
