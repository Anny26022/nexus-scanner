"""Publish the daily mutual fund snapshot to R2, apart from the stock release.

    python frontend/publish_mutual_funds.py

1. Fetch Dhan's fund screener and AMFI's NAV file (DO NOT DELETE EDL PIPELINE/fetch_mutual_funds.py).
2. Add the day's NAVs to the NAV history kept in private R2 state; new funds and gaps are filled from Dhan's NAV
   chart, so the first run backfills every fund to its launch (DO NOT DELETE EDL PIPELINE/mutual_fund_history.py).
3. From the history: trailing returns as of the latest NAV (Dhan's convention), CAGR, volatility, drawdowns,
   Sharpe, Sortino and rolling returns for every fund.
4. Upload `releases/mf/<revision>/` (funds.json.gz and nav/<ISIN>.json.gz per fund), check it, then replace the
   `mf/current.json` pointer, save the history, and remove older releases.

Served as /data/mf/current.json and /data/mf/revisions/<rev>/... (workers/screener-ai/siteData.ts). The live
snapshot stays when the new one is older, much smaller, or unchanged. Without R2 settings the files are written under
frontend/public/data/mf/ for local development.
"""
import gzip
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'DO NOT DELETE EDL PIPELINE'))
from fetch_mutual_funds import fetch_snapshot  # noqa: E402
from mutual_fund_history import fund_metrics, nav_series, update_history  # noqa: E402

from chart_publication import R2Store, missing_r2_settings  # noqa: E402
from mf_release import gzip_json, prune_releases, publish_release, read_pointer, read_state, write_release, write_state  # noqa: E402
from site_data import OUTPUT  # noqa: E402

POINTER = 'mf/current.json'
NAMESPACE = 'mf'
HISTORY = 'mf_nav_history.json.gz'
# A universe this much smaller than the live one is a partial answer, not funds closing.
MIN_SHARE_OF_LIVE = 0.9
# If this share of the funds needing a chart could not get one, Dhan's chart endpoint is failing, not one fund.
MAX_REFETCH_FAILURES = 0.05


def check_against_live(snapshot, live):
    if not live:
        return
    if snapshot['navDate'] < live.get('navDate', ''):
        raise ValueError(f"New NAV date {snapshot['navDate']} is older than the live {live['navDate']}")
    if snapshot['fundCount'] < MIN_SHARE_OF_LIVE * live.get('fundCount', 0):
        raise ValueError(f"Only {snapshot['fundCount']} funds against {live['fundCount']} live")


def with_history(snapshot, history, update=update_history):
    """Add the snapshot's NAVs to `history` and attach each fund's metrics and computed returns."""
    report = update(history, snapshot['funds'])
    # Request errors only: funds Dhan has no chart for yet (noChart) publish without metrics and are retried daily.
    attempted = report['refetched'] + report['refetchFailed']
    if attempted >= 20 and report['refetchFailed'] > MAX_REFETCH_FAILURES * attempted:
        raise ValueError(f"Dhan's NAV chart failed for {report['refetchFailed']} of {attempted} funds")
    with_metrics = 0
    for fund in snapshot['funds']:
        entry = history['funds'].get(fund['isin'])
        metrics = fund_metrics(entry) if entry else None
        if not metrics:
            continue
        returns = metrics.pop('returns')
        fund['returns'], fund['returnsAsOf'], fund['returnsSource'] = returns, metrics['historyEnd'], 'NAV history'
        fund['metrics'] = metrics
        with_metrics += 1
    snapshot['history'] = dict(report, withMetrics=with_metrics)
    print(f"NAV history: {report['appended']} appended, {report['refetched']} refetched from Dhan "
          f"({report['refetchFailed']} failed), {report['rejectedMoves']} rejected; metrics for {with_metrics} funds", flush=True)
    return snapshot


def history_changed(report):
    """Whether this run added or refilled any NAVs (the only ways update_history changes the history). Checked from
    its counts: gzipping the ~10 MB history twice to compare took ~7.5 s a run."""
    return bool(report['appended'] or report['refetched'])


def release_files(snapshot, history):
    # The fetch time and this run's history counts go in the pointer: the same data must give the same files.
    files = {'funds.json.gz': {key: value for key, value in snapshot.items() if key not in ('fetchedAt', 'history')}}
    for fund in snapshot['funds']:
        entry = history['funds'].get(fund['isin'])
        if entry:
            files[f"nav/{fund['isin']}.json.gz"] = nav_series(fund['isin'], entry)
    return files


def pointer_for(snapshot, revision):
    base = f'/data/mf/revisions/{revision}'
    return {'schemaVersion': snapshot['schemaVersion'], 'revision': revision, 'navDate': snapshot['navDate'],
            'fetchedAt': snapshot['fetchedAt'], 'fundCount': snapshot['fundCount'], 'navCheck': snapshot['navCheck'],
            'history': snapshot.get('history'), 'fundsUrl': f'{base}/funds.json.gz', 'navUrlTemplate': f'{base}/nav/{{isin}}.json.gz'}


def publish_mutual_funds(store, fetch=fetch_snapshot, update=update_history):
    live = read_pointer(store, POINTER)
    snapshot = fetch()
    check_against_live(snapshot, live)
    stored = read_state(store, HISTORY)
    history = stored or {'funds': {}}
    with_history(snapshot, history, update)
    with tempfile.TemporaryDirectory() as folder:
        revision = write_release(folder, release_files(snapshot, history))
        if live and live.get('revision') == revision:
            print(f'Mutual fund snapshot unchanged ({revision[:12]}); nothing published', flush=True)
            pointer = live
        else:
            pointer = pointer_for(snapshot, revision)
            publish_release(store, folder, NAMESPACE, revision, POINTER, pointer)
            print(f"Mutual funds live: {snapshot['fundCount']} funds, NAV date {snapshot['navDate']}, revision {revision[:12]}", flush=True)
    # After the pointer: a failed save only means tomorrow refills the same days from Dhan's chart.
    if stored is None or history_changed(snapshot['history']):
        write_state(store, HISTORY, history)
    prune_releases(store, NAMESPACE, keep={revision, (live or {}).get('revision')})
    return pointer


def replace_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)


def write_local(snapshot, output=OUTPUT, update=update_history):
    """Local development: the same checks and order as R2, into frontend/public/data/mf/ (gitignored)."""
    pointer_path = output / POINTER
    check_against_live(snapshot, json.loads(pointer_path.read_text()) if pointer_path.is_file() else None)
    state = output / 'mf' / 'state' / HISTORY
    history = json.loads(gzip.decompress(state.read_bytes())) if state.is_file() else {'funds': {}}
    with_history(snapshot, history, update)
    with tempfile.TemporaryDirectory() as folder:
        revision = write_release(folder, release_files(snapshot, history))
        for path in Path(folder).rglob('*.json.gz'):
            replace_file(output / 'mf' / 'revisions' / revision / path.relative_to(folder), path.read_bytes())
    replace_file(pointer_path, json.dumps(pointer_for(snapshot, revision), separators=(',', ':'), allow_nan=False).encode())
    replace_file(state, gzip_json(history))
    print(f'R2 settings missing; wrote {pointer_path} locally only', flush=True)


def main():
    missing = missing_r2_settings()
    if missing and os.environ.get('GITHUB_ACTIONS') == 'true':
        print('::error::R2 settings missing (' + ', '.join(missing) + '); the mutual fund snapshot was not published.', flush=True)
        return 1
    if missing:
        write_local(fetch_snapshot())
        return 0
    publish_mutual_funds(R2Store())
    return 0


if __name__ == '__main__':
    sys.exit(main())
