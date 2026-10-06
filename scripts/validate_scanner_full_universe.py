"""Offline, resumable full-universe pack validation; never promotes a release.

Usage: python3 scripts/validate_scanner_full_universe.py --source PATH --output PATH
Outputs per-symbol checkpoints and an immutable private pack, without copying
source history or generating the full replay archive a second time.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import resource
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'frontend'), str(ROOT/'scripts'), str(ROOT/'DO NOT DELETE EDL PIPELINE/src')]
import scanner_bridge as bridge
from scanner_cache import ScannerCache
from scanner_identity import checked_identity
from scanner_pack_publication import build_private_scanner_pack, _shard
from edl_pipeline.scanner.base_publication import (
    build_base_records, prepare_base_peer_context, compact_base_records, runtime_setup_candidate_records,
    runtime_setup_candidate_history_complete, load_history_audits,
)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data=json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    temporary=path.with_suffix('.tmp')
    temporary.write_bytes(gzip.compress(data,compresslevel=6,mtime=0))
    temporary.replace(path)


def load(path):
    return json.loads(gzip.decompress(path.read_bytes()))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--session',help='Explicit price session for performance-only validation')
    parser.add_argument('--minimum-stocks',type=int,default=2000)
    args=parser.parse_args()
    source=args.source.resolve(); output=args.output.resolve()
    if output==source or source in output.parents:
        raise ValueError('Validation output must be outside the source checkout')
    output.mkdir(parents=True,exist_ok=True)
    started=time.monotonic()
    context=bridge._load_context(source)
    session=args.session or context['financial_history_as_of']
    cache=ScannerCache(); cache.refresh(source)
    identity=checked_identity()
    fingerprint=hashlib.sha256(json.dumps({'sourceRevision':cache.revision,'session':session,**identity},sort_keys=True).encode()).hexdigest()
    checkpoint=output/'checkpoints'/fingerprint
    frames={}
    for symbol,stock in context['stocks'].items():
        if not stock.get('default_screener_eligible',True): continue
        frame=cache.frame(source,symbol,session)
        if frame is not None and not frame.empty and str(frame.Date.iloc[-1].date())==session:
            frames[symbol]=frame
    if len(frames)<args.minimum_stocks:
        raise ValueError(f'Only {len(frames)} aligned stocks for {session}; expected at least {args.minimum_stocks}. Validate source session coverage before benchmarking.')
    print(json.dumps({'event':'loaded','session':session,'metadataSession':context['financial_history_as_of'],'stocks':len(frames),'candles':sum(len(frame) for frame in frames.values()),'fingerprint':fingerprint}),flush=True)
    completed={path.stem.split('.')[0] for path in checkpoint.glob('*.json.gz')} if checkpoint.exists() else set()
    rank_history={}
    episode_count=0
    def sink(symbol,episodes):
        nonlocal episode_count
        selected=compact_base_records(episodes)
        ids={record['id'] for record in selected.values()}
        runtime=runtime_setup_candidate_records(episodes)
        # Pack construction expects the structural eligibility config. Preserve
        # that small input rather than changing the publisher for a benchmark.
        for record in runtime: record['config']={'min_sessions':0}
        save(checkpoint/f'{symbol}.json.gz',{
            'episodes':[episode for episode in episodes if episode['id'] in ids]+runtime,
            'publicBases':compact_base_records(episodes,public=True),
            'candidateHistoryComplete':runtime_setup_candidate_history_complete(episodes),
            'ranks':rank_history.get(symbol,{}),'episodeCount':len(episodes),
        })
        episode_count+=len(episodes); completed.add(symbol)
        print(json.dumps({'event':'checkpoint','symbol':symbol,'completed':len(completed),'total':len(frames),'elapsedSeconds':round(time.monotonic()-started,2)}),flush=True)
    # Every batch still uses the entire peer universe for strength and industry
    # context. Partition only requested symbols, never the ranking population.
    peer_context=prepare_base_peer_context(frames,context['stocks'],context.get('benchmarks'))
    for shard in range(32):
        requested={symbol for symbol in frames if _shard(symbol)==shard and symbol not in completed}
        if not requested: continue
        build_base_records(frames,context['stocks'],context.get('benchmarks'),rank_history,
                           symbols=requested,episode_sink=sink,setup_candidates=True,
                           history_audits=load_history_audits(source),peer_context=peer_context)
        rank_history.clear()
    del peer_context
    context['base_episodes']={}; context['base_rs_history']={}
    completeness={}; rows=[]; episode_count=0
    native_rows={}; native_session=None
    public=source.parent/'frontend/public/data'
    if (public/'current.json').exists():
        pointer=json.loads((public/'current.json').read_text())
        native_session=pointer.get('sessionDate')
        generation=public/'revisions'/pointer['revision']
        if (generation/'stocks.json.gz').exists():native=load(generation/'stocks.json.gz')
        elif (generation/'stocks.json').exists():native=json.loads((generation/'stocks.json').read_text())
        else:native={}
        native_rows={row['symbol']:row for row in native.get('stocks',[])}
    for symbol in sorted(frames):
        saved=load(checkpoint/f'{symbol}.json.gz')
        context['base_episodes'][symbol]=saved['episodes']
        context['base_rs_history'][symbol]=saved['ranks']
        completeness[symbol]=saved['candidateHistoryComplete']
        episode_count+=saved['episodeCount']
        # Existing published rows preserve the full native payload shape. This
        # is a performance fixture, not a recomputation of stale fundamentals.
        row={**native_rows.get(symbol,{}),**bridge.stock_row(context['stocks'][symbol],context.get('rs_ratings',{}))}
        row.update(historyAligned=True,asOfDate=session,bases=saved['publicBases'])
        last=frames[symbol].iloc[-1]
        for name in ('open','high','low','close','volume'):row[name]=float(last[name.title()])
        row['indexMemberships']=context['stocks'][symbol].get('index_memberships') or []
        rows.append(row)
    delivery=bridge._load_delivery_history(source/'delivery_history_data',None,source/'eod2_delivery_history_data')
    target,manifest=build_private_scanner_pack(source,output/'packs',fingerprint,session,cache,context,delivery,rows)
    # Checkpoints contain bounded witnesses, so propagate the original complete
    # history flag rather than deriving it again from the projected record set.
    for descriptor in manifest['objects']:
        if not descriptor['key'].startswith('auxiliary/'): continue
        path=target/descriptor['key']; auxiliary=load(path)
        auxiliary['setupCandidateHistoryComplete']={symbol:completeness[symbol] for symbol in auxiliary['setupCandidates']}
        save(path,auxiliary)
        data=path.read_bytes(); raw=gzip.decompress(data)
        descriptor.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),decodedBytes=len(raw))
        if len(raw)>12*1024*1024:raise ValueError(f'{path.name}: decoded budget exceeded')
    manifest['validationOnly']=True
    (target/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,separators=(',',':')))
    report={'source':str(source),'session':session,'metadataSession':context['financial_history_as_of'],
            'revision':fingerprint,'engine':identity,'nativeRowFixtureSession':native_session,'stocks':len(frames),'candles':sum(len(frame) for frame in frames.values()),
            'episodes':episode_count,'shards':manifest['shards'],
            'privateCompressedBytes':sum(item['bytes'] for item in manifest['objects']),
            'maximumAuxiliaryDecodedBytes':max(item.get('decodedBytes',0) for item in manifest['objects']),
            'packRoot':str(target),'buildWallSeconds':time.monotonic()-started,
            'processPeakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform=='darwin' else 1024),
            'scope':'private pack generation; Cloudflare runtime measurements are separate'}
    (output/'build-report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'event':'complete',**report}),flush=True)


if __name__=='__main__': main()
