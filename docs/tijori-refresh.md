# Tijori refresh and isolated retries

## Incident: weekly run 40177339878

The 25 October 2026 weekly run completed its market-data publication, R2 state save, Dhan sync and
Earnings refresh. Tijori failed immediately at `tools/export_tijori_overviews.py`'s universe-loading step.
The active manifest's `datasetUrl` was an HTTPS URL because the plain snapshot had been offloaded to R2.
The exporter prepended `frontend/public` and attempted to open a local file named
`frontend/public/https:/nexus-scanner-data.aniketmahato26.workers.dev/releases/24a2de3c…/stocks.json`.
The resulting `FileNotFoundError` occurred before any Tijori network collection.

The optional step uses `continue-on-error: true`. GitHub therefore shows the overall job as successful;
the separate failure-recording step writes a warning and diagnostic metadata. The successful components
do not need repeating. The 403 messages earlier in this run's log came from offline failure-path tests,
not from the failed production collection attempt.

The loader now uses the matching checked-in plain/gzip snapshot, skips remote URLs as filesystem paths,
and validates the revision/session if present. If declared URLs are both remote, it can resolve the same
revision's local archive. It fails clearly if the artifact is absent; it never substitutes another revision.

## Retry only Tijori

GitHub reruns jobs, not individual steps. The weekly workflow's normal job contains every refresh phase,
so rerunning that job would repeat the successful work. Use its manual boolean input instead:

```sh
gh workflow run weekly_eod2_refresh.yml --ref main -f tijori_only=true
```

Until this fix is merged, dispatch its branch with `--ref codex/tijori-refresh-only`.
The normal weekly job is skipped when the input is true. The standalone job installs only the Tijori
dependencies, runs the exporter tests, refreshes cached company reports, and verifies that at least one
company was successfully checked during this attempt. It fails if all checks failed, rather than publishing
an apparently fresh timestamp for entirely stale cached reports. Per-company failures remain visible in
the summary and uploaded exceptions; partial success is not described as a complete export.

The job commits only the private Tijori gzip/summary, company-overview pointer and its exact immutable
overview artifact. It does not stage other company history directories or change market snapshots,
scanner pointers, Dhan membership, OHLCV, financials or Earnings data. It uses the existing refresh
concurrency group to avoid racing scheduled publication. Successful data publication goes to `main`;
the code fix stays on its PR branch until reviewed and merged.
