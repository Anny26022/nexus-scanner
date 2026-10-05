"""Publish one immutable, validated scanner generation and its small pointer."""
import gzip
import hashlib
import json
import os
import tempfile
from pathlib import Path
from datetime import datetime, timezone

import numpy as np

import scanner_bridge as bridge
from scanner_cache import ScannerCache
from chart_publication import chart_preflight, charts_enabled, complete_release
from scanner_pack_publication import BaseHistoryArchive, build_private_scanner_pack, publish_private_pack
from scanner_identity import checked_identity
from edl_pipeline.scanner.presets import list_presets
from edl_pipeline.scanner.base_publication import build_base_records, compact_base_records
from edl_pipeline.scanner.financials import financial_value, finite_number
from edl_pipeline.scanner.turnover import average_turnover_crore
from edl_pipeline.scanner.indicators import true_range, wilder_average

OUTPUT = Path(__file__).resolve().parent/'public/data'


def write_json(path, payload):
    data=json.dumps(payload, separators=(',', ':'), allow_nan=False).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary=path.with_name(path.name+'.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)
    return data


CORE_FIELDS = {
    'symbol','name','listingDate','sector','industry','series','close','changePct','open','high','low','volume',
    'rupeeVolumeCrore','marketCapCrore','indexMemberships','asOfDate','metadataAsOfDate','historyAligned',
    'dataCompleteness','historyMetadata','financialMetadata','rvol','rsi14','rsRating','deliveryPct','isFno','peRatio',
}
TECHNICAL_FIELDS = {
    'symbol','rvol','rsi14','adr20Pct','atr14','sma20','sma50','sma200','ema20','ema50','ema200',
    'dist52wHighPct','dist52wLowPct','distAthPct','rsRating','rsRating1m','rsRating3m','rsRating6m','rsRating12m','metrics','presetMatches','allTimeHigh',
    'allTimeLow','return5yPct','bases',
}


def _pack_payload(revision, session, rows, fields):
    return {'schemaVersion':7,'revision':revision,'asOfDate':session,'totalStocks':len(rows),
            'stocks':[{key:row.get(key) for key in fields if key in row} for row in rows]}


def _write_pack(generation, name, payload):
    raw=json.dumps(payload,separators=(',',':'),sort_keys=True,allow_nan=False).encode()
    compressed=gzip.compress(raw,compresslevel=6,mtime=0)
    path=generation/f'{name}.json.gz'
    temporary=path.with_name(path.name+'.tmp');temporary.write_bytes(compressed);temporary.replace(path)
    return {'url':f'/data/revisions/{payload["revision"]}/{name}.json.gz','bytes':len(compressed),
            'sha256':hashlib.sha256(compressed).hexdigest(),'uncompressedBytes':len(raw),
            'uncompressedSha256':hashlib.sha256(raw).hexdigest(),'encoding':'gzip','schemaVersion':7}


def publish(root=bridge.ROOT, output=OUTPUT):
    with tempfile.TemporaryDirectory(prefix='nexus-base-history-') as archive_directory:
        return _publish(root, output, Path(archive_directory))


def _publish(root, output, archive_directory):
    cache=ScannerCache(); cache.refresh(root)
    starting_revision=cache.revision
    source_files=[p for p in sorted(root.glob('*.json.gz')) if p.name!='filing_history.json.gz']
    source_bytes={p.name:p.read_bytes() for p in source_files}
    delivery_bytes={}
    for folder in ('delivery_history_data','eod2_delivery_history_data'):
        for p in (root/folder).glob('*.json'):
            # The official daily payloads compress well.  Freeze their content
            # without adding another full raw archive to every revision.
            delivery_bytes[f'{p.relative_to(root)}.gz']=gzip.compress(p.read_bytes(),mtime=0)
        for p in (root/folder).glob('*.csv'):
            delivery_bytes[str(p.relative_to(root))]=p.read_bytes()
    context=bridge._load_context(root)
    session=context['financial_history_as_of']
    chart_root = root / 'chart_artifacts'
    include_charts = charts_enabled()
    if include_charts:
        chart_preflight(chart_root, session)
    presets={p['id']:bridge.translate(p['id'],{}) for p in list_presets()}
    default=bridge.group('AND',bridge.translate('mom_rvol',{'minRvol':1.5,'maxRvol':20}),bridge.translate('trend_price_vs_ma',{'maType':'SMA','maPeriod':50,'operator':'above','thresholdPct':0}))
    delivery=bridge._load_delivery_history(root/'delivery_history_data',None,root/'eod2_delivery_history_data')
    base_frames={}
    for symbol,stock in context['stocks'].items():
        if not stock.get('default_screener_eligible',True): continue
        frame=cache.frame(root,symbol,session)
        if frame is not None and not frame.empty and frame.Date.iloc[-1].strftime('%Y-%m-%d')==session:
            base_frames[symbol]=frame
    context['base_rs_history']={}
    with BaseHistoryArchive(archive_directory) as archive:
        context['base_episodes']=build_base_records(base_frames,context['stocks'],context.get('benchmarks'),context['base_rs_history'],episode_sink=archive)
    context['base_history_archive']=archive_directory
    rows=[]; default_count=0
    for stock in context['stocks'].values():
        if not stock.get('default_screener_eligible',True):
            continue
        symbol=stock['symbol']; frame=cache.frame(root,symbol,session)
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
            for period in (20,50,200):
                row[f'ema{period}']=float(frame['Close'].ewm(span=period,adjust=False,min_periods=period).mean().iloc[-1]) if len(frame)>=period else None
            avg=frame['Volume'].iloc[-21:-1].mean() if len(frame)>=21 else None
            row['rvol']=float(last['Volume']/avg) if avg is not None and avg>0 else None
            row['changePct']=float((last['Close']/frame['Close'].iloc[-2]-1)*100) if len(frame)>=2 else None
            for field in ('sma20','sma50','sma200'):
                row[field]=metrics[field]
            for period in (5,21,63,126,252):
                metrics[f'return{period}']=float((last['Close']/frame['Close'].iloc[-1-period]-1)*100) if len(frame)>period else None
            metrics['gapPct']=float((last['Open']/frame['Close'].iloc[-2]-1)*100) if len(frame)>1 else None
            for period in (20,50,100):
                metrics[f'turnover{period}']=average_turnover_crore(frame,period)
            for period in (20,50,252):
                metrics[f'newHigh{period}']=bool(last['High'] >= frame['High'].tail(period).max()) if len(frame)>=period else None
                metrics[f'newLow{period}']=bool(last['Low'] <= frame['Low'].tail(period).min()) if len(frame)>=period else None
            for period in (14,20):
                if len(frame)>=period:
                    metrics[f'adr{period}']=float(((frame['High']-frame['Low'])/frame['Close']*100).tail(period).mean())
            if len(frame)>=14:
                atr=float(wilder_average(true_range(frame),14).iloc[-1])
                metrics['atrPct14']=atr/float(last['Close'])*100 if last['Close']>0 else None
                row['atr14']=atr
            else:
                metrics['atrPct14']=None
                row['atr14']=None
            row['adr20Pct']=metrics.get('adr20')
        row['metrics']=metrics
        row['bases']=compact_base_records(context['base_episodes'].get(symbol,[]),public=True)
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
            key=json.dumps(node,sort_keys=True)
            if key not in memo:
                memo[key]=bridge.evaluate(node,stock,frame,context,session,set(),delivery.get(symbol,[]))
            return memo[key]
        row['presetMatches']={key:evaluate(node) for key,node in presets.items()}
        default_count += evaluate(default) is True
        rows.append(row)
    cache.save_frames(root)
    code_files=[*sorted((root/'src/edl_pipeline/scanner').glob('*.py')),Path(__file__),
                Path(__file__).with_name('scanner_pack_publication.py'),Path(bridge.__file__)]
    digest=hashlib.sha256()
    digest.update(json.dumps(checked_identity(), sort_keys=True).encode())
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
            for name in ('symbols','offsets','dates','values','turnover'):
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
    payload={'schemaVersion':7,'revision':revision,'asOfDate':session,'totalStocks':len(rows),'stocks':rows,'referenceCounts':{'rvol15Sma50':default_count}}
    stock_bytes=write_json(generation/'stocks.json',payload)
    compressed=gzip.compress(stock_bytes,compresslevel=6,mtime=0)
    compressed_path=generation/'stocks.json.gz'
    temporary=compressed_path.with_name(compressed_path.name+'.tmp')
    temporary.write_bytes(compressed); temporary.replace(compressed_path)
    with gzip.open(root/'ipo_screener.json.gz','rt') as handle:
        ipos=json.load(handle)
    write_json(generation/'ipos.json',ipos.get('records',[]) if isinstance(ipos,dict) else ipos)
    all_fields=set().union(*(row.keys() for row in rows)) if rows else set()
    fundamental_fields=(all_fields-CORE_FIELDS-TECHNICAL_FIELDS)|{'symbol'}
    packs={
        'core':_write_pack(generation,'core',_pack_payload(revision,session,rows,CORE_FIELDS)),
        'technical':_write_pack(generation,'technical',_pack_payload(revision,session,rows,TECHNICAL_FIELDS)),
        'fundamentals':_write_pack(generation,'fundamentals',_pack_payload(revision,session,rows,fundamental_fields)),
    }
    if packs['core']['bytes'] > 1_250_000:
        raise RuntimeError('Schema-7 core pack exceeds the 1.25 MB compressed performance budget')
    if sum(pack['bytes'] for pack in packs.values()) > 4_000_000:
        raise RuntimeError('Schema-7 public packs exceed the 4 MB compressed performance budget')
    private_root, private_manifest = build_private_scanner_pack(
        root, root/'scanner_artifacts', revision, session, cache, context, delivery, rows)
    pointer_path = output / 'current.json'
    active_revision = json.loads(pointer_path.read_text()).get('revision') if pointer_path.exists() else None
    advanced_published = publish_private_pack(private_root, revision, active_revision=active_revision)
    manifest={'revision':revision,'sessionDate':session,'publishedAt':datetime.now(timezone.utc).isoformat(),
              'schemaVersion':7,**checked_identity(),'totalStocks':len(rows),
              'datasetUrl':f'/data/revisions/{revision}/stocks.json','iposUrl':f'/data/revisions/{revision}/ipos.json',
              'datasetGzipUrl':f'/data/revisions/{revision}/stocks.json.gz','packs':packs}
    if advanced_published:
        manifest['advanced']={'revision':revision,'session':session,'shards':private_manifest['shards'],
                              'maxSessions':private_manifest['maxSessions']}
    manifest = complete_release(chart_root, output, manifest)
    print(f'Published scanner revision {revision[:12]}: {len(rows)} stocks, {len(presets)} presets',flush=True)
    return manifest


if __name__=='__main__':
    publish(Path(os.environ.get('EDL_BASE_DIR',bridge.ROOT)))
