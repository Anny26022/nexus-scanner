import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd
import scanner_bridge as bridge
from publish_snapshot import publish
from scanner_cache import ScannerCache


class SnapshotPublicationTests(unittest.TestCase):
    def fixture(self, root, cap=5000):
        stocks=[{'symbol':'TEST','name':'Test','close':100,'open':99,'high':101,'low':98,'volume':200,'as_of_date':'2026-09-30',
                 'market_cap_crore':cap,'daily_rupee_turnover_50_cr':10,'circuit_limit':'20','listing_series':'EQ','index_memberships':[]}]
        files={'all_stocks_fundamental_analysis.json.gz':stocks,'market_breadth_v2.json.gz':{'records':[{'date':'2026-09-30'}]},
               'quarterly_financial_history.json.gz':{'records':[]},'ipo_screener.json.gz':{'records':[], 'provider_data':{'analytics':{'year_summary':{'year':'2026'}}}}}
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
        frame=pd.DataFrame({'Date':pd.bdate_range(end='2026-09-30',periods=60),'Open':99.,'High':101.,'Low':98.,'Close':100.,'Volume':100.})
        frame.to_csv(root/'ohlcv_data/TEST.csv',index=False)

    def test_same_session_correction_creates_new_revision_and_old_backend_stays_frozen(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            first=publish(root,output)
            with gzip.open(output/'revisions'/first['revision']/'ipos.json.gz','rt') as handle:
                self.assertEqual(json.load(handle)['provider_data']['analytics']['year_summary']['year'], '2026')
            self.fixture(root,cap=6000)
            second=publish(root,output)
            compressed=(output/'revisions'/second['revision']/'stocks.json.gz').read_bytes()
            self.assertEqual(gzip.decompress(compressed),(output/'revisions'/second['revision']/'stocks.json').read_bytes())
            self.assertEqual(second['datasetGzipUrl'],f"/data/revisions/{second['revision']}/stocks.json.gz")
            self.assertNotEqual(first['revision'],second['revision'])
            self.assertEqual(json.loads((output/'current.json').read_text())['revision'],second['revision'])
            request={'asOfDate':'2026-09-30','universe':'mainboard','expressionTree':{'type':'group','operator':'all','children':[]},'datasetRevision':first['revision']}
            old=bridge.run(request,root,ScannerCache())
            new=bridge.run({**request,'datasetRevision':second['revision']},root,ScannerCache())
            self.assertEqual(old['rows'][0]['marketCapCrore'],5000)
            self.assertEqual(new['rows'][0]['marketCapCrore'],6000)
            self.assertTrue((root/'.scanner_cache/revisions'/second['revision']/'delivery_history_data/2026-09-30.json.gz').exists())

    def test_failure_does_not_replace_current_manifest(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            publish(root,output); original=(output/'current.json').read_bytes()
            (root/'ipo_screener.json.gz').write_bytes(b'not gzip')
            with self.assertRaises(OSError): publish(root,output)
            self.assertEqual((output/'current.json').read_bytes(),original)

    def test_scanner_only_and_chart_release_have_distinct_revisions(self):
        import os
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            with patch.dict(os.environ,{'EDL_CHART_STORAGE':'r2'},clear=True):
                scanner=publish(root,output)
            with patch.dict(os.environ,{'EDL_CHART_STORAGE':'local'},clear=True):
                charts=publish(root,output)
            self.assertEqual(scanner['schemaVersion'],4)
            self.assertEqual(charts['schemaVersion'],6)
            self.assertNotEqual(scanner['revision'],charts['revision'])
            for key in ('chartUrlTemplate', 'chartRevision', 'chartObjectPrefix'):
                self.assertNotIn(key, scanner)
            self.assertEqual(json.loads((output/'current.json').read_text()), charts)
