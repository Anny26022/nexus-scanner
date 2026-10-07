# Lean announcement publication

Daily and weekly pipelines still classify the complete retained history with the
64-topic rulebook. Delivery separates that history from stock chart downloads.

| Data | Delivery |
| --- | --- |
| Candles, official corporate actions, earnings, volume events, market news | One compressed chart object per symbol |
| Taxonomy and classifier version | One shared object |
| Announcement screening | Seven-day cross-stock summary index |
| Initial stock filing view | Latest 90 days of summaries |
| Older stock filings | Year pages of at most 100 summaries |
| Full source metadata, classification and evidence | Separate detail pages, loaded on selection |
| Complete raw and classified archives | Compressed recovery objects, never loaded by the UI |

Every object lives at `objects/<sha256-of-gzip-bytes>.json.gz`. JSON and gzip are
deterministic, so identical content receives the same URL. Chart objects omit the
release date; the pinned release supplies it. A stock without price changes can
reuse its chart even when announcements change. Oldest-first history pages remain
stable when new filings append; the browser presents the newest page first.
Corrections, classification changes and late backfills may rebuild affected pages.

The small data index maps stock symbols to chart hashes and points to the shared
announcement catalog. The catalog maps symbols to recent summaries and year pages.
Schema-7 `current.json` exposes `dataIndexUrl` and `objectUrlTemplate`; open screens
continue using their scanner revision's `release.json`. Older chart releases remain
readable. Objects and full archives are ignored by Git.

The filing-cache publication timestamp bounds announcement windows, independently
of the EOD price session. This includes next-morning filings after the last close.
Naive source timestamps use Asia/Kolkata. The filter supports since last close
(15:30 IST on the reference session), 24 hours, and seven days; multiple topics
match with OR. Invalid/future timestamps are excluded from browser summaries but
remain in the complete archive. Filtering intersects the stock universe before
pagination, including the Python fallback. Counts describe mainboard filings in
the selected window. This is a published snapshot, not a live exchange feed.

The browser fetches summaries only when the filter or a stock's Filings panel opens.
Evidence loads on selection. Concurrent object requests share one promise; failed
requests can retry. Parsed object/release caches are bounded. Large recovery
archives do not enter the browser cache.

## Publication and recovery

With the existing R2 secrets/public URL configured, publication lists remote objects
once, skips existing same-size hashes, transfers only new files, and downloads new
files for verification. Hashes and references are validated locally first. Objects
are immutable and cacheable for a year. Release references are written after object
verification, then Git's current pointer advances. Missing configuration retains
the existing scanner-only fallback; configured storage failures stop publication.

The data index's `archives.raw` points to the complete retained provider history;
`archives.classified` points to the complete classified history. Both use the same
object URL template. For manual recovery, read a retained release's data index,
download these two objects and decompress them. Restore the raw JSON to
`DO NOT DELETE EDL PIPELINE/filing_history_data/filing_history.json`, and retain the
classified gzip as `DO NOT DELETE EDL PIPELINE/filing_history.json.gz`. Rerun normal
artifact generation to apply the current classifier. Automatic cache-miss recovery
is not implemented. The PDF text cache and provider page snapshots are not included
in these two backups; they can be refetched or rebuilt under existing enrichment
limits. Diagnostic builds may omit missing archive sources.

Keep `objects/` and `releases/` indefinitely. The existing 90-day `daily/` lifecycle
applies only to legacy chart copies. Never expire shared objects by upload age:
the current release may still reference an old unchanged file. No garbage collector
or database is introduced. Complete archive backups still add a large new object
when their content changes; transfer reuse primarily benefits chart files and
completed history pages. Incremental archive storage/classification is deferred.

Tests cover deterministic page reuse, time boundaries, deferred evidence loading,
filtering before pagination, cache isolation, archive restoration inputs,
incremental upload selection, and pointer preservation on failed publication.
Live R2 delivery requires configured credentials and is separate from these checks.
