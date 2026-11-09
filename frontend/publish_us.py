"""Publish one US scanner release: India's row engine on the US root, released under /data/us/.

The rows, technicals, presets and packed format are India's (publish_snapshot.stock_rows), so the app reads a US
release with the code it reads India's with. What differs is declared in the pointer and the context:

- amounts are in millions of dollars (`amountUnit`), filled into the engine's India-named fields by
  edl_pipeline.markets.us.build, and preset floors are US ones (US_ELIGIBILITY);
- SPY is the market benchmark, so it answers the engine's market-benchmark key;
- no F&O, delivery, theme classification, price-band or session archive: those are Indian sources. Rotation groups
  are sectors and industries; the Market page's index cards are the benchmark ETFs.

The release files are content-addressed and live beside India's (`releases/<rev>/`); only the pointer differs:
`site/data/us/current.json`, served at /data/us/current.json. India's current.json is never written here.
"""
import gzip
from datetime import date
import hashlib
import json
import os
from pathlib import Path

import scanner_bridge as bridge
from scanner_cache import ScannerCache
from packed_snapshot import pack_snapshot
from publish_snapshot import OUTPUT, stock_rows, write_json
from public_payload import public
from market_overview import index_closes, market_overview
import rotation_history
from site_data import enabled, upload_pointer, upload_revision
from chart_publication import ROTATION_PREFIX, R2Store, missing_r2_settings
from edl_pipeline.scanner.presets import list_presets
from edl_pipeline.markets import UNITED_STATES
from edl_pipeline.markets.us.tradingview import API_URL as TRADINGVIEW_US
from edl_pipeline.markets.us.calendar import sessions_after

POINTER = 'us/current.json'
# The Market page's index cards: the benchmark ETFs the US root keeps as its indices, in display order.
KEY_INDICES = ('SPY', 'QQQ', 'DIA', 'IWM')
# The Rotation page: benchmark ETFs by code (the code of the universe each measures), the US index memberships as
# stock universes (the Russell 1000 is the core shard most views load), and US floors for a group composite member:
# $300M market cap and $2M a day of 30-session turnover.
ROTATION_BENCHMARKS = {'SPX': 'SPY', 'NDX': 'QQQ', 'DJI': 'DIA', 'RUT': 'IWM'}
US_ROTATION = rotation_history.RotationMarket(
    benchmarks={'SPX': 'S&P 500 (SPY)', 'NDX': 'Nasdaq-100 (QQQ)', 'DJI': 'Dow 30 (DIA)', 'RUT': 'Russell 2000 (IWM)',
                'EW': 'Equal-weight market'},
    primary='SPX',
    universes={'SPX': 'S&P 500', 'NDX': 'NASDAQ 100', 'DJI': 'DOW JONES 30', 'R1K': 'RUSSELL 1000', 'RUT': 'RUSSELL 2000'},
    core='R1K', min_market_cap=300.0, min_turnover30=2.0)


def rotation_objects(root, cache, rows, source_bytes, session, objects):
    """The Rotation page's price history for the US release, as India's: content-addressed objects in `objects`;
    returns the index hash. Groups are sectors and industries (the US has no theme classification)."""
    def closes(symbol):
        frame = cache.frame(root, symbol, session)
        if frame is None or frame.empty:
            return []
        return list(zip(frame['Date'].dt.strftime('%Y-%m-%d'), frame['Close'].astype(float)))
    benchmarks = {code: index_closes(root, source_bytes, symbol, session, csv_name=symbol)[0]
                  for code, symbol in ROTATION_BENCHMARKS.items()}
    # Dated group memberships, carried between runs with the price history (us_daily_refresh.yml).
    ledger_path = root / rotation_history.LEDGER_NAME
    ledger = json.loads(gzip.decompress(ledger_path.read_bytes())) if ledger_path.exists() else None
    index, shards, ledger = rotation_history.build(session, rows, closes, benchmarks, {}, ledger, market=US_ROTATION)
    digest = rotation_history.write_objects(objects, index, shards)
    ledger_path.write_bytes(gzip.compress(json.dumps(ledger, separators=(',', ':'), sort_keys=True).encode(), mtime=0))
    return digest
# The engine's market-benchmark key (snapshot technicals' relative strength and RS new highs).
MARKET_BENCHMARK_KEY = 'NIFTY_50'
# Preset floors in this market's units: $300M market cap, a $5 close, $2M a day of 50-session turnover.
US_ELIGIBILITY = {'minMarketCapCr': 300, 'minPrice': 5, 'minTurnoverCr': 2}
CODE_FILES = ('publish_us.py', 'publish_snapshot.py', 'market_overview.py', 'rotation_history.py', 'scanner_bridge.py', 'packed_snapshot.py', 'snapshot_technicals.py',
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


def listing_age(row, stock, session):
    """Listing age in NYSE sessions. The engine counts the stored history, which here starts in 2021, and so leaves
    an older listing without one; the NYSE calendar counts every session since the listing."""
    listed = stock.get('listing_date')
    if row['metrics'].get('LISTING_AGE_DAYS') is None and listed and row.get('historyAligned'):
        row['metrics']['LISTING_AGE_DAYS'] = sessions_after(date.fromisoformat(listed[:10]), date.fromisoformat(session))


def manifest_for(revision, session, total, *, market_overview=False):
    base = f'/data/revisions/{revision}'
    return {**({'marketOverviewUrl': f'{base}/market-overview.json.gz'} if market_overview else {}),'revision': revision, 'sessionDate': session, 'publishedAt': f'{session}T00:00:00Z', 'schemaVersion': 4,
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
            stock = context['stocks'][row['symbol']]
            dollar_volume = stock.get('dollar_volume')
            row['rupeeVolumeCrore'] = dollar_volume / UNITED_STATES.provider_amount_unit if dollar_volume is not None else None
            listing_age(row, stock, session)
            rows.append(row); default_count += default_match
    finally:
        prepared.close()

    # The rotation ledger is carried state, not an input of the release (as for India).
    source_bytes = {path.name: path.read_bytes() for path in sorted(root.glob('*.json.gz'))
                    if path.name != rotation_history.LEDGER_NAME}
    digest = hashlib.sha256(b'market:us')
    for name, data in source_bytes.items():
        digest.update(name.encode()); digest.update(data)
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
    # The Market page: breadth, sector and industry breadth, and the benchmark ETFs as index cards.
    overview = market_overview(source_bytes, session, KEY_INDICES)
    if overview is not None:
        (generation / 'market-overview.json.gz').write_bytes(gzip.compress(
            json.dumps(overview, separators=(',', ':'), allow_nan=False).encode(), compresslevel=9, mtime=0))
    manifest = manifest_for(revision, session, len(rows), market_overview=overview is not None)
    rotation = output / 'rotation'
    try:
        manifest['rotationHistoryObject'] = rotation_objects(root, cache, rows, source_bytes, session, rotation)
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f'WARNING: US rotation history unavailable for {session}: {error}', flush=True)
    if manifest.get('rotationHistoryObject'):
        # Served next to the pointer when published locally; R2 replaces it with the bucket's address below.
        manifest['rotationUrlTemplate'] = '/data/rotation/{hash}.json.gz'
    write_json(output / POINTER, manifest)
    if enabled():
        store = R2Store()
        upload_revision(store, generation, f'releases/{revision}')
        if manifest.get('rotationHistoryObject'):
            store.upload_rotation(rotation)
            manifest['rotationUrlTemplate'] = f'{store.base_url}/{ROTATION_PREFIX}/{{hash}}.json.gz'
            write_json(output / POINTER, manifest)
        upload_pointer(store, output, POINTER)
    elif os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2':
        raise RuntimeError('R2 configuration missing (' + ', '.join(missing_r2_settings()) + '); the US release is local only.')
    print(f'Published US scanner revision {revision[:12]}: {len(rows)} stocks, {len(presets)} presets', flush=True)
    return manifest


if __name__ == '__main__':
    publish_us(Path(os.environ['EDL_US_BASE_DIR']), workers=min(2, max(0, (os.cpu_count() or 1) - 1)))
