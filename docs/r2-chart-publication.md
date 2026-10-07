# Chart publication to R2

The scanner and chart files share one release manifest: `frontend/public/data/current.json`.
It contains the scanner revision, session date, immutable scanner/IPO URLs, chart revision,
and data-index/object URL references (schema 7). Legacy releases retain a chart URL template. Per-scanner `release.json` files let open screens keep their revision.
New publications do not use a separate mutable R2 current pointer. The legacy
`manifests/current.json` object may still exist in R2; it is obsolete, is not
updated, and is not read by the application.

## Configuration

Production publication requires environment variable `EDL_CHART_STORAGE: r2`
(already set in both publication workflows: `daily_refresh.yml` and `weekly_eod2_refresh.yml`). Only `local` and `r2` are valid;
unknown values fail publication instead of selecting local storage.

GitHub Actions requires secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY`, plus repository variable `R2_PUBLIC_BASE_URL` (the HTTPS
public/custom-domain delivery URL for `nexus-screener-chart-data`). Configure
cross-origin GET access for the frontend origin. These credentials must have
read/write access because publication verifies uploads and archives prior releases.
Missing or partial configuration logs a warning and publishes fresh schema-4
scanner data without chart URLs, R2 requests, or frontend chart-cache copying.
With all four settings present, invalid settings or upload/verification/archive
failures stop publication before the Git commit and preserve the active release.
Local development uses ignored `/data/objects/` files; legacy releases use `/data/charts/<chart-revision>/`.
Chart bytes are `application/gzip`, without `Content-Encoding: gzip`; the browser
explicitly decompresses them. Cache immutable chart URLs, but bypass CDN/browser
caching for `/data/current.json`.

## Publication

The pipeline builds charts after canonical financial/filing ledgers and before
compression or intermediate cleanup. Staged chart files are preserved during
publication; the workflows upload these files without rebuilding them after news
inputs have been discarded. Scanner data is exported from the same pipeline run.
They verify chart count, symbol, content hashes, and announcement references before
uploading. Content-addressed objects are shared across releases. One R2 listing
identifies existing objects; only new objects transfer and receive download-based
verification. Existing immutable objects must have the expected byte size.
Charts, announcements and complete raw/classified backups stay outside Git;
Git retains small release references and scanner data. The shared current manifest
is written only after every object and release reference succeeds. Failed
publication preserves the active pointer. See
[lean announcement publication](lean-announcement-publication.md) for the layout.
R2 release `publishedAt` remains the deterministic session date at 00:00 UTC;
the announcement catalog separately records its filing-cache publication time.

## Current object retention

Schema-7 releases use `objects/<sha256>.json.gz` and
`releases/<scanner-revision>/`. Keep both prefixes indefinitely: several releases
can reference the same object. Do not apply the old daily lifecycle rule to them.
There is no automatic garbage collection in this implementation. Unchanged chart
and completed history pages are reused; newly changed pages and complete archive
backups still add storage. Measure real usage before introducing reachability-based
cleanup. Complete archives are for recovery and are never fetched by the UI.

## Legacy retention

- `daily/<session>/<chart-revision>/`: expire after **90 calendar days from upload**.
- `monthly/<YYYY-MM>/<chart-revision>/`: keep indefinitely.
- The first successful publication in a new month archives the previous month's
  latest successful trading session, including its chart index and release metadata.
  After archival succeeds, the previous Git `release.json` is updated to its
  monthly chart URL so historical chart requests reach the retained objects.
  Weekends/holidays require no calendar-day guess. If a month has no successful
  publication, there is no fabricated month-end release.
- Daily/weekly runs are serialized with the same workflow concurrency group.

The daily lifecycle rule has been applied to the dedicated bucket:

```sh
wrangler r2 bucket lifecycle add nexus-screener-chart-data daily-charts-90-days daily/ --expire-days 90 --force
```

This is 90 calendar days, not 90 trading sessions. Lifecycle deletion is asynchronous.
Historical daily chart links expire; month-end charts remain at their monthly URLs.
Legacy `revisions/` objects are outside the new expiration rule, including the initial
September 2026 upload. No existing objects were deleted when adding the rule.
If publication stops for over 90 days, daily objects can expire before rollover archival;
the rule does not protect the last current release through an indefinite outage.

For legacy full-copy releases, at 47 MB per full revision, the rolling daily storage is approximately 4.2 GB,
plus approximately 0.56 GB for each year of month-end releases (before corrections).

## Lowest-volume records

Charts store `volumeEvents.lowestEver` (LVE, all available candles) and
`volumeEvents.lowestQuarterly` (LVQ, latest 20 calendar quarters, including the
current partial quarter). Records contain date and volume. Ties select the
latest session; zero-volume candles count when present. These fields update
through the existing daily chart generation process.
