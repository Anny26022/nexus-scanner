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
    def test_publishes_ownership_values_and_preserves_old_revision(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            source=root/'all_stocks_fundamental_analysis.json.gz'
            with gzip.open(source,'rt') as handle:
                stocks=json.load(handle)
            stocks[0].update(promoter_holding_percent=50.48,fii_percent_change_qoq=-1.47,dii_percent_change_qoq=0.0)
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            first=publish(root,output)
            original=output/'revisions'/first['revision']/'stocks.json'
            original_bytes=original.read_bytes()
            row=json.loads(original_bytes)['stocks'][0]
            self.assertEqual(row['promoterHoldingPct'],50.48)
            self.assertEqual(row['fiiChangePctQoq'],-1.47)
            self.assertEqual(row['diiChangePctQoq'],0.0)
            stocks[0].update(promoter_holding_percent=None,fii_percent_change_qoq=None,dii_percent_change_qoq=2.25)
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            second=publish(root,output)
            row=json.loads((output/'revisions'/second['revision']/'stocks.json').read_text())['stocks'][0]
            self.assertIsNone(row['promoterHoldingPct'])
            self.assertIsNone(row['fiiChangePctQoq'])
            self.assertEqual(row['diiChangePctQoq'],2.25)
            self.assertNotEqual(first['revision'],second['revision'])
            self.assertEqual(original.read_bytes(),original_bytes)

    def fixture(self, root, cap=5000):
        stocks=[{'symbol':'TEST','name':'Test','close':100,'open':99,'high':101,'low':98,'volume':200,'as_of_date':'2026-09-30',
                 'market_cap_crore':cap,'daily_rupee_turnover_50_cr':10,'circuit_limit':'20','listing_series':'EQ','index_memberships':[]}]
        files={'all_stocks_fundamental_analysis.json.gz':stocks,'market_breadth_v2.json.gz':{'records':[{'date':'2026-09-30'}]},
               'quarterly_financial_history.json.gz':{'records':[]},'earnings_calendar.json.gz':{'source':'BSE forthcoming results calendar','fetched_at':'2026-10-01T00:00:00+00:00','events':[],'available':True},'ipo_screener.json.gz':{'records':[], 'provider_data':{'analytics':{'year_summary':{'year':'2026'}}}}}
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

    def test_publishes_ownership_values_and_preserves_old_revision(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            source=root/'all_stocks_fundamental_analysis.json.gz'
            with gzip.open(source,'rt') as handle:
                stocks=json.load(handle)
            stocks[0].update(promoter_holding_percent=50.48,fii_percent_change_qoq=-1.47,dii_percent_change_qoq=0.0)
            stocks[0].update(cwip_crore=237686,pb_ratio=1.8247,ev_ebitda=24.91,
                             total_income_in_lakhs=31601800,total_tax_expenses_in_lakhs=743400,
                             debt_to_equity=0.44,financial_units_version=1,debt_to_equity_source='SCANX_Debt2Eq')
            stocks[0]['financial_statement_history'] = {'source': 'ScanX', 'observed_on': '2026-09-30',
                'quarterly': [{'period_end': '2026-06-30', 'revenue': 120}], 'annual': []}
            stocks[0]['ttm_revenue_growth_percent'] = 20
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            first=publish(root,output)
            original=output/'revisions'/first['revision']/'stocks.json'
            original_bytes=original.read_bytes()
            row=json.loads(original_bytes)['stocks'][0]
            self.assertEqual(row['promoterHoldingPct'],50.48)
            self.assertEqual(row['fiiChangePctQoq'],-1.47)
            self.assertEqual(row['diiChangePctQoq'],0.0)
            self.assertEqual(row['cwipCrore'],237686)
            self.assertEqual(row['pbRatio'],1.8247)
            self.assertEqual(row['evEbitda'],24.91)
            self.assertEqual(row['totalIncomeLakh'],31601800)
            self.assertEqual(row['totalTaxExpensesLakh'],743400)
            self.assertEqual(row['debtToEquity'],0.44)
            self.assertEqual(row['financialUnitsVersion'],1)
            self.assertEqual(row['debtToEquitySource'],'SCANX_Debt2Eq')
            self.assertEqual(row['ttmRevenueGrowthPct'],20)
            self.assertEqual(row['financialHistoryObservedOn'],'2026-09-30')
            self.assertNotIn('financialStatementHistory',row)
            self.assertEqual(json.loads((output/'current.json').read_text())['financialHistoryUrl'],first['financialHistoryUrl'])
            history_file=output/first['financialHistoryUrl'].removeprefix('/data/')
            with gzip.open(history_file,'rt') as handle:
                self.assertEqual(json.load(handle)['TEST'],stocks[0]['financial_statement_history'])
            stocks[0].update(promoter_holding_percent=None,fii_percent_change_qoq=None,dii_percent_change_qoq=2.25)
            with gzip.open(source,'wt') as handle:
                json.dump(stocks,handle)
            second=publish(root,output)
            row=json.loads((output/'revisions'/second['revision']/'stocks.json').read_text())['stocks'][0]
            self.assertIsNone(row['promoterHoldingPct'])
            self.assertIsNone(row['fiiChangePctQoq'])
            self.assertEqual(row['diiChangePctQoq'],2.25)
            self.assertNotEqual(first['revision'],second['revision'])
            self.assertEqual(original.read_bytes(),original_bytes)

    def test_same_session_correction_creates_new_revision_and_old_backend_stays_frozen(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir(); output=Path(folder)/'public';self.fixture(root)
            first=publish(root,output)
            with gzip.open(output/'revisions'/first['revision']/'ipos.json.gz','rt') as handle:
                self.assertEqual(json.load(handle)['provider_data']['analytics']['year_summary']['year'], '2026')
            self.assertTrue((output/'revisions'/first['revision']/'earnings-calendar.json.gz').exists())
            with gzip.open(output/'revisions'/first['revision']/'earnings-calendar.json.gz','rt') as handle:
                self.assertEqual(json.load(handle),{'source':'BSE forthcoming results calendar','fetched_at':'2026-10-01T00:00:00+00:00','events':[],'available':True})
            self.assertEqual(first['earningsCalendarUrl'], f"/data/revisions/{first['revision']}/earnings-calendar.json.gz")
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

    def test_manual_publication_without_calendar_omits_calendar_url(self):
        with tempfile.TemporaryDirectory() as folder,patch('publish_snapshot.list_presets',return_value=[{'id':'lib-easy-money'}]):
            root=Path(folder)/'edl';root.mkdir();output=Path(folder)/'public';self.fixture(root)
            (root/'earnings_calendar.json.gz').unlink()
            first=publish(root,output)
            self.assertNotIn('earningsCalendarUrl',first)
            self.assertFalse((output/'revisions'/first['revision']/'earnings-calendar.json.gz').exists())
            self.assertEqual((output/'current.json').read_bytes(),(output/'revisions'/first['revision']/'release.json').read_bytes())
            self.assertEqual(publish(root,output),first)

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
