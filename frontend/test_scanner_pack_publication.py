import gzip
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from scanner_identity import checked_identity
from scanner_pack_publication import MAGIC,SHARD_COUNT,build_private_scanner_pack


class Cache:
    def __init__(self,frame): self._frame=frame
    def frame(self,root,symbol,session): return self._frame


class ScannerPackTests(unittest.TestCase):
    def test_binary_pack_is_deterministic_bounded_and_manifested(self):
        frame=pd.DataFrame({'Date':pd.bdate_range(end='2026-10-01',periods=1600),'Open':1.,'High':2.,'Low':.5,'Close':1.5,'Volume':100.})
        context={'stocks':{'TEST':{'symbol':'TEST'}},'benchmarks':{},'financial_history':{}}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);target,manifest=build_private_scanner_pack(root,root/'packs','a'*64,'2026-10-01',Cache(frame),context,{},[])
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
            self.assertEqual({item['key'] for item in manifest['objects'] if not item['key'].startswith(('shards/','auxiliary/'))},{'benchmarks.json.gz','metadata.json.gz'})
            second, second_manifest=build_private_scanner_pack(root,root/'packs-2','a'*64,'2026-10-01',Cache(frame),context,{},[])
            self.assertEqual(manifest,second_manifest)
            for descriptor in manifest['objects']:
                self.assertEqual((target/descriptor['key']).read_bytes(),(second/descriptor['key']).read_bytes())


    def test_runtime_shards_only_load_selected_bases_and_archive_all_episodes(self):
        from edl_pipeline.scanner.base_publication import build_base_records
        frame=pd.DataFrame({'Date':pd.bdate_range(end='2026-10-01',periods=70),'Open':[100]+[94]*19+[102]+[100]*49,
            'High':[101]+[95]*19+[103]+[101]*49,'Low':[99]+[93]*19+[101]+[99]*49,'Close':[100]+[94]*19+[102]+[100]*49,'Volume':1000.})
        stocks={'TEST':{'symbol':'TEST'}}
        records=build_base_records({'TEST':frame},stocks)
        context={'stocks':stocks,'base_episodes':records}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);target,manifest=build_private_scanner_pack(root,root/'packs','a'*64,'2026-10-01',Cache(frame),context,{},[])
            archives=[item for item in manifest['objects'] if item['key'].startswith('base-history/')]
            self.assertEqual(len(archives),32)
            archive=next(item for item in archives if 'TEST' in json.loads(gzip.decompress((target/item['key']).read_bytes())))
            saved=json.loads(gzip.decompress((target/archive['key']).read_bytes()))['TEST']
            self.assertEqual(saved,records['TEST'])
            runtime=json.loads(gzip.decompress((target/archive['key'].replace('base-history/','auxiliary/')).read_bytes()))['bases']['TEST']
            self.assertLessEqual(len(runtime),4)
            self.assertTrue({row['id'] for row in runtime}.issubset({row['id'] for row in saved}))

if __name__=='__main__': unittest.main()
