"""Keep the pipeline's carried-over files in private R2 storage instead of committing them to Git.

Each refresh used to commit these 27 files (about 41 MiB compressed) so the next run could read them,
and Git keeps every version forever. Now a run pulls them from R2 before it starts and pushes the new
versions after a successful build. The commit no longer includes them, so they stop adding to history.

`pull` overwrites the checkout's copies with the R2 ones. A file R2 does not hold yet (the first run
after this change) keeps its last committed Git copy, which bootstraps R2 on the next push.
`push` first copies each current R2 object to `previous/`, so a bad run can be rolled back one step;
Git history used to be that rollback.

The prefix is not served: the public data Worker only exposes objects/, releases/, daily/, monthly/ and
snapshots/.
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / 'DO NOT DELETE EDL PIPELINE'
PREFIX = 'pipeline-state'
sys.path.insert(0, str(ROOT / 'frontend'))

# Read by the next run (ledgers, archives, inputs to the build and publish phases). Kept in step with the
# list commit-refresh-outputs used to stage; tests check that the action no longer commits any of them.
FILES = (
    'all_stocks_fundamental_analysis.json.gz', 'sector_analytics.json.gz', 'market_breadth.json.gz',
    'market_breadth_v2.json.gz', 'sector_breadth_v2.json.gz', 'market_breadth_contributions_v2.json.gz',
    'breadth_universe_snapshot.json.gz', 'all_indices_history_v2.json.gz', 'all_indices_list.json',
    'corporate_action_ledger.json.gz', 'nse_corporate_actions.json.gz', 'nse_corporate_action_adjustments.json.gz',
    'data_quality.json', 'pipeline_report.json', 'nse_universe_reconciliation.json', 'mainboard_universe_report.json',
    'sme_market_data.json.gz', 'nse_fno_ban.json.gz', 'earnings_calendar.json.gz', 'rs_rating_daily.json.gz',
    'ipo_screener.json.gz', 'ipo_provider_listed_archive.json.gz', 'ipo_provider_details_archive.json.gz',
    'scanx_ipo_listed_archive.json.gz', 'scanx_ipo_details_archive.json.gz', 'shareholding_history.json.gz',
    'quarterly_financial_history.json.gz', 'rotation_membership_ledger.json.gz',
)


def store_or_none():
    from chart_publication import R2Store, missing_r2_settings
    missing = missing_r2_settings()
    if missing:
        print('Pipeline state in R2 skipped; missing ' + ', '.join(missing), flush=True)
        return None
    return R2Store()


def stored_names(store):
    listing = store.cache_command('lsf', store.remote(PREFIX + '/'), '--files-only')
    return set(listing.decode().split())


def pull(store, directory=PIPELINE):
    present = stored_names(store)
    for name in FILES:
        if name in present:
            store.run('copyto', store.remote(f'{PREFIX}/{name}'), str(directory / name))
        else:
            print(f'{name}: not in R2 yet; using the committed copy', flush=True)


def push(store, directory=PIPELINE):
    present = stored_names(store)
    for name in FILES:
        local = directory / name
        if not local.exists():
            print(f'{name}: not produced by this run; R2 copy kept', flush=True)
            continue
        key = f'{PREFIX}/{name}'
        if name in present:
            store.run('copyto', store.remote(key), store.remote(f'{PREFIX}/previous/{name}'))
        store.run('copyto', str(local), store.remote(key))
        if store.cache_command('cat', store.remote(key)) != local.read_bytes():
            raise RuntimeError(f'Pipeline state read-back mismatch: {key}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('action', choices=('pull', 'push'))
    args = parser.parse_args(argv)
    store = store_or_none()
    if store is None:
        return 0
    (pull if args.action == 'pull' else push)(store)
    return 0


if __name__ == '__main__':
    sys.exit(main())
