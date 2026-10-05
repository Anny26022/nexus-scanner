import gzip
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from scanner_identity import checked_identity
from scanner_pack_publication import BaseHistoryArchive,MAGIC,SHARD_COUNT,build_private_scanner_pack,PrivateR2Store,_shard


class Cache:
    def __init__(self,frame): self._frame=frame
    def frame(self,root,symbol,session): return self._frame


class ScannerPackTests(unittest.TestCase):
    def test_private_pack_preserves_actual_turnover_and_missing_values(self):
        frame=pd.DataFrame({'Date':pd.to_datetime(['2026-09-30','2026-10-01']),
            'Open':[1.,1.],'High':[2.,2.],'Low':[.5,.5],'Close':[1.5,1.5],
            'Volume':[100.,100.],'Turnover':[float('nan'),999.]})
        context={'stocks':{'TEST':{'symbol':'TEST'}}}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            target,_=build_private_scanner_pack(root,root/'packs','a'*64,'2026-10-01',Cache(frame),context,{})
            aux=json.loads(gzip.decompress((target/f'auxiliary/{_shard("TEST"):02d}.json.gz').read_bytes()))
            self.assertEqual(aux['turnover']['TEST']['values'],[None,999.])
            self.assertEqual(len(aux['turnover']['TEST']['dates']),2)

    def test_streamed_archives_preserve_complete_episodes_in_private_pack(self):
        frame=pd.DataFrame({'Date':pd.to_datetime(['2026-10-01']),'Open':[1.],'High':[2.],'Low':[.5],'Close':[1.5],'Volume':[100.]})
        episodes=[{'id':'old','value':1},{'id':'selected','value':2}]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with BaseHistoryArchive(root/'archive') as sink:
                sink('TEST',episodes)
            context={'stocks':{'TEST':{'symbol':'TEST'}},'base_episodes':{'TEST':[]},'base_history_archive':root/'archive'}
            target,manifest=build_private_scanner_pack(root,root/'packs','a'*64,'2026-10-01',Cache(frame),context,{})
            archive=target/f'base-history/{_shard("TEST"):02d}.json.gz'
            self.assertEqual(json.loads(gzip.decompress(archive.read_bytes())),{'TEST':episodes})
            for index in range(SHARD_COUNT):
                source=root/f'archive/{index:02d}.json.gz'
                self.assertEqual(source.read_bytes(),(target/f'base-history/{index:02d}.json.gz').read_bytes())
            descriptor=next(item for item in manifest['objects'] if item['key']==str(archive.relative_to(target)))
            self.assertEqual(descriptor['bytes'],archive.stat().st_size)

    def test_retention_preserves_active_release_after_repeated_failed_promotions(self):
        store=object.__new__(PrivateR2Store)
        store.bucket='nexus-screener-private-data'
        revisions=[str(index)*64 for index in range(9)]
        listing=[{'Path':revision+'/manifest.json','ModTime':f'2026-10-{index+1:02d}T00:00:00Z'} for index,revision in enumerate(revisions)]
        # Uncommitted objects do not qualify as a completed rollback revision.
        listing.append({'Path':'partial/shards/00.bin.gz','ModTime':'2026-11-01T00:00:00Z'})
        store.run=Mock(return_value=SimpleNamespace(stdout=json.dumps(listing)))
        store.retain_latest(7,protected={revisions[0],revisions[8]})
        deleted={call.args[1].rsplit('/',1)[-1] for call in store.run.call_args_list if call.args[0]=='purge'}
        self.assertEqual(deleted,{revisions[1],revisions[2]})
        self.assertNotIn(revisions[0],deleted)

    def test_binary_pack_is_deterministic_bounded_and_manifested(self):
        frame=pd.DataFrame({'Date':pd.bdate_range(end='2026-10-01',periods=1600),'Open':1.,'High':2.,'Low':.5,'Close':1.5,'Volume':100.})
        context={'stocks':{'TEST':{'symbol':'TEST'}},'benchmarks':{},'financial_history':{'TEST':[
            {'filing_date':'2026-10-01','quarter_end':'2026-06-30','report_type':'CONSOLIDATED','net_profit':12,'eps':3,'filing_url':'https://example.com/filing','symbol':'TEST'},
            {'filing_date':'2026-10-02','net_profit':999}]}}
        delivery={'TEST':[{'date':str(frame.Date.iloc[0].date()),'delivery_percent':99},
                          {'date':'2026-10-01','delivery_percent':29,'source':'NSE','traded_quantity':123},
                          {'date':'2026-10-01','delivery_percent':30,'source':'adjusted'},
                          {'date':'2026-10-02','delivery_percent':100}]}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);target,manifest=build_private_scanner_pack(root,root/'packs','a'*64,'2026-10-01',Cache(frame),context,delivery,[])
            self.assertEqual(manifest['shards'],SHARD_COUNT)
            for key,value in checked_identity().items(): self.assertEqual(manifest[key],value)
            self.assertEqual(manifest['symbols'],1)
            files=list((target/'shards').glob('*.bin.gz'))
            self.assertEqual(len(files),SHARD_COUNT)
            populated_descriptor=next(item for item in manifest['objects'] if item.get('symbols')==1)
            populated=target/populated_descriptor['key']
            raw=gzip.decompress(populated.read_bytes())
            self.assertEqual(raw[:8],MAGIC)
            size=struct.unpack('<I',raw[8:12])[0]
            header=json.loads(raw[12:12+size])
            self.assertEqual(header['symbols'][0]['count'],1500)
            auxiliary={item['key'] for item in manifest['objects'] if item['key'].startswith('auxiliary/')}
            self.assertEqual(len(auxiliary),SHARD_COUNT)
            populated_aux=next(item for item in manifest['objects'] if item['key'].startswith('auxiliary/') and item.get('symbols')==1)
            runtime_delivery=json.loads(gzip.decompress((target/populated_aux['key']).read_bytes()))['delivery']['TEST']
            day=(pd.Timestamp('2026-10-01')-pd.Timestamp('1970-01-01')).days
            self.assertEqual(runtime_delivery,{'dates':[day,day],'percentages':[29,30]})
            runtime_earnings=json.loads(gzip.decompress((target/populated_aux['key']).read_bytes()))['earnings']['TEST']
            self.assertEqual(runtime_earnings,[{'filing_date':'2026-10-01','quarter_end':'2026-06-30','report_type':'CONSOLIDATED','net_profit':12,'eps':3}])
            self.assertEqual({item['key'] for item in manifest['objects'] if not item['key'].startswith(('shards/','auxiliary/'))},{'benchmarks.json.gz','metadata.json.gz'})
            second, second_manifest=build_private_scanner_pack(root,root/'packs-2','a'*64,'2026-10-01',Cache(frame),context,delivery,[])
            self.assertEqual(manifest,second_manifest)
            for descriptor in manifest['objects']:
                self.assertEqual((target/descriptor['key']).read_bytes(),(second/descriptor['key']).read_bytes())


    def test_runtime_shards_only_load_selected_bases_and_archive_all_episodes(self):
        from edl_pipeline.scanner.base_publication import build_base_records, compact_base_records
        frame=pd.DataFrame({'Date':pd.bdate_range(end='2026-10-01',periods=70),'Open':[100]+[94]*19+[102]+[100]*49,
            'High':[101]+[95]*19+[103]+[101]*49,'Low':[99]+[93]*19+[101]+[99]*49,'Close':[100]+[94]*19+[102]+[100]*49,'Volume':1000.})
        frame['Turnover']=20_000_000.
        stocks={'TEST':{'symbol':'TEST'}}
        records=build_base_records({'TEST':frame},stocks)
        public_bases=compact_base_records(records['TEST'],public=True)
        context={'stocks':stocks,'base_episodes':records,'base_rs_history':{'TEST':{'dates':['2026-10-01'],'ratings':[92]}}}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with patch('edl_pipeline.scanner.base_publication.compact_base_records', wraps=compact_base_records) as select:
                target,manifest=build_private_scanner_pack(root,root/'packs','a'*64,'2026-10-01',Cache(frame),context,{},[{'symbol':'TEST','historyAligned':True,'asOfDate':'2026-10-01','bases':public_bases}, {'symbol':'NO_HISTORY','historyAligned':False,'metrics':{'return21':12}}])
                self.assertEqual(select.call_count, 1)
            index_row=json.loads(gzip.decompress((target/'metadata.json.gz').read_bytes()))['stocks'][0]
            self.assertNotIn('bases',index_row)
            fallback=json.loads(gzip.decompress((target/'metadata.json.gz').read_bytes()))['stocks'][1]
            self.assertEqual(fallback['metrics'], {'return21':12})
            auxiliary=next(item for item in manifest['objects'] if item['key'].startswith('auxiliary/') and item.get('symbols')==1)
            metadata=json.loads(gzip.decompress((target/auxiliary['key']).read_bytes()))['stocks']['TEST']['bases']
            for stage,record in metadata.items():
                self.assertEqual(record['id'],public_bases[stage]['id'])
                self.assertFalse({'base','current','selection'}&record.keys())
                self.assertIn('current',public_bases[stage])
            archives=[item for item in manifest['objects'] if item['key'].startswith('base-history/')]
            self.assertEqual(len(archives),32)
            archive=next(item for item in archives if 'TEST' in json.loads(gzip.decompress((target/item['key']).read_bytes())))
            saved=json.loads(gzip.decompress((target/archive['key']).read_bytes()))['TEST']
            self.assertEqual(saved,records['TEST'])
            rank_key=archive['key'].replace('base-history/','base-ranks/')
            self.assertEqual(json.loads(gzip.decompress((target/rank_key).read_bytes()))['TEST']['ratings'],[92])
            runtime=json.loads(gzip.decompress((target/archive['key'].replace('base-history/','auxiliary/')).read_bytes()))['bases']['TEST']
            for record in runtime:
                self.assertEqual(record['base']['parts']['full']['turnoverCr'],2)
                self.assertEqual(record['base']['quietTurnoverCr'],2)
                self.assertEqual(record['current']['averageTurnover50'],2)
                self.assertIn('sma50MonthAgo',record['current'])
            self.assertLessEqual(len(runtime),4)
            self.assertTrue({row['id'] for row in runtime}.issubset({row['id'] for row in saved}))

if __name__=='__main__': unittest.main()
