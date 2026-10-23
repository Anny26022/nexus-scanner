"""Keep the Git-served scanner release small: only the current and the previous revision stay.

Every publish used to add a full revision directory (about 50 MiB and 2,600 files) and nothing removed the
old ones, which pushes the static-asset deployment toward Cloudflare's per-deploy file limit and grows Git
history. Historical sessions do not need these directories: their stock lists come from R2
(`snapshots/<date>.json.gz`) and a missing release falls back to the current one, as it already does for
every session older than the retained revisions.

The previous revision stays so tabs opened before a publish keep working. It drops its uncompressed
`stocks.json`; such tabs read `stocks.json.gz` instead (see manifestSnapshotSource).
"""
import re
import shutil

REVISION = re.compile(r'[a-f0-9]{64}')


def retain_revisions(output, current, previous=None):
    """Removes every revision directory except `current` and `previous`; returns the removed revisions."""
    root = output / 'revisions'
    if not root.is_dir():
        return []
    keep = {current} | ({previous} if previous else set())
    removed = []
    for path in sorted(root.iterdir()):
        if path.is_dir() and REVISION.fullmatch(path.name) and path.name not in keep:
            shutil.rmtree(path)
            removed.append(path.name)
    if previous and previous != current:
        (root / previous / 'stocks.json').unlink(missing_ok=True)
    return removed
