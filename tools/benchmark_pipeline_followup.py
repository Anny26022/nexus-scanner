"""Offline, frozen-input comparisons against a selected Git baseline (default PR #51).

Run with the pipeline's Python environment. All writes are temporary; optional
--data-root histories are read only. No provider requests or publication upload.
"""
import argparse
import contextlib
import copy
import gzip
import hashlib
import io
import json
import os
import resource
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
EDL = ROOT / 'DO NOT DELETE EDL PIPELINE'
sys.path[:0] = [str(EDL), str(EDL / 'src'), str(ROOT / 'frontend')]
BASELINE = 'fa997041b047200a845e7840ef066f8f19f1f70b'


def baseline(relative):
    name = 'baseline_' + Path(relative).stem
    package = None
    if '/breadth/' in relative:
        package = '_benchmark_breadth_' + hashlib.sha256(BASELINE.encode()).hexdigest()[:12]
        if package not in sys.modules:
            namespace = types.ModuleType(package)
            namespace.__path__ = []
            sys.modules[package] = namespace
        name = package + '.' + Path(relative).stem
        if name in sys.modules:
            return sys.modules[name]
        if Path(relative).stem == 'mbi':
            baseline(str(Path(relative).with_name('aggregates.py')))
    module = types.ModuleType(name)
    module.__file__ = str(ROOT / relative)
    module.__package__ = package
    source = subprocess.check_output(['git', 'show', f'{BASELINE}:{relative}'], cwd=ROOT, text=True)
    if package:
        sys.modules[name] = module
    try:
        exec(compile(source, module.__file__, 'exec'), module.__dict__)
    except BaseException:
        if package:
            sys.modules.pop(name, None)
        raise
    return module


def measure(label, function, repeat=1):
    samples = []
    with contextlib.redirect_stdout(io.StringIO()):
        for _ in range(repeat):
            started = time.perf_counter()
            result = function()
            samples.append(time.perf_counter() - started)
    seconds = min(samples)
    print(f'{label}: {seconds:.3f}s', flush=True)
    return result, seconds


def files(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file()}


def history_checks(data_root, count):
    import ohlcv_utils as utils
    import enrich_published_fields as current
    old_utils = baseline('DO NOT DELETE EDL PIPELINE/ohlcv_utils.py')
    old = baseline('DO NOT DELETE EDL PIPELINE/enrich_published_fields.py')
    paths = sorted((data_root / 'ohlcv_data').glob('*.csv'))[:count]
    histories = [utils.read_ohlcv_csv(path) for path in paths]
    expected = sorted({row['Date'] for rows in histories for row in rows})[-30:]
    if not expected:
        raise ValueError('No history dates available for the selected histories')
    before, _ = measure('Recovery full cleaning', lambda: [old_utils.missing_history_sessions(
        old_utils.discard_invalid_ohlcv_rows(old_utils.discard_weekend_rows(rows)), expected) for rows in histories], 3)
    after, _ = measure('Recovery evidenced scan', lambda: [utils.evidenced_history_gaps(rows, expected) for rows in histories], 3)
    assert before == after
    stocks = [{'Symbol': p.stem, 'Listing Date': '2020-01-01'} for p in paths]
    args = ({'as_of_date': expected[-1]}, {}, {}, data_root / 'ohlcv_data')
    before, _ = measure('Published fields baseline', lambda: old.enrich(copy.deepcopy(stocks), *args), 3)
    after, _ = measure('Published fields current', lambda: current.enrich(copy.deepcopy(stocks), *args), 3)
    assert json.dumps(before, allow_nan=False) == json.dumps(after, allow_nan=False)
    print(f'History equivalence: {len(paths)} stocks, {sum(map(len, histories))} candles', flush=True)


def chart_checks(data_root, count, temporary):
    import build_chart_artifacts as current
    import announcement_artifacts as announcements
    old = baseline('DO NOT DELETE EDL PIPELINE/build_chart_artifacts.py')
    paths = sorted((data_root / 'ohlcv_data').glob('*.csv'))[:count]
    candles = [current._load_candles(path, '2026-10-08') for path in paths]
    before, _ = measure('Chart volume events baseline', lambda: [old._volume_events(rows) for rows in candles], 3)
    after, _ = measure('Chart volume events current', lambda: [current._volume_events(rows) for rows in candles], 3)
    assert before == after
    from filing_classification import classify_filings
    filings = classify_filings([{'news_date': f'{year}-01-01', 'caption': f'Corporate guarantee {i}',
                                'descriptor': 'General', 'file_url': f'https://example.com/{i}.pdf'}
                               for i in range(1000) for year in (2020, 2026)])
    payload = {'updated_at': '2026-10-08', 'records': [{'symbol': 'ABC', 'filings': filings}]}
    older = baseline('DO NOT DELETE EDL PIPELINE/announcement_artifacts.py')
    before_dir, after_dir = temporary / 'old_announcements', temporary / 'new_announcements'
    before, _ = measure('Announcements baseline', lambda: older.build_announcements(payload, before_dir, {'ABC'}, '2026-10-08'))
    after, _ = measure('Announcements current', lambda: announcements.build_announcements(payload, after_dir, {'ABC'}, '2026-10-08'))
    assert before == after and files(before_dir) == files(after_dir)


def breadth_checks(data_root, count, temporary):
    from edl_pipeline.breadth import pipeline
    from edl_pipeline.breadth.pipeline import generate_market_breadth
    from edl_pipeline.breadth.config import load_methodology
    method = load_methodology(EDL / 'breadth_methodology.json')
    source = data_root / 'mainboard_scanx_data.json'
    if source.exists():
        rows = json.loads(source.read_text())[:count]
    else:
        with gzip.open(data_root / 'all_stocks_fundamental_analysis.json.gz', 'rt') as handle:
            stocks = json.load(handle)[:count]
        rows = [{**s, 'Sym': s['symbol'], 'ISIN': s['isin'], 'Sid': s['security_id'],
                 'Ltp': s['close'], 'Mcap': s['market_cap_crore']} for s in stocks]
    old_aggregates = baseline('DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/aggregates.py')
    old_mbi = baseline('DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/mbi.py')
    reference = None
    for label, workers in (('baseline', 2), ('current_serial', 0), ('current_parallel', 2)):
        output = temporary / label; output.mkdir()
        with contextlib.ExitStack() as stack:
            if label == 'baseline':
                stack.enter_context(mock.patch.object(pipeline, 'BreadthAccumulator', old_aggregates.BreadthAccumulator))
                stack.enter_context(mock.patch.object(pipeline, 'enrich_records', old_mbi.enrich_records))
            _, _ = measure(f'Breadth {label} workers={workers}', lambda: generate_market_breadth(
                rows, data_root / 'ohlcv_data', data_root / 'indices_ohlcv_data/NIFTY.csv', method,
                output / 'breadth.json', output / 'snapshot.json', generated_at='2026-10-08T00:00:00+00:00',
                sector_output_path=output / 'sectors.json', contribution_output_path=output / 'contributions.json',
                preparation_workers=workers))
        result = files(output)
        if reference is None:
            reference = result
        assert result == reference, 'Breadth artifact bytes changed'
    print('Breadth: all four artifacts byte-identical', flush=True)


def snapshot_checks(temporary, count=64):
    import publish_snapshot as current
    from test_publish_snapshot import SnapshotPublicationTests
    import pandas as pd
    old = baseline('frontend/publish_snapshot.py')
    root = temporary / 'snapshot'; root.mkdir()
    SnapshotPublicationTests().fixture(root)
    with gzip.open(root / 'all_stocks_fundamental_analysis.json.gz', 'rt') as handle:
        sample = json.load(handle)[0]
    stocks = [{**sample, 'symbol': f'S{i:03d}', 'default_screener_eligible': i != 31} for i in range(count)]
    (root / 'all_stocks_fundamental_analysis.json.gz').write_bytes(gzip.compress(json.dumps(stocks).encode(), mtime=0))
    frame = pd.DataFrame({'Date': pd.bdate_range(end='2026-09-30', periods=1000),
                          'Open': 99., 'High': 101., 'Low': 98., 'Close': 100., 'Volume': 100.})
    for i, stock in enumerate(stocks):
        if i == 2:
            continue  # Missing, stale and aligned histories keep all three states.
        frame.iloc[:-1 if i == 3 else None].to_csv(root / 'ohlcv_data' / f"{stock['symbol']}.csv", index=False)
    previous = None
    for label, module, workers in [('baseline', old, None), ('current_serial', current, 0), ('current_parallel', current, 2)]:
        source = temporary / (label + '_edl')
        shutil.copytree(root, source)
        # Code is intentionally included in revision identity. Freeze those
        # inputs too, so every artifact and revision can be compared exactly.
        original = Path.read_bytes
        def read_bytes(path):
            return b'frozen producer code' if path.suffix == '.py' else original(path)
        with mock.patch.object(Path, 'read_bytes', read_bytes), mock.patch.dict('os.environ', {'EDL_CHART_STORAGE': 'local'}, clear=True):
            kwargs = {} if workers is None else {'workers': workers}
            result, _ = measure(f'Snapshot {label} cold', lambda: module.publish(source, temporary / label, **kwargs))
            result, _ = measure(f'Snapshot {label} warm', lambda: module.publish(source, temporary / label, **kwargs), 2)
        digest = files(temporary / label)
        if previous is None:
            previous = digest
        assert previous == digest, 'Snapshot artifact/revision bytes changed'
    print('Snapshot: full revisions and compressed files byte-identical', flush=True)


def cache_checks(data_root, count, temporary):
    from scanner_cache import ScannerCache
    root = temporary / 'numeric'; (root / 'ohlcv_data').mkdir(parents=True)
    paths = sorted((data_root / 'ohlcv_data').glob('*.csv'))[:count]
    for path in paths:
        shutil.copy2(path, root / 'ohlcv_data' / path.name)
    symbols = [path.stem for path in paths]
    def prepare(cache_type):
        cache = cache_type(); cache.refresh(root)
        for symbol in symbols:
            cache.frame(root, symbol, '2030-01-01')
        return cache
    cold, _ = measure('Numeric histories cold CSV', lambda: prepare(ScannerCache))
    cold.save_frames(root)
    def digest(cache):
        result = hashlib.sha256()
        for symbol, frame in cache.frames.items():
            result.update(symbol.encode())
            result.update(frame['Date'].to_numpy(dtype='datetime64[ns]').tobytes())
            result.update(frame[['Open','High','Low','Close','Volume']].to_numpy(dtype='float64').tobytes())
        return result.hexdigest()
    expected = digest(cold)
    for changed_fraction in (0, .85):
        for path in paths[:int(len(paths) * changed_fraction)]:
            staged = root / 'ohlcv_data' / path.name
            stat = staged.stat(); os.utime(staged, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1))
        cache, _ = measure(f'Numeric histories restored; changed={changed_fraction:.0%}', lambda: prepare(ScannerCache))
        assert digest(cache) == expected, 'Numeric frames/order changed'
    print(f'Numeric cache: {len(paths)} histories; arrays and symbol order identical', flush=True)


def filing_checks(temporary, count=200, companies=3, implementation=None):
    import build_filing_history_artifact as current
    from pipeline_utils import save_json
    old = baseline('DO NOT DELETE EDL PIPELINE/build_filing_history_artifact.py')
    symbols = {symbol: {'lodr_backfill_complete': True, 'filings': [
        {'news_date': '2020-01-01', 'caption': f'Corporate guarantee {i}',
         'news_body': 'Background ' * 200, 'file_url': f'https://example.com/{symbol}/{i}.pdf'}
        for i in range(count)]} for symbol in [f'S{i:03d}' for i in reversed(range(companies))]}
    digests = []
    for label, module in [('old_filings', old), ('new_filings', current)]:
        if implementation is not None and label != implementation:
            continue
        root = temporary / label
        save_json(root / 'filing_history_data/filing_history.json', {'updated_at': '2026-10-08', 'symbols': symbols})
        with mock.patch.object(module, 'BASE_DIR', str(root)):
            result, _ = measure(label, module.main)
            assert result == 0
            result, _ = measure(label + ' warm', module.main)
        digests.append(files(root))
        print(f'{label} artifact SHA256: {digests[-1]["filing_history.json"]}', flush=True)
    if len(digests) == 2:
        assert digests[0] == digests[1], 'Filing artifact or classification cache changed'
        print('Filings: cold/warm artifact and classification-cache bytes identical', flush=True)
        from pipeline_utils import compress_file
        from filing_archives import prepare_filing_archives
        root = temporary / 'new_filings'
        compress_file(root / 'filing_history.json', root / 'filing_history.json.gz')
        before, _ = measure('Archives original compression', lambda: prepare_filing_archives(root, temporary / 'old_archives'))
        after, _ = measure('Archives fresh payload reuse', lambda: prepare_filing_archives(root, temporary / 'new_archives',
            compressed_classified=root / 'filing_history.json.gz'))
        assert before == after and files(temporary / 'old_archives') == files(temporary / 'new_archives')
        print('Archives: both retained gzip streams and hashes byte-identical', flush=True)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(f'Process peak RSS: {peak / (1024 * 1024 if sys.platform == "darwin" else 1024):.1f} MiB', flush=True)


def main():
    global BASELINE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--baseline-ref', default=BASELINE)
    parser.add_argument('--count', type=int, default=200)
    parser.add_argument('--component', choices=['all', 'history', 'charts', 'breadth', 'snapshot', 'filings', 'cache'], default='all')
    parser.add_argument('--filing-count', type=int, default=200)
    parser.add_argument('--filing-companies', type=int, default=3)
    parser.add_argument('--filing-implementation', choices=['old_filings', 'new_filings'])
    args = parser.parse_args()
    BASELINE = args.baseline_ref
    with tempfile.TemporaryDirectory(prefix='nexus-followup-benchmark-') as directory:
        temporary = Path(directory)
        for name, function in [('history', history_checks), ('charts', chart_checks), ('breadth', breadth_checks)]:
            if args.component in ('all', name) and args.data_root:
                if name == 'history':
                    function(args.data_root, args.count)
                else:
                    function(args.data_root, args.count, temporary)
        if args.component in ('all', 'snapshot'):
            snapshot_checks(temporary, args.count)
        if args.component in ('all', 'cache') and args.data_root:
            cache_checks(args.data_root, args.count, temporary)
        if args.component in ('all', 'filings'):
            filing_checks(temporary, args.filing_count, args.filing_companies, args.filing_implementation)


if __name__ == '__main__':
    main()
