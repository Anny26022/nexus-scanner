"""Offline byte-equivalence and timing checks for the critical-path follow-up.

Run with the pipeline environment. Optional --data-root CSVs are read-only;
all generated objects are temporary. No provider requests or publication.
"""
import argparse
import copy
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
from concurrent.futures import Future
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
EDL = ROOT / 'DO NOT DELETE EDL PIPELINE'
sys.path[:0] = [str(EDL), str(EDL / 'src')]


def baseline(ref, name):
    module = types.ModuleType('baseline_' + name)
    module.__file__ = str(EDL / (name + '.py'))
    source = subprocess.check_output(['git', 'show', f'{ref}:DO NOT DELETE EDL PIPELINE/{name}.py'], cwd=ROOT)
    exec(compile(source, module.__file__, 'exec'), module.__dict__)
    return module


def measure(label, function):
    start = time.perf_counter()
    result = function()
    print(f'{label}: {time.perf_counter() - start:.3f}s', flush=True)
    return result


def objects(directory):
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in directory.glob('*.json.gz')}


def fetch_schedule(report):
    """Replay measured durations without sleeping or sending provider requests."""
    from edl_pipeline import runner
    from edl_pipeline.artifacts import OHLCV_FETCH_LANE, PHASE2_SCRIPTS, REQUIRED_PHASE2_SCRIPTS
    scripts = json.loads(report.read_text())['scripts']
    lanes = {'enrichment': ['fetch_company_filings.py'], 'ohlcv': list(OHLCV_FETCH_LANE),
             'reference': ['fetch_ipo_provider_data.py', 'fetch_scanx_ipo_data.py'],
             'independent': [name for name in PHASE2_SCRIPTS if name != 'fetch_company_filings.py']}
    durations = {name: scripts[name]['elapsed'] + scripts[name].get('validation_elapsed', 0)
                 for names in lanes.values() for name in names}
    availability = [0.] * 3
    for names in lanes.values():
        worker = min(range(3), key=availability.__getitem__)
        availability[worker] += sum(durations[name] for name in names)
    clock = 0.
    ends = {}
    class Executor:
        def __init__(self, **kwargs):
            assert kwargs['max_workers'] == 3
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def submit(self, function, name, phase, required):
            future = Future()
            ends[future] = (clock + durations[name], required)
            return future
    def wait(pending, **kwargs):
        nonlocal clock
        clock = min(ends[future][0] for future in pending)
        done = {future for future in pending if ends[future][0] <= clock}
        for future in done:
            future.set_result(runner.ScriptResult(True, ends[future][1]))
        return done, set(pending) - done
    with mock.patch.object(runner, 'ThreadPoolExecutor', Executor), mock.patch.object(runner, 'wait', wait):
        results = runner.run_script_lanes({lane: [(name, '', name in REQUIRED_PHASE2_SCRIPTS) for name in names]
                                          for lane, names in lanes.items()})
    assert all(list(results[lane]) == names for lane, names in lanes.items())
    print(f'Fetch scheduling fixed-duration model: {max(availability):.3f}s -> {clock:.3f}s '
          f'({max(availability) - clock:.3f}s reduction; not a live measurement)', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref', default='8be8ce48')
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--run-report', type=Path)
    parser.add_argument('--symbols', type=int, default=256)
    parser.add_argument('--announcement-symbols', type=int, default=64)
    parser.add_argument('--filings', type=int, default=1000)
    args = parser.parse_args()
    if min(args.symbols, args.announcement_symbols, args.filings) < 1:
        parser.error('sample sizes must be positive')
    import announcement_artifacts as announcements
    import filing_classification as classification
    import standardize_stock_artifact as standardize
    import enrich_published_fields as enrichment
    if args.run_report:
        fetch_schedule(args.run_report)
    old_standardize = baseline(args.baseline_ref, 'standardize_stock_artifact')
    old_classification = baseline(args.baseline_ref, 'filing_classification')
    with gzip.open(EDL / 'all_stocks_fundamental_analysis.json.gz', 'rt') as handle:
        stocks = json.load(handle)[:args.symbols]
    before = measure('Standardization baseline (published canonical input)',
                     lambda: [old_standardize.canonicalize_stock(stock) for stock in stocks])
    after = measure('Standardization current (published canonical input)',
                    lambda: [standardize.canonicalize_stock(stock) for stock in stocks])
    assert json.dumps(before, allow_nan=False) == json.dumps(after, allow_nan=False)
    evidence = classification.classify_filing({'caption': 'Received commercial purchase order'})
    filings = [{'news_id': str(n), 'news_date': f'{2020 + n % 7}-01-01T10:00:00+05:30',
                'caption': f'Commercial purchase order {n % 20}', 'news_body': 'Commercial purchase order. ' * 40,
                'file_url': f'https://www.bseindia.com/{n}.pdf', 'source_endpoint': 'company_filings'}
               for n in range(args.filings)]
    duplicated = [*filings, *[{**row, 'source_endpoint': 'lodr'} for row in filings]]
    before = measure('Filing identity/normalization baseline', lambda: old_classification.classify_filings(
        duplicated, classify=lambda row: evidence))
    after = measure('Filing identity/normalization current', lambda: classification.classify_filings(
        duplicated, classify=lambda row: evidence))
    assert json.dumps(before, allow_nan=False) == json.dumps(after, allow_nan=False)
    records = [{'symbol': f'S{n:04d}', 'filings': after} for n in range(args.announcement_symbols)]
    payload = {'updated_at': '2026-10-09T12:00:00+05:30', 'records': records}
    with tempfile.TemporaryDirectory(prefix='nexus-critical-path-') as folder:
        root = Path(folder)
        old_announcements = baseline(args.baseline_ref, 'announcement_artifacts')
        before = measure('Announcements baseline cold', lambda: old_announcements.build_announcements(
            payload, root / 'before', {row['symbol'] for row in records}, '2026-10-09', root / 'old-cache'))
        warmed = measure('Announcements baseline warm', lambda: old_announcements.build_announcements(
            payload, root / 'before', {row['symbol'] for row in records}, '2026-10-09', root / 'old-cache'))
        assert warmed == before
        for label in ('cold', 'warm'):
            observed = measure('Announcements current parallel ' + label, lambda: announcements.build_announcements(
                {**payload, 'records': iter(records)}, root / 'after', {row['symbol'] for row in records},
                '2026-10-09', root / 'new-cache', workers=2))
            assert observed == before and objects(root / 'before') == objects(root / 'after')
        if args.data_root:
            selected = [stock for stock in stocks if (args.data_root / 'ohlcv_data' / f"{stock['symbol']}.csv").exists()]
            legacy = [{**stock, 'Symbol': stock['symbol'], 'Listing Date': stock.get('listing_date')} for stock in selected]
            inputs = ({'as_of_date': '2026-10-09'}, {}, {}, args.data_root / 'ohlcv_data')
            old_enrichment = baseline(args.baseline_ref, 'enrich_published_fields')
            expected = measure('Published fields baseline (real histories)', lambda: old_enrichment.enrich(copy.deepcopy(legacy), *inputs))
            actual = measure('Published fields parallel (real histories)', lambda: enrichment.enrich_parallel(copy.deepcopy(legacy), *inputs, 2))
            assert json.dumps(expected, allow_nan=False) == json.dumps(actual, allow_nan=False)
            print(f'Enrichment equivalence: {len(selected)} real histories', flush=True)
    print('All compared records and announcement object bytes are identical.', flush=True)


if __name__ == '__main__':
    main()
