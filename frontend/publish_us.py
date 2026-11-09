"""Publish one US scanner release: India's row engine on the US root, released under /data/us/.

The rows, technicals, presets and packed format are India's (publish_snapshot.stock_rows), so the app reads a US
release with the code it reads India's with. What differs is declared in the pointer and the context:

- amounts are in millions of dollars (`amountUnit`), filled into the engine's India-named fields by
  edl_pipeline.markets.us.build, and preset floors are US ones (US_ELIGIBILITY);
- SPY is the market benchmark, so it answers the engine's market-benchmark key;
- no TradingView, F&O, delivery, theme, rotation, price-band or session archive: those are Indian sources.

The release files are content-addressed and live beside India's (`releases/<rev>/`); only the pointer differs:
`site/data/us/current.json`, served at /data/us/current.json. India's current.json is never written here.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path

import scanner_bridge as bridge
from scanner_cache import ScannerCache
from packed_snapshot import pack_snapshot
from publish_snapshot import OUTPUT, stock_rows, write_json
from public_payload import public
from site_data import enabled, upload_pointer, upload_revision
from chart_publication import R2Store, missing_r2_settings
from edl_pipeline.scanner.presets import list_presets
from edl_pipeline.markets import UNITED_STATES
from edl_pipeline.markets.us.tradingview import API_URL as TRADINGVIEW_US

POINTER = 'us/current.json'
# The engine's market-benchmark key (snapshot technicals' relative strength and RS new highs).
MARKET_BENCHMARK_KEY = 'NIFTY_50'
# Preset floors in this market's units: $300M market cap, a $5 close, $2M a day of 50-session turnover.
US_ELIGIBILITY = {'minMarketCapCr': 300, 'minPrice': 5, 'minTurnoverCr': 2}
CODE_FILES = ('publish_us.py', 'publish_snapshot.py', 'scanner_bridge.py', 'packed_snapshot.py', 'snapshot_technicals.py',
              'public_payload.py', 'src/data/snapshotTechnicals.json', 'src/data/presetEligibility.json')


def us_context(root):
    context = bridge._load_context(root)
    session = context.get('financial_history_as_of')
    if not session:
        raise RuntimeError('The US root has no breadth session; run edl_pipeline.markets.us.build first.')
    benchmark = context['benchmarks'].get(UNITED_STATES.benchmark)
    if benchmark is None:
        raise RuntimeError(f'The US root has no {UNITED_STATES.benchmark} history.')
    context['benchmarks'][MARKET_BENCHMARK_KEY] = benchmark
    context['amount_unit'] = UNITED_STATES.provider_amount_unit
    context['tradingview'] = (TRADINGVIEW_US, UNITED_STATES.currency)
    return context, session


def manifest_for(revision, session, total):
    base = f'/data/revisions/{revision}'
    return {'revision': revision, 'sessionDate': session, 'publishedAt': f'{session}T00:00:00Z', 'schemaVersion': 4,
            'market': UNITED_STATES.id, 'currency': UNITED_STATES.currency, 'amountUnit': UNITED_STATES.provider_amount_unit,
            'totalStocks': total, 'datasetUrl': f'{base}/stocks.json', 'datasetGzipUrl': f'{base}/stocks.json.gz',
            'datasetPackedGzipUrl': f'{base}/stocks.packed.json.gz', 'iposUrl': f'{base}/ipos.json.gz'}


def publish_us(root, output=OUTPUT, *, workers=0):
    root, output = Path(root), Path(output)
    cache = ScannerCache(); cache.refresh(root)
    context, session = us_context(root)
    presets = {p['id']: bridge.translate(p['id'], US_ELIGIBILITY) for p in list_presets()}
    default = bridge.group('AND', bridge.translate('mom_rvol', {'minRvol': 1.5, 'maxRvol': 20}),
                           bridge.translate('trend_price_vs_ma', {'maType': 'SMA', 'maPeriod': 50, 'operator': 'above', 'thresholdPct': 0}))
    tasks = ((stock, cache.frame(root, stock['symbol'], session), [])
             for stock in context['stocks'].values() if stock.get('default_screener_eligible', True))
    rows, default_count = [], 0
    prepared = stock_rows(tasks, context, session, presets, default, workers)
    try:
        for row, default_match in prepared:
            # The row engine states traded value in ₹ crore; restate it in millions of dollars.
            dollar_volume = context['stocks'][row['symbol']].get('dollar_volume')
            row['rupeeVolumeCrore'] = dollar_volume / UNITED_STATES.provider_amount_unit if dollar_volume is not None else None
            rows.append(row); default_count += default_match
    finally:
        prepared.close()

    digest = hashlib.sha256(b'market:us')
    for path in sorted(root.glob('*.json.gz')):
        digest.update(path.name.encode()); digest.update(path.read_bytes())
    here = Path(__file__).parent
    for name in CODE_FILES:
        digest.update(name.encode()); digest.update((here / name).read_bytes())
    digest.update(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode())
    revision = digest.hexdigest()

    rows = public(rows)
    payload = {'revision': revision, 'asOfDate': session, 'market': UNITED_STATES.id, 'currency': UNITED_STATES.currency,
               'amountUnit': UNITED_STATES.provider_amount_unit, 'totalStocks': len(rows), 'stocks': rows,
               'technicalMetricsVersion': 1, 'extendedMetricsVersion': 1, 'presetRuleMatchesVersion': 1,
               'referenceCounts': {'rvol15Sma50': default_count}}
    generation = output / 'revisions' / revision
    stock_bytes = write_json(generation / 'stocks.json', payload)
    (generation / 'stocks.json.gz').write_bytes(gzip.compress(stock_bytes, compresslevel=6, mtime=0))
    packed = json.dumps(pack_snapshot(payload), separators=(',', ':'), allow_nan=False).encode()
    (generation / 'stocks.packed.json.gz').write_bytes(gzip.compress(packed, compresslevel=9, mtime=0))
    # US listings are not tracked yet; the app still expects the file.
    (generation / 'ipos.json.gz').write_bytes(gzip.compress(b'{"records":[]}', mtime=0))
    manifest = manifest_for(revision, session, len(rows))
    write_json(output / POINTER, manifest)
    if enabled():
        store = R2Store()
        upload_revision(store, generation, f'releases/{revision}')
        upload_pointer(store, output, POINTER)
    elif os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2':
        raise RuntimeError('R2 configuration missing (' + ', '.join(missing_r2_settings()) + '); the US release is local only.')
    print(f'Published US scanner revision {revision[:12]}: {len(rows)} stocks, {len(presets)} presets', flush=True)
    return manifest


if __name__ == '__main__':
    publish_us(Path(os.environ['EDL_US_BASE_DIR']), workers=min(2, max(0, (os.cpu_count() or 1) - 1)))
