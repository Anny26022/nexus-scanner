"""Keep one verified, immutable scanner archive per session date."""
import json
import os

from chart_publication import R2Store, charts_enabled


def archive_daily_snapshot(output, manifest):
    session, revision = manifest['sessionDate'], manifest['revision']
    history = output / 'sessions.json'
    if history.exists() and any(s['date'] == session for s in json.loads(history.read_text())['sessions']):
        return None  # Preserve the original archived revision, including backfilled dates.
    source = output / 'revisions' / revision / 'stocks.json.gz'
    compressed = source.read_bytes()
    key = f'snapshots/{session}.json.gz'
    if os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2' and charts_enabled():
        store = R2Store()
        store.run('copyto', str(source), store.remote(key), '--immutable', '--checksum',
                  '--metadata', '--metadata-set', 'content-type=application/gzip')
        if store.cache_command('cat', store.remote(key)) != compressed:
            raise RuntimeError(f'Daily snapshot read-back mismatch: {key}')
    else:
        target = output / key
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if target.read_bytes() != compressed:
                raise RuntimeError(f'Conflicting daily snapshot: {key}')
        else:
            with target.open('xb') as handle:
                handle.write(compressed)
    return {'date': session, 'revision': revision, 'label': session, 'isHistorical': True}


def register_session(path, entry):
    if entry is None:
        return
    payload = json.loads(path.read_text()) if path.exists() else {'version': 1, 'sessions': []}
    payload['sessions'].append(entry)
    payload['sessions'].sort(key=lambda s: s['date'], reverse=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(payload, indent=2) + '\n')
    temporary.replace(path)
