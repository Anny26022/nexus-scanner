"""Process-local scanner cache, invalidated by source-file revisions."""
from collections import OrderedDict
from pathlib import Path
import hashlib
import json

import numpy as np
import pandas as pd

from edl_pipeline.scanner.trend import normalize_history


class ScannerCache:
    def __init__(self):
        self.revision = None
        self.contexts = {}
        self.frames = {}
        self.results = OrderedDict()

    def refresh(self, root):
        marker = root/'scanner_revision.json'
        if marker.exists():
            manifest = json.loads(marker.read_text())
            revision = str(root.resolve()) + ':' + manifest['revision']
            if revision != self.revision:
                self.revision = revision
                self.contexts.clear(); self.frames.clear(); self.results.clear()
                self._load_frames(root, [], manifest.get('historyRevision'))
            return
        paths = sorted([*root.glob('*.json'), *root.glob('*.json.gz'),
                        *(root/'ohlcv_data').glob('*.csv'),
                        *(root/'scanner_history_data').rglob('*'),
                        *(root/'delivery_history_data').glob('*.csv'),
                        *(root/'eod2_delivery_history_data').glob('*.csv')])
        entries = []
        for path in paths:
            if path.is_file():
                stat = path.stat()
                entries.append((str(path.relative_to(root)), stat.st_size, stat.st_mtime_ns))
        revision = hashlib.sha256(json.dumps([str(root.resolve()), entries]).encode()).hexdigest()
        if revision != self.revision:
            self.revision = revision
            self.contexts.clear()
            self.frames.clear()
            self.results.clear()
            self._load_frames(root, entries)

    def _load_frames(self, root, entries, published_revision=None):
        history_revision = published_revision or hashlib.sha256(json.dumps([e for e in entries if e[0].startswith('ohlcv_data/')]).encode()).hexdigest()
        self.history_revision = history_revision
        path = root/'.scanner_cache'/'history.npz'
        try:
            with np.load(path, allow_pickle=False) as data:
                if str(data['revision']) != history_revision:
                    return
                # Old caches omitted traded value. Reject them before loading
                # any frames, so CSV history can rebuild a complete cache.
                offsets, values, dates, turnover = data['offsets'], data['values'], data['dates'], data['turnover']
                for i, symbol in enumerate(data['symbols']):
                    start, end = offsets[i:i+2]
                    frame = pd.DataFrame(values[start:end], columns=['Open','High','Low','Close','Volume'])
                    frame.insert(0, 'Date', pd.to_datetime(dates[start:end]))
                    frame['Turnover'] = turnover[start:end]
                    self.frames[str(symbol)] = frame
                del self.history_revision
        except (OSError, ValueError, KeyError):
            pass

    def frame(self, root, symbol, as_of):
        if symbol not in self.frames:
            path = root/'ohlcv_data'/f'{symbol}.csv'
            self.frames[symbol] = normalize_history(pd.read_csv(path)) if path.exists() else None
        frame = self.frames[symbol]
        if frame is None or frame.empty or frame['Date'].iloc[-1] <= pd.Timestamp(as_of):
            return frame
        return frame.loc[frame['Date'] <= pd.Timestamp(as_of)]

    def save_frames(self, root):
        frames = [(s, f) for s, f in self.frames.items() if f is not None]
        if not frames or not hasattr(self, 'history_revision'):
            return
        path = root/'.scanner_cache'/'history.npz'
        path.parent.mkdir(exist_ok=True)
        offsets = np.cumsum([0] + [len(f) for _,f in frames])
        temporary = path.with_name('history.tmp.npz')
        np.savez(temporary, revision=self.history_revision, symbols=np.array([s for s,_ in frames]),
                 offsets=offsets, dates=np.concatenate([f['Date'].to_numpy(dtype='datetime64[ns]').astype('int64') for _,f in frames]),
                 values=np.concatenate([f[['Open','High','Low','Close','Volume']].to_numpy(dtype='float64') for _,f in frames]),
                 turnover=np.concatenate([f.get('Turnover', pd.Series(np.nan, index=f.index)).to_numpy(dtype='float64') for _,f in frames]))
        temporary.replace(path)
        del self.history_revision

    def remember(self, key, value):
        self.results[key] = value
        self.results.move_to_end(key)
        if len(self.results) > 32:
            self.results.popitem(last=False)
