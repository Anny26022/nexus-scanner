"""Publish one immutable, validated scanner generation and its small pointer."""
import gzip
import hashlib
import json
import os
import time
from pathlib import Path
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context

import numpy as np

import scanner_bridge as bridge
from scanner_cache import ScannerCache
from packed_snapshot import pack_snapshot
from chart_publication import chart_preflight, charts_enabled, complete_release
from edl_pipeline.scanner.presets import list_presets
from edl_pipeline.scanner.financials import financial_value, finite_number
from edl_pipeline.scanner.calculation_cache import calculation_cache
from screen_trend_conditions import _delivery_records

OUTPUT = Path(__file__).resolve().parent/'public/data'


def write_json(path, payload):
    data=json.dumps(payload, separators=(',', ':'), allow_nan=False).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary=path.with_name(path.name+'.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)
    return data


def delivery_lookback(expressions):
    """Derive the view from actual rules; fall back to full history if unsure."""
    maximum = 0
    pending = list(expressions)
    while pending:
        node = pending.pop()
        if isinstance(node, list):
            pending.extend(node)
            continue
        if not isinstance(node, dict):
            return None
        for key in ('children', 'conditions', 'expression', 'child'):
            if key in node:
                pending.append(node[key])
        try:
            spec = bridge.normalize_condition_spec(node)
            if spec['condition'] in {'delivery_percent_spike', 'delivery_percent'}:
                window = int(spec.get('fired_within', 1)) if spec['condition'] == 'delivery_percent_spike' else 1
                if window <= 0:
                    return None
                maximum = max(maximum, window)
        except (TypeError, ValueError, OverflowError):
            return None
    return maximum


def primitive_keys(expressions):
    """Canonical memo keys depend on the rules, not the security."""
    keys = {}
    pending = list(expressions)
    while pending:
        node = pending.pop()
        if node['type'] == 'group':
            pending.extend(node['children'])
        elif node['type'] == 'preset':
            pending.append(node['expression'])
        else:
            keys[id(node)] = json.dumps(node, sort_keys=True)
    return keys


def elapsed(label, started):
    now = time.perf_counter()
    print(f'Snapshot {label} elapsed: {now - started:.2f}s', flush=True)
    return now

def _stock_row(task, context, session, presets, default, memo_keys):
    stock, frame, stock_delivery = task
    symbol = stock['symbol']
    row=bridge.stock_row(stock,context['rs_ratings'] if context.get('rs_ratings_as_of')==session else {})
    aligned=frame is not None and not frame.empty and frame['Date'].iloc[-1].strftime('%Y-%m-%d')==session
    row['asOfDate']=session if aligned else stock.get('as_of_date')
    row['metadataAsOfDate']=stock.get('as_of_date')
    row['historyAligned']=bool(aligned)
    row['indexMemberships']=stock.get('index_memberships') or []
    metrics={}
    if aligned:
        last=frame.iloc[-1]
        for field in ('open','high','low','close','volume'):
            row[field]=float(last[field.title()])
        for period in (10,20,50,200):
            metrics[f'sma{period}']=float(frame['Close'].tail(period).mean()) if len(frame)>=period else None
        avg=frame['Volume'].iloc[-21:-1].mean() if len(frame)>=21 else None
        row['rvol']=float(last['Volume']/avg) if avg is not None and avg>0 else None
        row['changePct']=float((last['Close']/frame['Close'].iloc[-2]-1)*100) if len(frame)>=2 else None
        for field in ('sma20','sma50','sma200'):
            row[field]=metrics[field]
        for period in (5,21,63,126,252):
            metrics[f'return{period}']=float((last['Close']/frame['Close'].iloc[-1-period]-1)*100) if len(frame)>period else None
        metrics['gapPct']=float((last['Open']/frame['Close'].iloc[-2]-1)*100) if len(frame)>1 else None
        turnover = frame['Close'] * frame['Volume'] if len(frame) >= 20 else None
        for period in (20,50,100):
            metrics[f'turnover{period}']=float(turnover.tail(period).mean()/1e7) if len(frame)>=period else None
    row['metrics']=metrics
    row['historyMetadata']=stock.get('history_metadata')
    row['financialMetadata']=stock.get('financial_metadata')
    row['dividendExDate']=stock.get('dividend_ex_date')
    row['vwapAsOfDate']=stock.get('vwap_as_of_date')
    row['peRatio']=financial_value(context,stock,{'condition':'pe_ratio'},bridge.date.fromisoformat(session),finite_number(stock.get('market_cap_crore')))[0]
    row['fnoBan']=bool(context['fno_ban_symbols'].get(symbol)) if context.get('fno_ban_available') and context.get('fno_ban_trade_date')==session else None
    row['roePct']=finite_number(stock.get('roe_percent'))
    row['freeFloatPct']=finite_number(stock.get('free_float_percent'))
    # Each distinct primitive is calculated only once per security.
    memo={}
    def evaluate(node):
        if node['type']=='group':
            return bridge.combine([evaluate(n) for n in node['children']],node['op'])
        if node['type']=='preset':
            baseline=bridge.preset_baseline(stock) if stock.get('as_of_date')==session else None
            return False if baseline is False else bridge.combine([baseline,evaluate(node['expression'])],'AND')
        key=memo_keys[id(node)]
        if key not in memo:
            memo[key]=bridge.evaluate(node,stock,frame,context,session,set(),stock_delivery)
        return memo[key]
    # Frames/benchmarks remain immutable while all presets for this stock
    # reuse their underlying series, alignment and persistence state.
    with calculation_cache():
        row['presetMatches']={key:evaluate(node) for key,node in presets.items()}
        default_match = evaluate(default) is True
    return row, default_match


def _initialize_rows(context, session, presets, default):
    global _ROW_INPUTS
    _ROW_INPUTS = (context, session, presets, default, primitive_keys([*presets.values(), default]))


def _row_chunk(tasks):
    try:
        return [_stock_row(task, *_ROW_INPUTS) for task in tasks]
    except Exception as error:
        symbols = ', '.join(str(task[0].get('symbol')) for task in tasks)
        raise RuntimeError(f'Frontend row preparation failed for symbols: {symbols}') from error


def stock_rows(tasks, context, session, presets, default, workers=0):
    if not workers:
        keys = primitive_keys([*presets.values(), default])
        for task in tasks:
            yield _stock_row(task, context, session, presets, default, keys)
        return
    executor = ProcessPoolExecutor(max_workers=workers, mp_context=get_context('spawn'),
                                   initializer=_initialize_rows, initargs=(context, session, presets, default))
    tasks = iter(tasks)
    pending = deque()
    def submit():
        chunk = []
        for _ in range(8):
            task = next(tasks, None)
            if task is None:
                break
            chunk.append(task)
        if chunk:
            pending.append(executor.submit(_row_chunk, chunk))
    try:
        for _ in range(2 * workers):
            submit()
        while pending:
            yield from pending.popleft().result()
            submit()
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)


def publish(root=bridge.ROOT, output=OUTPUT, *, workers=0):
    started = time.perf_counter()
    cache=ScannerCache(); cache.refresh(root)
    starting_revision=cache.revision
    source_files=[p for p in sorted(root.glob('*.json.gz')) if p.name!='filing_history.json.gz']
    source_bytes={p.name:p.read_bytes() for p in source_files}
    context=bridge._load_context(root)
    session=context['financial_history_as_of']
    presets={p['id']:bridge.translate(p['id'],{}) for p in list_presets()}
    default=bridge.group('AND',bridge.translate('mom_rvol',{'minRvol':1.5,'maxRvol':20}),bridge.translate('trend_price_vs_ma',{'maType':'SMA','maPeriod':50,'operator':'above','thresholdPct':0}))
    lookback=delivery_lookback([*presets.values(),default])
    windows={} if lookback is not None else None
    if windows is not None:
        # Preserve original stock/frame insertion order in the frozen NPZ.
        for stock in context['stocks'].values():
            if not stock.get('default_screener_eligible',True):
                continue
            symbol=stock['symbol']; frame=cache.frame(root,symbol,session)
            if lookback and frame is not None and not frame.empty and frame['Date'].iloc[-1].strftime('%Y-%m-%d')==session:
                windows[symbol]=set(frame.tail(lookback)['Date'].dt.strftime('%Y-%m-%d'))
    started = elapsed('context and frames', started)
    delivery_bytes={}
    cached_records={}
    csv_payloads={}
    for folder in ('delivery_history_data','eod2_delivery_history_data'):
        for p in (root/folder).glob('*.json'):
            # The official daily payloads compress well.  Freeze their content
            # without adding another full raw archive to every revision.
            raw=p.read_bytes()
            delivery_bytes[f'{p.relative_to(root)}.gz']=gzip.compress(raw,mtime=0)
            if windows is not None and folder=='delivery_history_data' and p.match('????-??-??.json'):
                try:
                    records=json.loads(raw.decode('utf-8')).get('records',[])
                except (ValueError,AttributeError):
                    records=[]
                cached_records[p]=list(_delivery_records(records,windows=windows))
                del records
        for p in (root/folder).glob('*.csv'):
            delivery_bytes[str(p.relative_to(root))]=p.read_bytes()
            if folder=='eod2_delivery_history_data':
                csv_payloads[p]=delivery_bytes[str(p.relative_to(root))]
    chart_root = root / 'chart_artifacts'
    include_charts = charts_enabled()
    if include_charts:
        chart_preflight(chart_root, session)
    delivery=bridge._load_delivery_history(root/'delivery_history_data',None,root/'eod2_delivery_history_data',
                                          windows=windows,cached_records=cached_records,csv_payloads=csv_payloads)
    started = elapsed('delivery freezing and loading', started)
    rows=[]; default_count=0
    if workers is None:
        # Programmatic callers stay serial by default. The guarded CLI opts in
        # only for large universes, leaving a core for parent I/O and packing.
        workers = min(2, max(0, (os.cpu_count() or 1) - 1)) if len(context['stocks']) >= 256 else 0
    tasks = ((stock, cache.frame(root, stock['symbol'], session), delivery.get(stock['symbol'], []))
             for stock in context['stocks'].values() if stock.get('default_screener_eligible', True))
    prepared_rows = stock_rows(tasks, context, session, presets, default, workers)
    try:
        for row, default_match in prepared_rows:
            rows.append(row)
            default_count += default_match
    finally:
        prepared_rows.close()
    started = elapsed('stock metrics and presets', started)
    cache.save_frames(root)
    started = elapsed('history packing', started)
    code_files=[*sorted((root/'src/edl_pipeline/scanner').glob('*.py')),Path(__file__),Path(bridge.__file__),Path(__file__).with_name("packed_snapshot.py")]
    digest=hashlib.sha256()
    for name, data in {**source_bytes,**delivery_bytes}.items():
        digest.update(name.encode()); digest.update(data)
    for file in code_files:
        digest.update(file.name.encode()); digest.update(file.read_bytes())
    digest.update(b'charts-enabled' if include_charts else b'scanner-only')
    for file in sorted(chart_root.glob('*.json*')) if include_charts else []:
        digest.update(file.name.encode()); digest.update(file.read_bytes())
    packed=root/'.scanner_cache/history.npz'
    if packed.exists():
        with np.load(packed,allow_pickle=False) as data:
            for name in ('symbols','offsets','dates','values'):
                digest.update(data[name].tobytes())
    cache.refresh(root)
    if cache.revision!=starting_revision:
        raise RuntimeError('Source data changed during snapshot publication; previous revision remains active. Retry publication.')
    digest.update(json.dumps(rows,sort_keys=True,separators=(',',':')).encode())
    revision=digest.hexdigest()
    generation=output/'revisions'/revision
    backend=root/'.scanner_cache/revisions'/revision
    generation.mkdir(parents=True,exist_ok=True); backend.mkdir(parents=True,exist_ok=True)
    # Freeze backend inputs before exposing the revision. History is numeric NPZ.
    for name, data in {**source_bytes,**delivery_bytes}.items():
        destination=backend/name
        if not destination.exists():
            destination.parent.mkdir(parents=True,exist_ok=True)
            destination.write_bytes(data)
    (backend/'ohlcv_data').mkdir(exist_ok=True)
    history_revision=None
    if packed.exists():
        (backend/'.scanner_cache').mkdir(exist_ok=True)
        if not (backend/'.scanner_cache/history.npz').exists():
            (backend/'.scanner_cache/history.npz').write_bytes(packed.read_bytes())
        with np.load(backend/'.scanner_cache/history.npz',allow_pickle=False) as data:
            history_revision=str(data['revision'])
    if not (backend/'scanner_revision.json').exists():
        write_json(backend/'scanner_revision.json',{'revision':revision,'historyRevision':history_revision})
    started = elapsed('revision hashing and backend freezing', started)
    payload={'revision':revision,'asOfDate':session,'totalStocks':len(rows),'stocks':rows,'referenceCounts':{'rvol15Sma50':default_count}}
    stock_bytes=write_json(generation/'stocks.json',payload)
    # Keep the full financial series out of every lightweight scanner row.
    histories = {symbol: stock["financial_statement_history"] for symbol, stock in context['stocks'].items()
                 if stock.get("financial_statement_history")}
    history_path = generation/'financial-history.json.gz'
    history_temporary = history_path.with_name(history_path.name+'.tmp')
    history_temporary.write_bytes(gzip.compress(json.dumps(histories, separators=(',', ':'), allow_nan=False).encode(), mtime=0))
    history_temporary.replace(history_path)
    compressed=gzip.compress(stock_bytes,compresslevel=6,mtime=0)
    compressed_path=generation/'stocks.json.gz'
    temporary=compressed_path.with_name(compressed_path.name+'.tmp')
    temporary.write_bytes(compressed); temporary.replace(compressed_path)
    packed_bytes = json.dumps(pack_snapshot(payload), separators=(',', ':'), allow_nan=False).encode()
    packed_path = generation/'stocks.packed.json.gz'
    temporary = packed_path.with_name(packed_path.name+'.tmp')
    temporary.write_bytes(gzip.compress(packed_bytes, compresslevel=9, mtime=0))
    temporary.replace(packed_path)
    with gzip.open(root/'ipo_screener.json.gz','rt') as handle:
        ipos=json.load(handle)
    ipo_payload=ipos if isinstance(ipos,dict) else {'records':ipos}
    ipo_bytes=json.dumps(ipo_payload,separators=(',', ':'),allow_nan=False).encode()
    (generation/'ipos.json.gz').write_bytes(gzip.compress(ipo_bytes,compresslevel=9,mtime=0))
    calendar_bytes=source_bytes.get('earnings_calendar.json.gz')
    if calendar_bytes is not None:
        calendar_path=generation/'earnings-calendar.json.gz'
        temporary=calendar_path.with_name(calendar_path.name+'.tmp')
        temporary.write_bytes(calendar_bytes); temporary.replace(calendar_path)
    manifest={'revision':revision,'sessionDate':session,'publishedAt':f'{session}T00:00:00Z','schemaVersion':4,'totalStocks':len(rows),'datasetUrl':f'/data/revisions/{revision}/stocks.json','iposUrl':f'/data/revisions/{revision}/ipos.json.gz','datasetGzipUrl':f'/data/revisions/{revision}/stocks.json.gz'}
    if calendar_bytes is not None:
        manifest['earningsCalendarUrl']=f'/data/revisions/{revision}/earnings-calendar.json.gz'
    manifest['datasetPackedGzipUrl'] = f'/data/revisions/{revision}/stocks.packed.json.gz'
    manifest['financialHistoryUrl'] = f'/data/revisions/{revision}/financial-history.json.gz'
    started = elapsed('serialization and compression', started)
    manifest = complete_release(chart_root, output, manifest)
    elapsed('release completion', started)
    print(f'Published scanner revision {revision[:12]}: {len(rows)} stocks, {len(presets)} presets',flush=True)
    return manifest


if __name__=='__main__':
    publish(Path(os.environ.get('EDL_BASE_DIR',bridge.ROOT)), workers=None)
