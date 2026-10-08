"""News must survive temporary-input cleanup and staged publication."""
import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'src'))
import build_chart_artifacts
from edl_pipeline import publication, runner
from edl_pipeline.artifacts import FINAL_ARTIFACT_SPECS, POST_STANDARDIZATION_SCRIPTS


class ChartNewsPublicationTests(unittest.TestCase):
    def test_news_reaches_published_charts_after_stage_is_discarded(self):
        with tempfile.TemporaryDirectory() as folder:
            destination=Path(folder)
            audit={'TEST':{'source':'independent fixture'}}
            (destination/'base_history_audits.json').write_text(json.dumps(audit))
            stages=[]
            def worker(command, cwd, env):
                self.assertEqual(command[1], '-c')
                self.assertIn('edl_pipeline.runner', command[2])
                stage=Path(cwd); stages.append(stage)
                self.assertEqual(env['EDL_CLEANUP_INTERMEDIATE'],'0')
                self.assertEqual(json.loads((stage/'base_history_audits.json').read_text()),audit)
                for spec in FINAL_ARTIFACT_SPECS:
                    if spec.path.endswith('.gz'):
                        (stage/spec.path).write_bytes(gzip.compress(b'{"records":[]}'))
                    else:
                        (stage/spec.path).write_text('{}')
                (stage/'all_stocks_fundamental_analysis.json').write_text(json.dumps([
                    {'symbol':'TEST','as_of_date':'2026-09-30'}]))
                news=stage/'market_news';news.mkdir()
                (news/'TEST_news.json').write_text(json.dumps({'Symbol':'TEST','News':[
                    {'PublishDate':1790726400000,'Title':'Current announcement','Source':'Fixture'},
                    {'PublishDate':1790985600000,'Title':'Future announcement','Source':'Fixture'}]}))
                with mock.patch.object(build_chart_artifacts,'BASE_DIR',str(stage)):
                    self.assertEqual(build_chart_artifacts.main(),0)
                with mock.patch.object(runner,'BASE_DIR',str(stage)):
                    runner.cleanup_intermediate()
                self.assertFalse(news.exists())
                (stage/'pipeline_report.json').write_text(json.dumps({'exit_code':0}))
                return mock.Mock(returncode=0)
            with mock.patch.object(publication.pipeline_utils,'BASE_DIR',str(destination)), \
                 mock.patch.object(publication.subprocess,'run',side_effect=worker), \
                 mock.patch.object(publication,'publish_frontend'), \
                 mock.patch.object(publication,'inspect_publication',return_value={'errors':[]}), \
                 mock.patch.dict('os.environ',{'EDL_FETCH_OHLCV':'1'}):
                self.assertEqual(publication.main(),0)
            self.assertFalse(stages[0].exists())
            index = json.loads((destination / 'chart_artifacts/index.json').read_text())
            object_path = destination / 'chart_artifacts/objects' / (index['chartObjects']['TEST'] + '.json.gz')
            with gzip.open(object_path, 'rt') as handle:
                chart=json.load(handle)
            self.assertEqual([row['headline'] for row in chart['marketNews']],['Current announcement'])
            self.assertIn('build_chart_artifacts.py',POST_STANDARDIZATION_SCRIPTS)
            self.assertGreater(POST_STANDARDIZATION_SCRIPTS.index('build_chart_artifacts.py'),
                               POST_STANDARDIZATION_SCRIPTS.index('build_quarterly_financial_ledger.py'))

    def test_chart_contains_the_same_base_and_frozen_breakout_facts(self):
        import pandas as pd
        from edl_pipeline.scanner.base_publication import build_base_records, compact_base_records
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'ohlcv_data').mkdir()
            closes=[100]+[94]*19+[102,104]
            frame=pd.DataFrame({'Date':pd.bdate_range('2026-01-01',periods=len(closes)),
                'Open':closes,'High':[v+1 for v in closes],'Low':[v-1 for v in closes],
                'Close':closes,'Volume':1000})
            frame['Turnover']=[2e7]*20+[9e8,8e8]
            session=str(frame.Date.iloc[-1].date())
            stock={'symbol':'TEST','as_of_date':session,'listing_date':'2020-01-01'}
            (root/'all_stocks_fundamental_analysis.json').write_text(json.dumps([stock]))
            frame.to_csv(root/'ohlcv_data/TEST.csv',index=False)
            with mock.patch.object(build_chart_artifacts,'BASE_DIR',str(root)):
                self.assertEqual(build_chart_artifacts.main(),0)
            index=json.loads((root/'chart_artifacts/index.json').read_text())
            digest=index['chartObjects']['TEST']
            with gzip.open(root/'chart_artifacts/objects'/f'{digest}.json.gz','rt') as handle:chart=json.load(handle)
            expected=compact_base_records(build_base_records({'TEST':frame},{'TEST':stock})['TEST'],public=True)
            self.assertEqual(chart['bases'],expected)
            self.assertNotIn('distanceEMA150',chart['bases']['FRESH_BREAKOUT']['current'])
            self.assertIn('rsRating',chart['bases']['FRESH_BREAKOUT']['current'])
            base=chart['bases']['FRESH_BREAKOUT']
            self.assertLess(base['base']['endDate'],base['breakout']['date'])
            self.assertEqual(base['pivot'],100)
            self.assertEqual(base['base']['quietTurnoverCr'],2)
            self.assertEqual(base['base']['medianTurnoverCr'],2)

    def test_failed_pipeline_does_not_replace_previous_charts(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); charts=root/'chart_artifacts';charts.mkdir()
            (charts/'index.json').write_text('previous release')
            with mock.patch.object(publication.pipeline_utils,'BASE_DIR',str(root)), \
                 mock.patch.object(publication.subprocess,'run',return_value=mock.Mock(returncode=1)), \
                 mock.patch.dict('os.environ',{'EDL_FETCH_OHLCV':'1'}):
                self.assertEqual(publication.main(),1)
            self.assertEqual((charts/'index.json').read_text(),'previous release')

    def test_news_timestamp_formats_and_invalid_values(self):
        self.assertEqual(build_chart_artifacts._event_date(1790726400),'2026-09-30')
        self.assertEqual(build_chart_artifacts._event_date(1790726400000),'2026-09-30')
        self.assertEqual(build_chart_artifacts._event_date('2026-09-30T12:00:00Z'),'2026-09-30')
        for value in (0, -1, float('nan'), float('inf'), 10**30, None, 'invalid'):
            self.assertIsNone(build_chart_artifacts._event_date(value))

class PromotionRecoveryTests(unittest.TestCase):
    def fixture(self, folder):
        root=Path(folder); stage=root/'stage'; destination=root/'published'
        stage.mkdir(); destination.mkdir()
        (stage/'stock.json').write_text('new'); (destination/'stock.json').write_text('old')
        for base,value in ((stage,'new'),(destination,'old')):
            (base/'chart_artifacts').mkdir(); (base/'chart_artifacts/index.json').write_text(value)
        return stage,destination

    def test_partial_copy_is_removed_and_previous_release_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            stage,destination=self.fixture(folder)
            def broken(source,target):
                target.mkdir(); (target/'partial').write_text('partial'); raise OSError('disk full')
            with mock.patch.object(publication.shutil,'copytree',side_effect=broken):
                with self.assertRaises(OSError): publication.promote(stage,destination,['stock.json'],('chart_artifacts',))
            self.assertFalse((destination/'.chart_artifacts.incoming').exists())
            self.assertEqual((destination/'stock.json').read_text(),'old')
            self.assertEqual((destination/'chart_artifacts/index.json').read_text(),'old')

    def test_failed_frontend_publication_rolls_back_files_and_charts(self):
        with tempfile.TemporaryDirectory() as folder:
            stage,destination=self.fixture(folder)
            def fail(): raise RuntimeError('upload failed')
            with self.assertRaises(RuntimeError): publication.promote(stage,destination,['stock.json'],('chart_artifacts',),after=fail)
            self.assertEqual((destination/'stock.json').read_text(),'old')
            self.assertEqual((destination/'chart_artifacts/index.json').read_text(),'old')

    def test_interrupted_swap_recovers_previous_before_failed_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            stage,destination=self.fixture(folder)
            (destination/'chart_artifacts').replace(destination/'.chart_artifacts.previous')
            with mock.patch.object(publication.shutil,'copytree',side_effect=OSError('disk full')):
                with self.assertRaises(OSError): publication.promote_directory(stage,destination,'chart_artifacts')
            self.assertEqual((destination/'chart_artifacts/index.json').read_text(),'old')


class LowestVolumeTests(unittest.TestCase):
    def test_quarters_ties_zero_and_empty_history(self):
        rows=[{'date':'2026-03-30','volume':10},{'date':'2026-03-31','volume':10},
              {'date':'2026-04-01','volume':0}]
        result=build_chart_artifacts._volume_events(rows)
        self.assertEqual(result['lowestEver'],rows[-1])
        self.assertEqual(result['lowestQuarterly'],rows[1:])
        empty=build_chart_artifacts._volume_events([])
        self.assertIsNone(empty['lowestEver'])
        self.assertEqual(empty['lowestQuarterly'],[])

    def test_retention_preserves_all_history_lowest(self):
        rows=[{'date':f'{year}-{month:02d}-01','volume':year-2000}
              for year in range(2000,2007) for month in (1,4,7,10)]
        result=build_chart_artifacts._volume_events(rows)
        self.assertEqual(len(result['lowestQuarterly']),20)
        self.assertEqual(result['lowestQuarterly'][0]['date'],'2002-01-01')
        self.assertEqual(result['lowestEver'],{'date':'2000-10-01','volume':0})
