"""Archive exact daily scanner bytes; recover evening releases from Git history."""
import argparse
from datetime import date, datetime
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from zoneinfo import ZoneInfo

from chart_publication import R2Store, charts_enabled


def session_entry(data):
    session = data['asOfDate']
    date.fromisoformat(session)
    if (not re.fullmatch(r'[a-f0-9]{64}', data['revision'])
            or not isinstance(data['stocks'], list)
            or data['totalStocks'] != len(data['stocks'])):
        raise ValueError('Invalid daily scanner snapshot')
    return {'date': session, 'revision': data['revision'], 'label': session,
            'isHistorical': True}


def register_sessions(path, entries):
    payload = json.loads(path.read_text()) if path.exists() else {'version': 1, 'sessions': []}
    sessions = {entry['date']: entry for entry in payload['sessions']}
    sessions.update((entry['date'], entry) for entry in entries)
    payload['sessions'] = sorted(sessions.values(), key=lambda entry: entry['date'], reverse=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(payload, indent=2) + '\n')
    temporary.replace(path)


def archive_daily_snapshot(output, manifest):
    source = output / 'revisions' / manifest['revision'] / 'stocks.json.gz'
    compressed = source.read_bytes()
    entry = session_entry(json.loads(gzip.decompress(compressed)))
    if entry['date'] != manifest['sessionDate'] or entry['revision'] != manifest['revision']:
        raise ValueError('Daily scanner revision/session mismatch')
    key = f"snapshots/{entry['date']}.json.gz"
    if os.environ.get('EDL_CHART_STORAGE', 'local') == 'r2' and charts_enabled():
        store = R2Store()
        # Same-session corrections replace the dated object. Readers already
        # include the revision in their cache key; never register unverified bytes.
        store.run('copyto', str(source), store.remote(key), '--ignore-times',
                  '--metadata', '--metadata-set', 'content-type=application/gzip')
        if store.cache_command('cat', store.remote(key)) != compressed:
            raise RuntimeError(f'Daily snapshot read-back mismatch: {key}')
    else:
        target = output / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    return entry


def restore_evening_sessions(repo, start, end, output, sessions):
    """Select the last daily refresh per session, committed after 17:00 IST."""
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args])

    history = git('log', '--format=%H%x09%cI', '--grep=^Automated Daily Data Refresh$',
                  '--since=' + start, '--', 'frontend/public/data/current.json').decode()
    selected = {}
    for line in history.splitlines():
        commit, timestamp = line.split('\t')
        completed = datetime.fromisoformat(timestamp.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Kolkata'))
        if completed.hour < 17:
            continue
        manifest = json.loads(git('show', f'{commit}:frontend/public/data/current.json'))
        session = manifest['sessionDate']
        if (not start <= session <= end or session in selected
                or completed.date().isoformat() != session):
            continue
        path = f"frontend/public/data/revisions/{manifest['revision']}/stocks.json.gz"
        compressed = git('show', f'{commit}:{path}')
        entry = session_entry(json.loads(gzip.decompress(compressed)))
        if entry['date'] != session or entry['revision'] != manifest['revision']:
            raise ValueError(f'Daily scanner revision/session mismatch in {commit}')
        output.mkdir(parents=True, exist_ok=True)
        (output / f'{session}.json.gz').write_bytes(compressed)
        selected[session] = entry
        print(f"Restored {session}: {manifest['revision']} from {commit} ({completed.isoformat()})")
    if not selected:
        raise RuntimeError('No evening daily refresh snapshots found in the requested range')
    # The workflow commits this manifest only after R2 upload and verification.
    register_sessions(sessions, selected.values())
    return selected


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start-date', type=date.fromisoformat, required=True)
    parser.add_argument('--end-date', type=date.fromisoformat, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--update-sessions-manifest', type=Path, required=True)
    args = parser.parse_args()
    if args.start_date > args.end_date:
        parser.error('start-date must not exceed end-date')
    restore_evening_sessions(Path(__file__).resolve().parents[1], str(args.start_date),
                             str(args.end_date), args.output_dir, args.update_sessions_manifest)
