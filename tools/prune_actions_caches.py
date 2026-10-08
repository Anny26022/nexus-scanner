"""Bound refresh snapshots without changing immutable cache keys. Dry-run by default."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import re
import subprocess

REFRESH_WORKFLOWS = {"Daily Data Refresh", "Weekly Adjusted OHLCV Refresh"}
SNAPSHOT = re.compile(r"^scanner-(prices|enrichment)-v1-(.+)-(\d+)-(\d+)-(fetch|build)$")
EOD2 = re.compile(r"^eod2-data-v1-(.+)-(\d{4}-\d{2})$")
LEGACY = re.compile(r"^scanner-history-v1-(.+)-(\d+)$")
PR_REF = re.compile(r"^refs/pull/(\d+)/merge$")


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def deletion_candidates(caches, default_ref, closed_prs, now):
    """Keep two snapshots per compatible format and any newer fetch checkpoint."""
    groups, legacy, candidates = {}, [], []
    cutoff = now - timedelta(days=1)
    for cache in caches:
        if timestamp(cache["created_at"]) >= cutoff:
            continue  # A grace period also protects newly created PR caches.
        match = PR_REF.fullmatch(cache["ref"])
        if match and int(match[1]) in closed_prs:
            candidates.append(cache)
    # Include young snapshots in retention decisions, even though they cannot be deleted.
    for cache in caches:
        if cache["ref"] != default_ref:
            continue
        key = cache["key"]
        match = SNAPSHOT.fullmatch(key)
        if match:
            family, os_name, _, _, phase = match.groups()
            if family == "prices" and phase != "fetch":
                continue
            group = (family, os_name, cache["version"])
            groups.setdefault(group, []).append(cache)
        elif (match := EOD2.fullmatch(key)):
            groups.setdefault(("eod2", match[1], cache["version"]), []).append(cache)
        elif (match := LEGACY.fullmatch(key)):
            legacy.append((match[1], cache))

    restored = {"prices": set(), "enrichment": set()}
    for (family, os_name, _), snapshots in groups.items():
        snapshots.sort(key=lambda c: (timestamp(c["created_at"]), c["id"]), reverse=True)
        if family == "enrichment":
            builds = [c for c in snapshots if c["key"].endswith("-build")]
            keep = builds[:2]
            fetches = [c for c in snapshots if c["key"].endswith("-fetch")]
            if builds:
                # Retain the latest unfinished fetch, if it is newer than the build.
                keep += [c for c in fetches[:1] if timestamp(c["created_at"]) > timestamp(builds[0]["created_at"])]
            else:
                keep = fetches[:2]
            recovery = builds[:2]
        else:
            keep = snapshots[:2]
            recovery = keep
        kept_ids = {c["id"] for c in keep}
        candidates.extend(c for c in snapshots if c["id"] not in kept_ids and timestamp(c["created_at"]) < cutoff)
        # Retire migration fallback only after split snapshots have actually been reused.
        if family in restored and any(
            timestamp(c["last_accessed_at"]) > timestamp(c["created_at"]) + timedelta(minutes=1)
            and timestamp(c["last_accessed_at"]) > now - timedelta(days=7)
            for c in recovery
        ):
            restored[family].add(os_name)
    candidates.extend(c for os_name, c in legacy
                      if os_name in restored["prices"] & restored["enrichment"]
                      and timestamp(c["created_at"]) < cutoff)
    return sorted(candidates, key=lambda c: c["id"])


def api(repository, suffix):
    # Slurping pagination avoids silently ignoring older caches or running jobs.
    output = subprocess.check_output(
        ["gh", "api", "--paginate", "--slurp", f"repos/{repository}/{suffix}".rstrip("/")], text=True)
    return json.loads(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--delete", action="store_true", help="Apply retention; otherwise only print candidates")
    args = parser.parse_args()
    repository = api(args.repo, "")[0]
    caches = [c for page in api(args.repo, "actions/caches?per_page=100") for c in page["actions_caches"]]
    pr_numbers = {int(match[1]) for c in caches if (match := PR_REF.fullmatch(c["ref"]))}
    closed_prs = {number for number in pr_numbers if api(args.repo, f"pulls/{number}")[0]["state"] == "closed"}
    candidates = deletion_candidates(caches, f"refs/heads/{repository['default_branch']}", closed_prs, datetime.now(timezone.utc))
    print(f"Retention candidates: {len(candidates)}/{len(caches)} caches, {sum(c['size_in_bytes'] for c in candidates) / 1_000_000:.1f} MB")
    for cache in candidates:
        print(f"{cache['id']}: {cache['key']} ({cache['ref']})")
    if not args.delete or not candidates:
        return
    for status in ("in_progress", "queued", "waiting", "pending", "requested"):
        runs = api(args.repo, f"actions/runs?status={status}&per_page=100")
        if any(run["name"] in REFRESH_WORKFLOWS for page in runs for run in page["workflow_runs"]):
            print("Refresh is active; skipping all cache deletion.")
            return
    for cache in candidates:
        subprocess.run(["gh", "api", "--method", "DELETE", f"repos/{args.repo}/actions/caches/{cache['id']}"], check=True)


if __name__ == "__main__":
    main()
