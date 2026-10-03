import gzip
import json
from pathlib import Path
import struct
import tempfile
import unittest

import pandas as pd

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


if __name__=='__main__': unittest.main()
