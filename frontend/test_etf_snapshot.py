from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from etf_snapshot import build_etf_snapshot
from packed_snapshot import pack_snapshot
from test_packed_snapshot import decode_packed_snapshot
from fetch_etf_snapshot import COLUMNS, normalize


class EtfSnapshotTests(unittest.TestCase):
    def source(self, day='2026-10-23'):
        values = dict(symbol='NIFTYBEES', time=datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp(),
                      close=250, exchange='NSE', type='fund', subtype='etf', currency='INR',
                      description='Nifty ETF', asset_class='c05f85d35d1cd0be6ebb2af4be16e06a', expense_ratio=None)
        response = {'totalCount':1, 'data':[{'s':'NSE:NIFTYBEES', 'd':[values.get(field) for field in COLUMNS]}]}
        return normalize(response, '2026-10-23T16:00:00Z')

    def test_bulk_alignment_identity_and_missing_data(self):
        source = self.source()
        snapshot = build_etf_snapshot(source, '2026-10-23', 'a'*64)
        self.assertEqual(snapshot['totalStocks'], 1)
        self.assertIsNone(snapshot['stocks'][0]['etf']['expense_ratio'])
        self.assertEqual(snapshot['etfLabels']['asset_class'][source['records'][0]['asset_class']], 'Equity')
        self.assertEqual(decode_packed_snapshot(pack_snapshot(snapshot)), snapshot)

    def test_rejects_old_or_future_quotes_instead_of_relabelling(self):
        for day in ('2026-10-22', '2026-10-24'):
            with self.assertRaises(ValueError):
                build_etf_snapshot(self.source(day), '2026-10-23', 'a'*64)

    def test_rejects_partial_duplicate_and_foreign_listings(self):
        for response in (None, [], {'totalCount':1, 'data':[None]},
                         {'totalCount':1, 'data':[{'s':None}]},
                         {'totalCount':2, 'data':[{'s':'NSE:X', 'd':[]}]},
                         {'totalCount':1, 'data':[{'s':'BSE:X', 'd':[None]*len(COLUMNS)}]}):
            with self.assertRaises(ValueError):
                normalize(response, '2026-10-23T16:00:00Z')

    def test_source_failure_writes_an_empty_diagnostic_instead_of_reusing_old_data(self):
        import fetch_etf_snapshot as fetcher
        with patch.object(fetcher, 'post_json', side_effect=ValueError('offline')), patch.object(fetcher, 'save_json') as save:
            self.assertFalse(fetcher.main())
            self.assertEqual(save.call_args.args[1]['records'], [])

    def test_interrupted_optional_fetch_leaves_a_valid_empty_artifact(self):
        import fetch_etf_snapshot as fetcher
        with patch.object(fetcher, 'post_json', side_effect=KeyboardInterrupt), patch.object(fetcher, 'save_json') as save:
            with self.assertRaises(KeyboardInterrupt):
                fetcher.main()
            self.assertEqual(save.call_args.args[1]['records'], [])

    def test_publication_keeps_stock_history_but_does_not_archive_etfs(self):
        from publish_snapshot import publish
        from test_publish_snapshot import SnapshotPublicationTests
        with tempfile.TemporaryDirectory() as folder:
            root, output = Path(folder)/'inputs', Path(folder)/'data'
            root.mkdir()
            SnapshotPublicationTests().fixture(root)
            old = output/'revisions'/('b'*64)
            old.mkdir(parents=True)
            (old/'etfs.json.gz').write_bytes(b'old ETF snapshot')
            (old/'stocks.json.gz').write_bytes(b'preserved stock snapshot')
            (root/'etf_snapshot.json.gz').write_bytes(gzip.compress(json.dumps(self.source('2026-09-30')).encode()))
            with patch('publish_snapshot.list_presets', return_value=[]):
                manifest = publish(root, output)
            revision_dir = output/'revisions'/manifest['revision']
            self.assertEqual([row['symbol'] for row in json.loads((revision_dir/'stocks.json').read_text())['stocks']], ['TEST'])
            snapshot = decode_packed_snapshot(json.loads(gzip.decompress((revision_dir/'etfs.json.gz').read_bytes())))
            self.assertEqual(snapshot['assetType'], 'etf')
            self.assertEqual([row['symbol'] for row in snapshot['stocks']], ['NIFTYBEES'])
            self.assertFalse((output/'snapshots/etf').exists())
            self.assertTrue((output/'snapshots/2026-09-30.json.gz').exists())
            self.assertFalse((root/'.scanner_cache/revisions'/manifest['revision']/'etf_snapshot.json.gz').exists())
            self.assertFalse((old/'etfs.json.gz').exists())
            self.assertEqual((old/'stocks.json.gz').read_bytes(), b'preserved stock snapshot')

    def test_failed_release_keeps_the_previous_etf_snapshot(self):
        from publish_snapshot import publish
        from test_publish_snapshot import SnapshotPublicationTests
        with tempfile.TemporaryDirectory() as folder:
            root, output = Path(folder)/'inputs', Path(folder)/'data'
            root.mkdir()
            SnapshotPublicationTests().fixture(root)
            source = self.source('2026-09-30')
            path = root/'etf_snapshot.json.gz'
            path.write_bytes(gzip.compress(json.dumps(source).encode()))
            with patch('publish_snapshot.list_presets', return_value=[]):
                previous = publish(root, output)
                source['fetchedAt'] = '2026-10-23T17:00:00Z'
                path.write_bytes(gzip.compress(json.dumps(source).encode()))
                with patch('publish_snapshot.complete_release', side_effect=RuntimeError('upload failed')):
                    with self.assertRaisesRegex(RuntimeError, 'upload failed'):
                        publish(root, output)
            self.assertTrue((output/'revisions'/previous['revision']/'etfs.json.gz').exists())
            self.assertEqual(json.loads((output/'current.json').read_text())['revision'], previous['revision'])

    def test_unavailable_etf_input_does_not_block_stock_publication(self):
        from publish_snapshot import publish
        from test_publish_snapshot import SnapshotPublicationTests
        invalid = self.source('2026-09-30')
        invalid['records'][0]['expense_ratio'] = float('nan')
        inputs = [gzip.compress(json.dumps(source).encode())
                  for source in (self.source('2026-09-29'), invalid)] + [b'invalid gzip']
        for payload in inputs:
            with self.subTest(payload=payload[:20]), tempfile.TemporaryDirectory() as folder:
                root, output = Path(folder)/'inputs', Path(folder)/'data'
                root.mkdir()
                SnapshotPublicationTests().fixture(root)
                (root/'etf_snapshot.json.gz').write_bytes(payload)
                with patch('publish_snapshot.list_presets', return_value=[]):
                    manifest = publish(root, output)
                self.assertNotIn('etfDatasetUrl', manifest)
                self.assertTrue((output/'current.json').exists())
