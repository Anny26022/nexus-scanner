"""Build and publish immutable private scanner history packs.

The public release pointer remains the authority.  A private revision is made
visible to the edge worker only after every shard has been uploaded and
verified; its manifest is copied last.  Shards use a compact binary layout so
the worker can release one batch before fetching the next.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"DO NOT DELETE EDL PIPELINE/src"))
from scanner_identity import checked_identity

import numpy as np


SCHEMA_VERSION = 7
SHARD_COUNT = 32
MAX_SESSIONS = 1500
MAX_AUXILIARY_BYTES = 12 * 1024 * 1024
MAGIC = b"NSPK0001"
R2_KEYS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")


class BaseHistoryArchive:
    """Stream complete episodes into stable shards, retaining one symbol at a time."""
    def __init__(self, root):
        self.root = Path(root)
        self.files = []
        self.streams = []
        self.counts = [0] * SHARD_COUNT

    def __enter__(self):
        self.root.mkdir(parents=True, exist_ok=True)
        for index in range(SHARD_COUNT):
            file = (self.root / f'{index:02d}.json.gz').open('wb')
            stream = gzip.GzipFile(filename='', mode='wb', fileobj=file, compresslevel=6, mtime=0)
            stream.write(b'{')
            self.files.append(file)
            self.streams.append(stream)
        return self

    def __call__(self, symbol, episodes):
        index = _shard(symbol)
        if self.counts[index]:
            self.streams[index].write(b',')
        self.streams[index].write(_json_bytes(symbol) + b':' + _json_bytes(episodes))
        self.counts[index] += 1

    def __exit__(self, exc_type, exc, traceback):
        for stream in self.streams:
            stream.write(b'}')
            stream.close()
        for file in self.files:
            file.close()


def _json_bytes(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _shard(symbol):
    return hashlib.sha256(symbol.encode()).digest()[0] % SHARD_COUNT


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def _pack_shard(entries):
    """Return gzip bytes containing header, int32 dates and float64 OHLCV."""
    symbols, dates, values, offset = [], [], [], 0
    for symbol, frame in sorted(entries):
        frame = frame.tail(MAX_SESSIONS)
        epoch_days = frame["Date"].to_numpy(dtype="datetime64[D]").astype("int32")
        matrix = frame[["Open", "High", "Low", "Close", "Volume"]].to_numpy(dtype="<f8")
        symbols.append({"symbol": symbol, "offset": offset, "count": len(frame)})
        dates.append(epoch_days.astype("<i4", copy=False))
        values.append(matrix)
        offset += len(frame)
    header = _json_bytes({"version": 1, "columns": ["open", "high", "low", "close", "volume"], "symbols": symbols})
    raw = bytearray(MAGIC)
    raw.extend(struct.pack("<I", len(header)))
    raw.extend(header)
    raw.extend(b"\0" * ((-len(raw)) % 8))
    if dates:
        raw.extend(np.concatenate(dates).tobytes())
        raw.extend(b"\0" * ((-len(raw)) % 8))
        raw.extend(np.concatenate(values).tobytes())
    return gzip.compress(bytes(raw), compresslevel=6, mtime=0)


def build_private_scanner_pack(root, output, revision, session, cache, context, delivery, rows=None):
    """Build 32 deterministic shards plus benchmark and dated auxiliary packs."""
    target = output / revision
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    grouped = [[] for _ in range(SHARD_COUNT)]
    symbols = []
    for symbol, stock in sorted(context["stocks"].items()):
        if not stock.get("default_screener_eligible", True):
            continue
        frame = cache.frame(root, symbol, session)
        if frame is None or frame.empty:
            continue
        frame = frame.loc[frame["Date"] <= np.datetime64(session)]
        if frame.empty or frame["Date"].iloc[-1].strftime("%Y-%m-%d") != session:
            continue
        grouped[_shard(symbol)].append((symbol, frame))
        symbols.append(symbol)

    objects = []
    for index, entries in enumerate(grouped):
        data = _pack_shard(entries)
        name = f"shards/{index:02d}.bin.gz"
        _write(target / name, data)
        objects.append({"key": name, "bytes": len(data), "sha256": _sha(data), "symbols": len(entries), "encoding": "gzip"})

    benchmarks = {}
    for name, frame in sorted((context.get("benchmarks") or {}).items()):
        if frame is None or frame.empty:
            continue
        date_key = "Date" if "Date" in frame else "date"
        close_key = "Close" if "Close" in frame else "close"
        clean = frame[[date_key, close_key]].dropna().tail(MAX_SESSIONS)
        benchmarks[name] = {
            "dates": clean[date_key].to_numpy(dtype="datetime64[D]").astype("int32").tolist(),
            "closes": clean[close_key].astype(float).tolist(),
        }
    benchmark_data = gzip.compress(_json_bytes(benchmarks), compresslevel=6, mtime=0)
    _write(target / "benchmarks.json.gz", benchmark_data)
    objects.append({"key": "benchmarks.json.gz", "bytes": len(benchmark_data), "sha256": _sha(benchmark_data), "encoding": "gzip"})

    # Dated auxiliary history is sharded with OHLCV.  Loading the complete
    # filings ledger at once would consume most of a 128 MB Worker isolate.
    financial_history = context.get("financial_history", {})
    def available_filings(symbol):
        provenance = {'symbol','isin','filing_caption','filing_descriptor','filing_source','filing_url','numeric_source'}
        return [{key:value for key,value in record.items() if key not in provenance}
                for record in financial_history.get(symbol, [])
                if str(record.get("filing_date") or record.get("filedAt") or "")[:10] <= session]
    from edl_pipeline.scanner.base_publication import compact_base_records, setup_candidate_records
    def selected_episodes(symbol):
        episodes = context.get("base_episodes", {}).get(symbol, [])
        selected_ids = {record['id'] for record in compact_base_records(episodes).values()}
        return [episode for episode in episodes if episode['id'] in selected_ids]

    native_rows = {row['symbol']: {**row, 'bases': {
        stage: {key: value for key, value in record.items() if key not in ('base', 'current', 'selection')}
        for stage, record in row.get('bases', {}).items()
    }} if isinstance(row.get('bases'), dict) else dict(row) for row in rows or []}

    for index, entries in enumerate(grouped):
        shard_symbols = {symbol for symbol, _frame in entries}
        # Delivery conditions read only dated percentages on retained candle
        # sessions. Quantity/provenance fields remain in the pipeline history;
        # repeating them in runtime packs greatly inflates JSON heap usage.
        delivery_rows = {}
        for symbol, frame in entries:
            dates = {str(day.date()) for day in frame['Date'].tail(MAX_SESSIONS)}
            values = [{'date':row['date'], 'delivery_percent':row.get('delivery_percent')}
                      for row in delivery.get(symbol, []) if row.get('date') in dates]
            if values:
                delivery_rows[symbol] = {
                    'dates': [int(np.datetime64(row['date'], 'D').astype('int64')) for row in values],
                    'percentages': [row['delivery_percent'] for row in values],
                }
        aux = {
            "stocks": {symbol: native_rows[symbol] for symbol in sorted(shard_symbols) if symbol in native_rows},
            "delivery": delivery_rows,
            "turnover": {symbol: {"dates": frame["Date"].tail(MAX_SESSIONS).to_numpy(dtype="datetime64[D]").astype("int32").tolist(),
                "values": [float(value) if np.isfinite(value) and value >= 0 else None for value in frame["Turnover"].tail(MAX_SESSIONS)]}
                for symbol, frame in entries if "Turnover" in frame},
            "earnings": {symbol: available_filings(symbol) for symbol in sorted(shard_symbols)
                         if available_filings(symbol)},
            "breadth": context.get("breadth", {}),
            "bases": {symbol: selected_episodes(symbol) for symbol in sorted(shard_symbols)},
            "setupCandidates": {symbol: setup_candidate_records(context.get("base_episodes",{}).get(symbol,[])) for symbol in sorted(shard_symbols)},
        }
        aux_raw = _json_bytes(aux)
        if len(aux_raw)>MAX_AUXILIARY_BYTES:raise ValueError(f"Auxiliary shard {index} exceeds the 12 MiB decoded budget; increase stable sharding before publication")
        aux_data = gzip.compress(aux_raw, compresslevel=6, mtime=0)
        name = f"auxiliary/{index:02d}.json.gz"
        _write(target / name, aux_data)
        objects.append({"key": name, "bytes": len(aux_data), "sha256": _sha(aux_data),
                        "symbols": len(shard_symbols), "decodedBytes":len(aux_raw), "encoding": "gzip"})

        if 'base_episodes' in context:
            # Historical archives are durable, but never decompressed by the
            # latest-session Worker. Runtime auxiliary packs carry selected IDs only.
            archive_root=context.get('base_history_archive')
            if archive_root is not None:
                archive_data=(Path(archive_root)/f'{index:02d}.json.gz').read_bytes()
            else:
                archive={symbol:context['base_episodes'].get(symbol,[]) for symbol in sorted(shard_symbols)}
                archive_data=gzip.compress(_json_bytes(archive),compresslevel=6,mtime=0)
            name=f'base-history/{index:02d}.json.gz'
            _write(target/name,archive_data)
            objects.append({'key':name,'bytes':len(archive_data),'sha256':_sha(archive_data),'encoding':'gzip'})

        if 'base_rs_history' in context:
            ledger={symbol:context['base_rs_history'].get(symbol,{}) for symbol in sorted(shard_symbols)}
            ledger_data=gzip.compress(_json_bytes(ledger),compresslevel=6,mtime=0)
            name=f'base-ranks/{index:02d}.json.gz'
            _write(target/name,ledger_data)
            objects.append({'key':name,'bytes':len(ledger_data),'sha256':_sha(ledger_data),'encoding':'gzip'})

    # Aligned native fields are loaded with their history shard. Preserve full
    # metadata for rows without history so metadata-only fallback still works.
    index_keys = ('symbol', 'name', 'close', 'indexMemberships', 'historyAligned', 'asOfDate')
    metadata_rows = [{key: row[key] for key in index_keys if key in row}
                     if row.get('historyAligned') is True and row['symbol'] in symbols
                     else row for row in rows or []]
    metadata_data = gzip.compress(_json_bytes({"stocks": metadata_rows}), compresslevel=6, mtime=0)
    _write(target / "metadata.json.gz", metadata_data)
    objects.append({"key": "metadata.json.gz", "bytes": len(metadata_data), "sha256": _sha(metadata_data), "encoding": "gzip"})

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        **checked_identity(),
        "revision": revision,
        "session": session,
        "symbols": len(symbols),
        "shards": SHARD_COUNT,
        "maxSessions": MAX_SESSIONS,
        "limits": {"maxLeaves": 32, "maxDepth": 8, "maxPageSize": 100, "maxRequestBytes": 100000},
        "objects": objects,
    }
    manifest_data = _json_bytes(manifest)
    _write(target / "manifest.json", manifest_data)
    return target, manifest


class PrivateR2Store:
    def __init__(self):
        missing = [key for key in R2_KEYS if not os.environ.get(key, "").strip()]
        if missing:
            raise RuntimeError("Private scanner R2 publication requires: " + ", ".join(missing))
        self.bucket = "nexus-screener-private-data"
        self.env = dict(
            os.environ,
            RCLONE_CONFIG_SCANNER_TYPE="s3",
            RCLONE_CONFIG_SCANNER_PROVIDER="Cloudflare",
            RCLONE_CONFIG_SCANNER_ACCESS_KEY_ID=os.environ["R2_ACCESS_KEY_ID"],
            RCLONE_CONFIG_SCANNER_SECRET_ACCESS_KEY=os.environ["R2_SECRET_ACCESS_KEY"],
            RCLONE_CONFIG_SCANNER_ENDPOINT=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            RCLONE_CONFIG_SCANNER_REGION="auto",
        )

    def remote(self, key):
        return f"scanner:{self.bucket}/{key}"

    def run(self, *args, capture=False):
        return subprocess.run(["rclone", *args, "--s3-no-check-bucket"], env=self.env, check=True,
                              capture_output=capture, text=capture)

    def publish(self, source, revision):
        prefix = f"scanner/v1/revisions/{revision}"
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder) / "objects"
            shutil.copytree(source, stage)
            manifest = stage / "manifest.json"
            manifest_data = manifest.read_bytes()
            manifest.unlink()
            try:
                self.run("copy", str(stage), self.remote(prefix), "--immutable", "--checksum", "--transfers", "8")
                self.run("check", str(stage), self.remote(prefix), "--one-way", "--download")
                local_manifest = Path(folder) / "manifest.json"
                local_manifest.write_bytes(manifest_data)
                # The manifest is the private pack's commit marker and is uploaded last.
                self.run("copyto", str(local_manifest), self.remote(prefix + "/manifest.json"), "--immutable", "--checksum")
            except Exception:
                marker = self.run("lsf", self.remote(prefix + "/manifest.json"), capture=True)
                if not marker.stdout.strip():
                    self.run("purge", self.remote(prefix))
                raise

    def retain_latest(self, keep=7, protected=()):
        listing = self.run("lsjson", self.remote("scanner/v1/revisions"), "--recursive", "--files-only", capture=True)
        # Prefixes have no reliable timestamp in object storage. Manifest
        # objects are commit markers, so their LastModified value orders only
        # complete revisions and excludes abandoned partial uploads.
        manifests = [item for item in json.loads(listing.stdout) if item.get("Path", "").endswith("/manifest.json")]
        manifests.sort(key=lambda item: item.get("ModTime", ""), reverse=True)
        revisions = [item["Path"].split("/", 1)[0] for item in manifests]
        retained = set(protected) & set(revisions)
        if len(retained) > keep:
            raise RuntimeError('Protected scanner revisions exceed the retention budget')
        for revision in revisions:
            if len(retained) >= keep:
                break
            retained.add(revision)
        for item in manifests:
            revision = item["Path"].split("/", 1)[0]
            if revision not in retained:
                self.run("purge", self.remote("scanner/v1/revisions/" + revision))


def publish_private_pack(source, revision, active_revision=None):
    mode = os.environ.get("EDL_SCANNER_STORAGE", "local")
    if mode not in {"local", "r2"}:
        raise RuntimeError('EDL_SCANNER_STORAGE must be "local" or "r2"')
    if mode == "r2":
        missing = [key for key in R2_KEYS if not os.environ.get(key, "").strip()]
        if missing:
            print("WARNING: private scanner R2 configuration missing (" + ", ".join(missing) +
                  "); publishing the public scanner snapshot without advanced history packs.", flush=True)
            return False
        store = PrivateR2Store()
        store.publish(source, revision)
        # Git pointer promotion follows chart publication and may still fail.
        # Never remove the pack currently referenced by that pointer.
        store.retain_latest(7, protected={revision, active_revision})
        return True
    return False
