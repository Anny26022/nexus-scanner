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
    def test_fetch_preserves_stage_without_publishing_then_build_promotes(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'output'; destination.mkdir()
            stage = Path(folder) / 'stage'
            def worker(command, cwd, env):
                current = Path(cwd)
                if env['EDL_PIPELINE_PHASE'] == 'build':
                    self.assertTrue((current / 'fetch_checkpoint.json').exists())
                    for spec in FINAL_ARTIFACT_SPECS:
                        (current / spec.path).write_bytes(b'fixture')
                    (current / 'chart_artifacts').mkdir()
                    (current / 'chart_artifacts/TEST.json').write_text('{}')
                else:
                    (current / 'fetch_checkpoint.json').write_text('{"exit_code":0}')
                (current / 'pipeline_report.json').write_text('{"exit_code":0}')
                return mock.Mock(returncode=0)
            with mock.patch.object(publication.pipeline_utils, 'BASE_DIR', str(destination)), \
                    mock.patch.object(publication.subprocess, 'run', side_effect=worker), \
                    mock.patch.object(publication, 'inspect_publication', return_value={'errors': []}) as inspect, \
                    mock.patch.object(publication, 'publish_frontend') as frontend:
                self.assertEqual(publication.main(phase='fetch', stage_path=stage), 0)
                self.assertTrue(stage.is_dir())
                self.assertFalse((destination / 'pipeline_report.json').exists())
                inspect.assert_not_called()
                frontend.assert_not_called()
                self.assertEqual(publication.main(phase='build', stage_path=stage), 0)
                self.assertFalse(stage.exists())
                self.assertTrue((destination / 'chart_artifacts/TEST.json').exists())
                frontend.assert_called_once_with(destination)

    def test_promotion_does_not_load_artifacts_with_read_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stage = root / 'stage'; stage.mkdir()
            destination = root / 'destination'; destination.mkdir()
            (stage / 'large').write_text('new')
            (destination / 'large').write_text('old')
            with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('unbounded read')):
                publication.promote(stage, destination, ['large'])
            self.assertEqual((destination / 'large').read_text(), 'new')

    def test_news_reaches_published_charts_after_stage_is_discarded(self):
        with tempfile.TemporaryDirectory() as folder:
            destination=Path(folder)
            stages=[]
            def worker(command, cwd, env):
                self.assertEqual(command[1], '-c')
                self.assertIn('edl_pipeline.runner', command[2])
                stage=Path(cwd); stages.append(stage)
                self.assertEqual(env['EDL_CLEANUP_INTERMEDIATE'],'0')
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
