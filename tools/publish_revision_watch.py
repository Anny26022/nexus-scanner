"""Publish a static copy of the live /data/current.json as the assets-only Worker in workers/revision-watch.

Requests to Workers static assets are not billed. Nexus Journal's embedded scanner checks this copy every minute and
reads the billed /data/current.json (a Worker request plus an R2 read) only when the revision changes, so a release
published at any time reaches open tabs within a minute without a billed request per check.

The copy is a change signal, not the source of truth: clients still read the manifest from the data origin and
re-read it at least every 30 minutes, so a missed or failed publish only delays new data. Run it after the release is
live (the build step publishes current.json to R2). Without CLOUDFLARE_API_TOKEN it warns and does nothing.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER_DIR = ROOT / 'workers' / 'revision-watch'
SOURCE_URL = 'https://nexus-scanner.aniketmahato26.workers.dev/data/current.json'
WATCH_URL = 'https://nexus-scanner-revision.aniketmahato26.workers.dev/current.json'
# Same major version as package.json's devDependency; pinned so a deploy never picks up a new release unannounced.
WRANGLER = 'wrangler@4.151.1'
REVISION = re.compile(r'[a-f0-9]{64}')
VERIFY_ATTEMPTS, VERIFY_DELAY = 12, 5


def read(url, attempts=3, delay=5, sleep=time.sleep):
    """The body at `url`, or None for a 404 (the copy before its first deploy)."""
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'nexus-scanner-revision-watch'})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            failure = error
        except (urllib.error.URLError, TimeoutError) as error:
            failure = error
        if attempt + 1 < attempts:
            sleep(delay)
    raise RuntimeError(f'{url}: {failure}')


def revision_of(body):
    """The manifest revision in `body`, or None when it is missing or not a manifest."""
    if body is None:
        return None
    try:
        value = json.loads(body)
    except ValueError:
        return None
    revision = value.get('revision') if isinstance(value, dict) else None
    return revision if isinstance(revision, str) and REVISION.fullmatch(revision) else None


def deploy(environ, worker_dir=WORKER_DIR):
    subprocess.run(['npx', '--yes', WRANGLER, 'deploy', '--config', str(worker_dir / 'wrangler.jsonc')],
                   check=True, env=environ)


def main(environ=os.environ, read=read, deploy=deploy, sleep=time.sleep, worker_dir=WORKER_DIR):
    if not environ.get('CLOUDFLARE_API_TOKEN'):
        print('::warning::CLOUDFLARE_API_TOKEN is not set, so the revision watch copy was not updated. '
              'Open scanner tabs still pick up the new release within 30 minutes.')
        return 0
    source = read(environ.get('REVISION_WATCH_SOURCE_URL', SOURCE_URL))
    revision = revision_of(source)
    if not revision:
        print('::error::The live current.json has no valid revision; the revision watch copy was not updated.')
        return 1
    watch_url = environ.get('REVISION_WATCH_URL', WATCH_URL)
    try:
        served = revision_of(read(watch_url, attempts=1))
    except RuntimeError:
        served = None
    if served == revision:
        print(f'The revision watch copy already serves {revision[:12]}.')
        return 0
    # The exact bytes the data origin serves, so the copy never disagrees with the manifest clients then read.
    (worker_dir / 'public' / 'current.json').write_bytes(source)
    try:
        deploy(dict(environ), worker_dir)
    except subprocess.CalledProcessError as error:
        print(f'::error::wrangler deploy of the revision watch copy failed (exit {error.returncode}).')
        return 1
    for attempt in range(VERIFY_ATTEMPTS):
        try:
            if revision_of(read(watch_url, attempts=1)) == revision:
                print(f'The revision watch copy now serves {revision[:12]}.')
                return 0
        except RuntimeError:
            pass
        if attempt + 1 < VERIFY_ATTEMPTS:
            sleep(VERIFY_DELAY)
    print(f'::error::The revision watch copy did not serve {revision[:12]} within a minute of the deploy.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
