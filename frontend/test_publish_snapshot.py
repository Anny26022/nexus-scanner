import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import hashlib

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from scanner_identity import checked_identity
import scanner_bridge as bridge
from publish_snapshot import publish
from scanner_cache import ScannerCache


class SnapshotPublicationTests(unittest.TestCase):
    def setUp(self):
        self.storage = patch.dict('os.environ', {'EDL_SCANNER_STORAGE':'local'}, clear=False)
        self.storage.start()

    def tearDown(self):
        self.storage.stop()

    def fixture(self, root, cap=5000):
        stocks=[{'symbol':'TEST','name':'Test','close':100,'open':99,'high':101,'low':98,'volume':200,'as_of_date':'2026-09-30',
                 'market_cap_crore':cap,'daily_rupee_turnover_50_cr':10,'circuit_limit':'20','listing_series':'EQ','index_memberships':[]}]
        files={'all_stocks_fundamental_analysis.json.gz':stocks,'market_breadth_v2.json.gz':{'records':[{'date':'2026-09-30'}]},
               'quarterly_financial_history.json.gz':{'records':[]},'ipo_screener.json.gz':{'records':[]}}
        for name,value in files.items():
            with gzip.open(root/name,'wt') as handle: json.dump(value,handle)
        charts=root/'chart_artifacts';charts.mkdir(exist_ok=True)
        (charts/'TEST.json.gz').write_bytes(gzip.compress(json.dumps({'symbol':'TEST','asOfDate':'2026-09-30'}).encode(),mtime=0))
        (charts/'index.json').write_text(json.dumps({'symbols':1,'asOfDate':'2026-09-30'}))
        (root/'ohlcv_data').mkdir(exist_ok=True)
        delivery = root/'delivery_history_data'; delivery.mkdir(exist_ok=True)
        (delivery/'2026-09-30.json').write_text(json.dumps({'date':'2026-09-30','records':[
            {'symbol':'TEST','date':'2026-09-30','delivery_percent':60.0}
        ]}))
        frame=pd.DataFrame({'Date':pd.bdate_range(end='2026-09-30',periods=60),'Open':199.,'High':201.,'Low':198.,'Close':200.,'Volume':100.})
        frame.to_csv(root/'ohlcv_data/TEST.csv',index=False)

    def test_published_atr_reuses_shared_wilder_initialization(self):
        from edl_pipeline.scanner.indicators import true_range, wilder_average
        for size in (13, 14, 60):
            with tempfile.TemporaryDirectory() as folder, patch('publish_snapshot.list_presets', return_value=[]):
                root = Path(folder) / 'edl'; root.mkdir()
                output = Path(folder) / 'public'; self.fixture(root)
                frame = pd.read_csv(root / 'ohlcv_data/TEST.csv').tail(size).reset_index(drop=True)
                frame.loc[0, 'High'] = 240.
                frame.to_csv(root / 'ohlcv_data/TEST.csv', index=False)
                manifest = publish(root, output)
                payload = json.loads((output / 'revisions' / manifest['revision'] / 'stocks.json').read_text())
                row = payload['stocks'][0]
                if size < 14:
                    self.assertIsNone(row['atr14'])
                else:
                    expected = wilder_average(true_range(frame), 14).iloc[-1]
                    self.assertAlmostEqual(row['atr14'], expected)
                    self.assertAlmostEqual(row['metrics']['atrPct14'], expected / 200 * 100)
                if size >= 20:
                    self.assertEqual(row['adr20Pct'], row['metrics']['adr20'])

    def test_same_session_correction_creates_new_revision_and_old_backend_stays_frozen(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            first=publish(root,output)
            self.fixture(root,cap=6000)
            second=publish(root,output)
            compressed=(output/'revisions'/second['revision']/'stocks.json.gz').read_bytes()
            self.assertEqual(gzip.decompress(compressed),(output/'revisions'/second['revision']/'stocks.json').read_bytes())
            self.assertEqual(second['datasetGzipUrl'],f"/data/revisions/{second['revision']}/stocks.json.gz")
            self.assertEqual(set(second['packs']),{'core','technical','fundamentals'})
            for key,value in checked_identity().items(): self.assertEqual(second[key],value)
            for name,descriptor in second['packs'].items():
                packed=(output/descriptor['url'].removeprefix('/data/')).read_bytes()
                self.assertEqual(descriptor['bytes'],len(packed),name)
                self.assertEqual(descriptor['sha256'],hashlib.sha256(packed).hexdigest(),name)
                raw=gzip.decompress(packed)
                self.assertEqual(descriptor['uncompressedBytes'],len(raw),name)
                self.assertEqual(descriptor['uncompressedSha256'],hashlib.sha256(raw).hexdigest(),name)
            self.assertNotEqual(first['revision'],second['revision'])
            self.assertEqual(json.loads((output/'current.json').read_text())['revision'],second['revision'])
            request={'asOfDate':'2026-09-30','universe':'mainboard','expressionTree':{'type':'group','operator':'all','children':[]},'datasetRevision':first['revision']}
            old=bridge.run(request,root,ScannerCache())
            new=bridge.run({**request,'datasetRevision':second['revision']},root,ScannerCache())
            self.assertEqual(old['rows'][0]['marketCapCrore'],5000)
            self.assertEqual(new['rows'][0]['marketCapCrore'],6000)
            self.assertTrue((root/'.scanner_cache/revisions'/second['revision']/'delivery_history_data/2026-09-30.json.gz').exists())

    def test_official_turnover_survives_publication_and_warm_cache(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            path=root/'ohlcv_data/TEST.csv'
            frame=pd.read_csv(path);frame['Turnover']=200_000_000.;frame.to_csv(path,index=False)
            first=publish(root,output)
            def metric(manifest):
                return json.loads((output/'revisions'/manifest['revision']/'stocks.json').read_text())['stocks'][0]['metrics']['turnover20']
            self.assertEqual(metric(first),20.)  # close * volume would be 0.001 Cr
            second=publish(root,output)
            self.assertEqual(metric(second),20.)
            self.assertEqual(first['revision'],second['revision'])
            restored=ScannerCache();restored.refresh(root/'.scanner_cache/revisions'/first['revision'])
            self.assertEqual(restored.frame(root,'TEST','2026-09-30')['Turnover'].iloc[-1],200_000_000.)
            # Correct a day outside every complete public turnover window.
            # Private arbitrary-window history must still receive a new revision.
            frame.loc[0,'Turnover']=190_000_000.;frame.to_csv(path,index=False)
            corrected=publish(root,output)
            self.assertEqual(metric(corrected),20.)
            self.assertNotEqual(second['revision'],corrected['revision'])
            frame.loc[frame.index[-1],'Turnover']=float('nan');frame.to_csv(path,index=False)
            self.assertIsNone(metric(publish(root,output)))

    def test_local_bridge_validates_identity_before_loading_data(self):
        request = {'asOfDate':'2026-09-30','universe':'mainboard','expressionTree':{'type':'group','operator':'all','children':[]},
                   'page':1,'pageSize':50,'datasetRevision':'a' * 64}
        # A valid-looking request targets a missing cached revision. Identity
        # rejection must win, proving the bridge does not attempt data access.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for key in ('engineVersion', 'conditionContractHash'):
                with patch('scanner_bridge._load_context') as load:
                    with self.assertRaisesRegex(ValueError, 'incompatible'):
                        bridge.run({**request, **checked_identity(), key: 'old'}, root=root)
                    load.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'revision is unavailable'):
                bridge.run({**request, **checked_identity()}, root=root)
        compatible_request = {key: value for key, value in request.items() if key != 'datasetRevision'}
        with patch('scanner_bridge._load_context', side_effect=RuntimeError('data loaded')):
            with self.assertRaisesRegex(RuntimeError, 'data loaded'):
                bridge.run({**compatible_request, **checked_identity()})

    def test_failure_does_not_replace_current_manifest(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            publish(root,output); original=(output/'current.json').read_bytes()
            (root/'ipo_screener.json.gz').write_bytes(b'not gzip')
            with self.assertRaises(OSError): publish(root,output)
            self.assertEqual((output/'current.json').read_bytes(),original)

    def test_private_pack_failure_does_not_promote_public_pointer(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            publish(root,output); original=(output/'current.json').read_bytes()
            self.fixture(root,cap=7000)
            with patch('publish_snapshot.publish_private_pack',side_effect=RuntimeError('R2 failed')) as upload:
                with self.assertRaisesRegex(RuntimeError,'R2 failed'): publish(root,output)
                self.assertEqual(upload.call_args.kwargs['active_revision'],json.loads(original)['revision'])
            self.assertEqual((output/'current.json').read_bytes(),original)

    def test_optional_private_pack_is_not_advertised(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            with patch('publish_snapshot.publish_private_pack',return_value=False):
                manifest=publish(root,output)
            self.assertNotIn('advanced',manifest)

    def test_private_pack_is_advertised_only_after_successful_publish(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            with patch('publish_snapshot.publish_private_pack',return_value=True):
                manifest=publish(root,output)
            self.assertEqual(manifest['advanced'],{
                'revision':manifest['revision'],'session':'2026-09-30','shards':32,'maxSessions':1500,
            })

    def test_scanner_only_and_chart_release_have_distinct_revisions(self):
        import os
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            with patch.dict(os.environ,{'EDL_CHART_STORAGE':'r2'},clear=True):
                scanner=publish(root,output)
            with patch.dict(os.environ,{'EDL_CHART_STORAGE':'local'},clear=True):
                charts=publish(root,output)
            self.assertEqual(scanner['schemaVersion'],7)
            self.assertEqual(charts['schemaVersion'],7)
            self.assertNotEqual(scanner['revision'],charts['revision'])
            for key in ('chartUrlTemplate', 'chartRevision', 'chartObjectPrefix'):
                self.assertNotIn(key, scanner)
            self.assertEqual(json.loads((output/'current.json').read_text()), charts)
