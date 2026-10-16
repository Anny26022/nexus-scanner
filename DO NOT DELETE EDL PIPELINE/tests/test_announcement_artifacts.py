import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build_chart_artifacts as builder
from announcement_artifacts import announcement_lookup, build_announcements
from filing_classification import classify_filings


def read(root, digest):
    return json.loads(gzip.decompress((root / (digest + '.json.gz')).read_bytes()))


def filing(day, identifier):
    return {'news_id': identifier, 'news_date': day, 'descriptor': 'Award of Order',
            'caption': f'Received commercial order {identifier}', 'news_body': 'Received a commercial purchase order.',
            'file_url': f'https://www.bseindia.com/{identifier}.pdf'}


class AnnouncementArtifactsTests(unittest.TestCase):
    def test_quotes_do_not_change_raw_or_preclassified_pages_but_revisions_do(self):
        for preclassified in (False, True):
            with self.subTest(preclassified=preclassified), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                rows = [filing('2025-01-01', 'old')]
                if preclassified:
                    rows = classify_filings(rows)
                rows[0].update(ltp=100, ch=2, pch=1)
                payload = {'updated_at': '2026-10-07', 'records': [{'symbol': 'TEST', 'filings': rows}]}
                first = build_announcements(payload, root, {'TEST'}, '2026-10-06')
                catalog = read(root, first)
                page, = catalog['symbols']['TEST']['years']['2025']
                detail, = read(root, page['details'])['records'].values()
                for field in ('ltp', 'ch', 'pch'):
                    self.assertNotIn(field, detail)
                self.assertEqual(rows[0]['ltp'], 100)
                rows[0].update(ltp=120, ch=-6.01, pch=-3.02)
                self.assertEqual(build_announcements(payload, root, {'TEST'}, '2026-10-06'), first)
                rows[0]['news_body'] += ' Corrected amount: Rs. 12 crore.'
                revised = read(root, build_announcements(payload, root, {'TEST'}, '2026-10-06'))
                self.assertNotEqual(revised['symbols']['TEST']['years']['2025'][0]['details'], page['details'])
                self.assertNotEqual(revised['symbols']['TEST']['years']['2025'][0]['summary'], page['summary'])

    def test_fetch_status_changes_release_metadata_without_rewriting_company_history(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            company = {'symbol': 'TEST', 'filings': [filing('2025-01-01', 'old')],
                       'fetch_status': {'lodr': {'last_attempt_at': '2026-10-06T12:00:00Z'}}}
            payload = {'updated_at': '2026-10-07', 'records': [company]}
            first = announcement_lookup(root, build_announcements(payload, root, {'TEST'}, '2026-10-06'))
            company['fetch_status']['lodr']['last_attempt_at'] = '2026-10-07T12:00:00Z'
            second = announcement_lookup(root, build_announcements(payload, root, {'TEST'}, '2026-10-06'))
            self.assertEqual(first['symbols']['TEST']['history'], second['symbols']['TEST']['history'])
            self.assertNotEqual(first['symbols']['TEST']['fetchStatus'], second['symbols']['TEST']['fetchStatus'])
            self.assertNotIn('fetchStatus', read(root, second['symbols']['TEST']['history']))

    def test_recent_index_includes_next_day_filings_without_changing_price_cutoff(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'all_stocks_fundamental_analysis.json').write_text(json.dumps([{'symbol': 'TEST', 'as_of_date': '2026-10-06'}]))
            payload = {'updated_at': '2026-10-07T12:00:00+05:30', 'records': [{'symbol': 'TEST', 'filings': [
                filing('2026-10-07T10:00:00+05:30', 'today'), filing('2026-10-08', 'future'), filing('2025-01-01', 'old')]}]}
            (root / 'filing_history.json').write_text(json.dumps(payload))
            with patch.object(builder, 'BASE_DIR', str(root)):
                self.assertEqual(builder.main(), 0)
            index = json.loads((root / 'chart_artifacts/index.json').read_text())
            objects = root / 'chart_artifacts/objects'
            chart = read(objects, index['chartObjects']['TEST'])
            self.assertNotIn('regulatoryAnnouncements', chart)
            self.assertNotIn('filingTaxonomy', chart)
            catalog = read(objects, index['announcements'])
            recent = read(objects, catalog['symbols']['TEST']['recent'])
            self.assertEqual([row['headline'] for row in recent['records']], ['Received commercial order today'])
            self.assertNotIn('classification', recent['records'][0])
            self.assertIn('2025', catalog['symbols']['TEST']['years'])
            self.assertEqual(read(objects, catalog['index'])['sinceLastClose'], '2026-10-06T15:30:00+05:30')
            detail = read(objects, recent['records'][0]['detailPage'])['records'][recent['records'][0]['id']]
            self.assertEqual(detail['news_body'], 'Received a commercial purchase order.')
            self.assertTrue(detail['classification']['events'])

    def test_year_pages_are_bounded_and_old_full_pages_are_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            rows = [filing(f'2025-01-01T{n // 60:02d}:{n % 60:02d}:00+05:30', str(n)) for n in range(201)]
            payload = {'updated_at': '2026-10-07', 'records': [{'symbol': 'TEST', 'filings': rows}]}
            first = read(root, build_announcements(payload, root, {'TEST'}, '2026-10-06'))
            pages = first['symbols']['TEST']['years']['2025']
            self.assertEqual([page['count'] for page in pages], [100, 100, 1])
            rows.append(filing('2025-12-31', 'new'))
            second = read(root, build_announcements(payload, root, {'TEST'}, '2026-10-06'))
            self.assertEqual(pages[:2], second['symbols']['TEST']['years']['2025'][:2])
            self.assertEqual(read(root, first['symbols']['TEST']['recent'])['records'], [])

    def test_no_candle_change_reuses_chart_across_sessions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            hashes = []
            for day in ('2026-10-06', '2026-10-07'):
                (root / 'all_stocks_fundamental_analysis.json').write_text(json.dumps([{'symbol': 'TEST', 'as_of_date': day}]))
                with patch.object(builder, 'BASE_DIR', str(root)):
                    builder.main()
                index = json.loads((root / 'chart_artifacts/index.json').read_text())
                hashes.append(index['chartObjects']['TEST'])
            self.assertEqual(hashes[0], hashes[1])

    def test_naive_dates_are_ist_and_non_universe_symbols_are_excluded(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            payload = {'updated_at': '2026-10-07T12:00:00', 'records': [
                {'symbol': 'TEST', 'filings': [filing('2026-10-07T10:00:00', 'ok'), filing('bad', 'bad')]},
                {'symbol': 'SME', 'filings': [filing('2026-10-07T10:00:00', 'sme')]}]}
            catalog = read(root, build_announcements(payload, root, {'TEST'}, '2026-10-06'))
            index = read(root, catalog['index'])
            self.assertEqual(len(index['records']), 1)
            self.assertEqual(index['records'][0]['publishedAt'], '2026-10-07T04:30:00+00:00')
            self.assertEqual(set(catalog['symbols']), {'TEST'})

    def test_input_order_does_not_change_objects(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            rows = [filing('2026-10-06', 'a'), filing('2026-10-07', 'b')]
            payload = {'updated_at': '2026-10-07T18:00:00+05:30', 'records': [{'symbol': 'TEST', 'filings': rows}]}
            first = build_announcements(payload, root, {'TEST'}, '2026-10-07')
            rows.reverse()
            self.assertEqual(first, build_announcements(payload, root, {'TEST'}, '2026-10-07'))
