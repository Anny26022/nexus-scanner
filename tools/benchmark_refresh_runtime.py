"""Offline, frozen-input comparison against the audited refresh revision.

Reads existing caches; writes only disposable temporary files. Never fetches,
publishes, changes the input cache, or skips any calculation in the compared
stages. Use --limit 0 to compare every symbol in the supplied local snapshot.
"""

import argparse
import copy
import gzip
import hashlib
import json
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / 'DO NOT DELETE EDL PIPELINE'
sys.path[:0] = [str(ROOT), str(ROOT / 'src')]
BASELINE = 'c9abf8b6ba752a6de8c44f541d21cc834df5f64c'


def baseline_module(relative, package=''):
    source = subprocess.check_output(['git', 'show', f'{BASELINE}:{relative}'], cwd=REPO, text=True)
    module = ModuleType('benchmark_baseline')
    module.__file__ = str(REPO / relative)
    module.__package__ = package
    exec(compile(source, module.__file__, 'exec'), module.__dict__)
    return module


def digest(path):
    from pipeline_utils import file_fingerprint
    return file_fingerprint(path)


def comparison(before, after, **metadata):
    return {**metadata, 'before_seconds': round(before, 4), 'after_seconds': round(after, 4),
            'reduction_percent': round(100 * (1 - after / before), 2) if before else None}


def selected(values, limit):
    return values if not limit or len(values) <= limit else [values[i * len(values) // limit] for i in range(limit)]


def benchmark_filings(path, limit):
    import build_filing_history_artifact as current
    previous = baseline_module('DO NOT DELETE EDL PIPELINE/build_filing_history_artifact.py')
    original_classifier = baseline_module('DO NOT DELETE EDL PIPELINE/filing_classification.py')
    previous.classify_filing = original_classifier.classify_filing
    previous.classify_filings = original_classifier.classify_filings
    symbols = json.loads(path.read_text())['symbols']
    names = selected(sorted(symbols), limit)
    rules = [digest(ROOT / name) for name in ('filing_classification.py', 'filing_source_labels.json')]
    summary = {}
    with tempfile.TemporaryDirectory(prefix='nexus-filing-benchmark-') as directory:
        fixture = Path(directory) / 'serialization.json'
        serializer_records = []
        for state in ('cold', 'warm'):
            elapsed, hashes, counts = [], [], []
            for label, module in (('before', previous), ('after', current)):
                sha = hashlib.sha256(); total = 0; seconds = 0
                for index, name in enumerate(names):
                    rows = copy.deepcopy(symbols[name].get('filings', []))
                    cache = Path(directory) / label / f'{name}.json'
                    start = time.perf_counter()
                    output = module.classify_cached(rows, cache, rules)
                    seconds += time.perf_counter() - start
                    sha.update(name.encode())
                    sha.update(json.dumps(output, ensure_ascii=False, separators=(',', ':')).encode())
                    total += len(output)
                    if state == 'cold' and label == 'after' and len(serializer_records) < 80:
                        serializer_records.append({'symbol': name, 'filings': output})
                    if (index + 1) % 100 == 0:
                        print(f'Filings {state} {label}: {index + 1}/{len(names)}', file=sys.stderr, flush=True)
                elapsed.append(seconds); hashes.append(sha.hexdigest()); counts.append(total)
            if hashes[0] != hashes[1] or counts[0] != counts[1]:
                raise AssertionError(f'{state} filing outputs differ')
            summary[state] = comparison(*elapsed, symbols=len(names), filings=counts[0], output_sha256=hashes[0])
            print(f'Filings {state}: {summary[state]}', file=sys.stderr, flush=True)
        from pipeline_utils import save_json_records
        save_json_records(fixture, {'schema_version': 1, 'records': serializer_records}, ensure_ascii=False)
        workers = [json.loads(subprocess.check_output([
            sys.executable, str(Path(__file__).resolve()), '--serializer', mode, '--fixture', str(fixture)
        ], text=True)) for mode in ('before', 'after')]
        if workers[0]['sha256'] != workers[1]['sha256']:
            raise AssertionError('Serialized artifact bytes differ')
        summary['serialization'] = comparison(workers[0]['seconds'], workers[1]['seconds'],
            bytes=workers[0]['bytes'], before_peak_mib=workers[0]['peak_mib'], after_peak_mib=workers[1]['peak_mib'],
            output_sha256=workers[0]['sha256'])
    return summary


def benchmark_breadth(root, limit):
    from edl_pipeline.breadth import pipeline as current
    from edl_pipeline.breadth.config import load_methodology
    previous = baseline_module('DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/pipeline.py', 'edl_pipeline.breadth')
    previous.BreadthAccumulator = baseline_module('DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/aggregates.py').BreadthAccumulator
    stocks = json.load(gzip.open(root / 'all_stocks_fundamental_analysis.json.gz'))
    stocks = selected(sorted(stocks, key=lambda row: row['symbol']), limit)
    universe = [{'Sym': r['symbol'], 'Isin': r['isin'], 'Sid': r['security_id'],
                 'Ltp': r['close'], 'Mcap': r['market_cap_crore'], 'Sector': r.get('sector'),
                 'index_memberships': r.get('index_memberships', [])} for r in stocks]
    method = load_methodology(ROOT / 'breadth_methodology.json')
    filenames = ('breadth.json', 'snapshot.json', 'sector.json', 'contributions.json')
    elapsed, hashes, qualities = [], [], []
    with tempfile.TemporaryDirectory(prefix='nexus-breadth-benchmark-') as directory:
        for label, module in (('before', previous), ('after', current)):
            target = Path(directory) / label; target.mkdir()
            start = time.perf_counter()
            output, _ = module.generate_market_breadth(universe, root / 'ohlcv_data',
                root / 'indices_ohlcv_data/NIFTY.csv', method, target / filenames[0], target / filenames[1],
                generated_at='2026-10-08T00:00:00+00:00', sector_output_path=target / filenames[2],
                contribution_output_path=target / filenames[3])
            elapsed.append(time.perf_counter() - start)
            hashes.append({name: digest(target / name) for name in filenames})
            qualities.append(output['quality'])
            print(f'Breadth {label}: {elapsed[-1]:.3f}s', file=sys.stderr, flush=True)
        if hashes[0] != hashes[1] or qualities[0] != qualities[1]:
            raise AssertionError('Breadth artifact bytes differ')
    return comparison(*elapsed, input_symbols=len(stocks), quality=qualities[0], output_sha256=hashes[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, help='Local pipeline cache directory (read-only)')
    parser.add_argument('--limit', type=int, default=100, help='Evenly sampled symbols; 0 means all')
    parser.add_argument('--only', choices=('filings', 'breadth', 'both'), default='both')
    parser.add_argument('--serializer', choices=('before', 'after'), help=argparse.SUPPRESS)
    parser.add_argument('--fixture', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.serializer:
        from pipeline_utils import save_json, save_json_records
        data = json.loads(args.fixture.read_text())
        with tempfile.TemporaryDirectory(prefix='nexus-serializer-benchmark-') as directory:
            target = Path(directory) / 'output.json'
            writer = save_json if args.serializer == 'before' else save_json_records
            start = time.perf_counter(); writer(target, data, ensure_ascii=False)
            seconds = time.perf_counter() - start
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024 if sys.platform == 'darwin' else 1024)
            print(json.dumps({'seconds': seconds, 'peak_mib': round(peak, 1), 'bytes': target.stat().st_size, 'sha256': digest(target)}))
        return
    if args.data_root is None or args.limit < 0:
        parser.error('--data-root is required and --limit must be nonnegative')
    # Refuse to give a false equivalence verdict after an unrelated formula
    # edit: baseline/current breadth must share these unchanged dependencies.
    for relative in ('DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/indicators.py',
                     'DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/mbi.py',
                     'DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/config.py',
                     'DO NOT DELETE EDL PIPELINE/src/edl_pipeline/breadth/universe.py',
                     'DO NOT DELETE EDL PIPELINE/filing_source_labels.json'):
        original = subprocess.check_output(['git', 'show', f'{BASELINE}:{relative}'], cwd=REPO)
        if original != (REPO / relative).read_bytes():
            raise RuntimeError('Benchmark dependency changed; refresh the baseline: ' + relative)
    report = {'baseline': BASELINE, 'local_python': sys.version.split()[0], 'live_requests': 0}
    if args.only in ('filings', 'both'):
        report['filings'] = benchmark_filings(args.data_root / 'filing_history_data/filing_history.json', args.limit)
    if args.only in ('breadth', 'both'):
        report['breadth'] = benchmark_breadth(args.data_root, args.limit)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
