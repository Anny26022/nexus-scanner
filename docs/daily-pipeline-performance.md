# Daily pipeline performance changes

Audited run: [37816745334](https://github.com/Anny26022/nexus-scanner/actions/runs/37816745334/job/113447207170).
Executed revision: `9868bdeeb75a1e76dc9cf394d4e6133d20a7d179`.

The 33m44s job spent 7m42s fetching and 24m38s building/publishing. Major
serial costs were breadth (~406s), chart artifacts (~299s), EOD2 import
(~259s), filings fetch (~228s), and filing-history build/validation (~158s).
The remaining build time was not fully attributed; new elapsed-time logs
separate compression, validation, promotion, archive preparation and upload.

## Implemented

- Overlap filing-history and MBI breadth builds with stock enrichment. Both
  use completed fetch inputs and separate outputs; RS still waits for breadth,
  charts still wait for filing history, and required failures block publication.
- Evaluate breadth predicates in vectors, but replay increments in the same
  symbol/date/field order. Floating-point sums and contribution membership are
  not regrouped. Legacy breadth also avoids a duplicate CSV read and iterrows.
- Parse each EOD2 source segment once per security. Always recompute the
  overlay; skip destination writes only if the original CSV writer's exact
  bytes are already present. Changed local history and newer sessions retain
  their existing precedence rules.
- Stream classified filing-history validation and announcement generation
  one company at a time using Python's original JSON decoder. Generated files
  have unique, sorted companies and metadata before the records array.
- Reuse identical announcement gzip objects through a content/runtime-keyed,
  checksum-verified optional cache, retained in the existing filing cache.
  Cache failures fall back to original compression; obsolete acceleration
  entries are pruned without deleting published objects or historical data.
- Use at most two processes for independent chart objects, preserving ordered
  index assembly and the existing temporary-directory promotion boundary.
- Compress independent public files and the two retained archives concurrently
  with two threads. Serializers, compression levels, archive headers, quality
  checks and remote upload verification remain unchanged.

## Follow-up pass

- Final gzip filing validation now streams records too. It consumes the whole
  gzip stream, including its trailer, rather than materializing the document.
- Filing compression and retained archive preparation start after the filing
  producer and its raw validation succeed, overlapping stock enrichment.
  Archives read the immutable staged raw JSON directly, with the original
  deterministic gzip writer. They remain private until required builds succeed;
  publication verifies their hashes and reuses them without recompression.
- Announcement processing overlaps candle/chart workers. Worker capacity
  reserves a core for announcements, and explicit process spawning avoids
  forking the multithreaded parent on Linux. Both branches must succeed before
  the existing chart-directory swap.
- Breadth replay resolves audit membership once per target/session and avoids
  millions of per-field method calls. JSON output is encoded in record/entity
  units instead of millions of small writes. Original bytes and increment
  order remain unchanged.
- Announcement date parsing is reused within each company. Synthetic cold/warm
  comparisons against the first PR commit produced identical object bytes.
- Filing-history fingerprints hash the original canonical array bytes one row
  at a time, without a second company-wide clone/string. Existing cache keys
  remain valid; PDF selection, attempts, retries and classification are untouched.
- The frontend correction fixture now disables both gzip and packed-gzip URLs
  when serving its synthetic JSON snapshots, and explicitly checks fallback
  POSTs. This fixes the same failure already present on main run 37777306333;
  production client behavior is unchanged.
- Related review fixes bound queued chart work, render changed EOD2 CSVs only
  once, schedule required builds ahead of optional reference work, report both
  archive failures, and include the streaming/archive helpers in wheel builds.

## Targeted scanner follow-up

- Index earnings and shareholding observations once by symbol, then use the
  original selectors on each ordered bucket. Date bounds, ties, adjacent-quarter
  changes and precision are unchanged; one-shot iterables retain the old path.
- Bound chart date parsing to 16,384 cached normalized strings per process.
  The original coercion, truncation and `strptime` acceptance remain unchanged.
- Reuse moving averages, benchmark alignment and full-history extreme-reset
  replay during one immutable stock's preset evaluation. Cache scope ends after
  that stock, so corrected history and different benchmarks cannot reuse stale
  results. The original calculation bodies and persistence rules are retained.
- Observe announcement failures while chart chunks are queued/running (and
  between serial objects), cancelling the bounded pending window before more
  work is submitted. Replace prepared archive manifests atomically so a partial
  write cannot become a handoff manifest. Successful artifact bytes are unchanged.

No earlier scanner-history scheduling was added: it writes into the retained
history cache shared with the published checkout. Moving those writes before
existing failure gates would require rollback handling. Broader publication
concurrency and filing-storage changes remain deferred.

## Remaining CPU/I/O follow-up

- Derive delivery evaluation windows from the actual nested preset inputs,
  including legacy aliases and future lookbacks. Reuse official rows parsed
  while freezing the complete backend payloads, and construct EOD2 fallback
  dictionaries only for uncovered required dates. Frozen CSV bytes are reused;
  even fully covered files keep UTF-8 and CSV parser validation. Official
  duplicate precedence, null-value
  precedence and first-row CSV fallback remain unchanged. Invalid/uncertain
  lookbacks fall back to full loading; no retained history or 252-session quality
  check is shortened.
- Count integer breadth predicates in compact native arrays. Floating volumes
  still add one candle at a time in original order, and audited contributions
  retain their original membership/order. Repeated dates use explicit repeated
  addition; counters promote to Python integers before native overflow.
- Decorate only published breadth rows while replaying the full XP recurrence,
  previous ratios, rolling inputs and previous available index close. All formula
  bodies, thresholds, rounding and JSON field order remain unchanged.
- Use at most two spawned EOD2 preparation workers and four queued tasks. Workers
  only read/merge/render; the parent commits CSVs and reports errors/results in
  master order. Duplicate/aliased destinations and overlapping cache directories
  retain serial read-after-write behavior. Every overlay is still recomputed.

Compared with preceding PR head `49963db`, full frozen breadth generation took
67.8735s versus 108.9676s (**37.71% lower elapsed time**), covering 2,597 input
stocks, 2,308 eligible and 2,302 processed. All four artifact hashes and quality
records matched, including the same six missing local histories. This is the
incremental improvement from this round, not a comparison to the original job.
Reproduce with:

```sh
python tools/benchmark_refresh_runtime.py --only breadth --baseline 49963db1620efc734bc7f47e669e8c811599574b --limit 0 --data-root '/path/to/frozen/DO NOT DELETE EDL PIPELINE'
```

A generated EOD2 fixture with 200 securities, renamed segments and 3,000 sessions
per security took 6.8975s serial versus 3.4934s with two workers. All 400 generated
CSV files and the complete ordered report were identical. This is a synthetic
local preparation/import comparison, not a live EOD2 or whole-job forecast.
The fixture helper is `eod2_fixture` in `tests/test_remaining_performance.py`.

Full local delivery freeze/loading for a one-session evaluation view took
9.7165s versus 6.2901s. The original view held 3,379,325 rows; the bounded view
held 2,312. Filtering the full view produced exactly the bounded rows, and the
complete frozen history bytes retained SHA-256
`3e08403beb0d19e0cb967a22b4178c09c229b65513cd3f2915c68d29944cf283`.
UTF-8/CSV validation and compression settings were retained. This excludes
scanner calculations and is not a whole-publication measurement.

These local runs are not isolated-run medians; short verification tasks overlapped.
Do not add component savings to claim an observed whole-pipeline reduction.

## Evidence and limits

Python 3.12.14: 434 pipeline tests (one existing macOS skip), 51 frontend Python
tests and 68 JavaScript tests pass; the production frontend build also succeeds.
Coverage includes cache corruption, chunk boundaries, malformed/non-finite JSON,
gzip CRC/truncation/extra-member failures, EOD2 re-overlay, real process workers,
archive byte equivalence, prepared-archive corruption and dependency/failure
gates. GitHub Python CI runs on Linux/Python 3.10.

A frozen 100-symbol local breadth sample (87 eligible) took 9.305s before and
7.615s after: **18.16% lower elapsed time**. All four output-file SHA256 hashes
matched the audited baseline, with the generation timestamp held constant.
This is a stage/sample measurement, not a forecast of whole-job improvement.
Reproduce with Python 3.12 and the pipeline requirements installed:

```sh
python tools/benchmark_refresh_runtime.py --only breadth --limit 100 --data-root '/path/to/frozen/DO NOT DELETE EDL PIPELINE'
```

After the follow-up, a full local snapshot comparison covered 2,597 input
symbols (2,308 eligible, 2,302 processed). Before: 172.2688s; after: 108.1385s,
**37.23% lower elapsed time**. All four hashes matched, as did quality results,
including the same six missing histories. This verifies equivalence; it does
not certify that the local snapshot meets live publication coverage gates.
Use `--limit 0` for the full comparison. Measurements are local macOS/Python
3.12, not a forecast of Linux daily-job runtime.

Targeted follow-up measurements against the preceding PR revision, using frozen
local data on the same runtime:

- Full in-memory scanner-context construction for 2,605 stocks, 2,431 earnings
  observations and 52,801 shareholding observations: 10.1956s to 0.0807s, with
  identical serialized payload SHA256. Excludes ledger merging, gzip and disk.
- Candle loading and volume-event construction for 100 CSVs / 223,415 candles:
  three interleaved runs, median 1.0242s to 0.5140s, identical payload SHA256.
  This excludes announcements, compression and other chart-stage work.
- All 45 presets over 100 local histories: three interleaved runs, median
  3.3647s to 2.2194s (34.04% lower), identical result SHA256. Each history uses
  its own last session and delivery is omitted equally on both paths; this is
  a CPU component comparison, not a live-publication timing.

Regression tests also compare every publication file byte (including gzip,
packed data and manifest/revision) with calculation reuse enabled versus
disabled, and cover nested/error cache cleanup, input identity and NaN warmup.
Code changes still intentionally change the existing code-derived revision
fingerprint; equivalence does not mean retaining a previous code revision ID.

No new source-cache sharding format, provider-concurrency change, incremental
indicator state or stock-enrichment rewrite was introduced. Those broader
changes need separate evidence and migration design; the existing global PDF
candidate selection and ordered stock mutations are deliberately retained.

The existing offline benchmark can also compare classification/serialization;
those optimizations were already present in the branch's starting revision.

Provider transport, request concurrency, retry/backoff, freshness, PDF limits,
calculation thresholds, artifact schemas, archive retention, publication gates
and R2 verification were not relaxed. Source-only import skipping, lower gzip
levels, dropping retained archives and unbounded provider concurrency were
excluded because they can change behavior or output. No live fetch, pipeline
deployment or R2 publication was performed during verification; the next daily
run is needed to establish the overall improvement under actual runner load.

## Post-merge six-area follow-up

The merged PR #50 ran in [job 113600619251](https://github.com/Anny26022/nexus-scanner/actions/runs/37862291799/job/113600619251):
19m09s versus the original 33m44s, an observed 14m35s / 43.2% reduction.
Both jobs published scanner-only because R2 configuration was missing; this
comparison does not measure chart-object upload or remote verification.

This follow-up addresses the six remaining areas without relaxing safeguards:

1. Official gap recovery validates only dates that can affect evidenced gaps
   or the earliest valid candle. Histories with actionable gaps still receive
   full cleaning before repair, and provider sync validates every candle. Sync
   validates only new rows a second time, not already-clean existing/official
   rows. CSV reads remain bounded per security; no universe-sized row cache is
   retained. Transport, requests, retries, adjusted-price boundaries and final
   official precedence are unchanged.
2. Chart announcements and candle workers report separate elapsed times.
   Bounded caches reuse immutable filing timestamps and lowest-volume date
   ranks. The original bucket calculation, ties, retention and serializers stay
   intact. A slower single-pass chart rewrite was benchmarked and excluded.
3. Frontend stock rows use at most two spawned workers for large CLI builds,
   with four queued chunks of eight rows. Inputs/frames remain frozen; results
   return in original stock order. Parent packing, revision hashing, validation,
   upload and promotion remain ordered. Rule memo keys and turnover products
   are computed once, without changing any formula. Programmatic callers remain
   serial by default. Stage logs expose the remaining publication costs.
4. Breadth preparation uses spare cores only: one worker on a four-core runner,
   at most two on larger runners, and no pool for small universes. Only per-stock
   preparation runs in workers; all accumulation and floating-point additions
   retain original symbol/date order. Queues are bounded and closed on failures.
   Library callers remain serial by default. Index/equity timings are separate.
5. Published fields parse valid OHLCV numbers once and reuse bounded date
   parsing. Only consumed candle fields are materialized. Duplicate-date,
   listing-coverage, dividend, ATH and five-year-return rules are unchanged.
   Standardization and shared stock-file mutations remain ordered.
6. Filing output classifications are encoded one company at a time into a
   temporary spool, then assembled in the same sorted output order. This avoids
   retaining every company's expanded cache in memory. Global PDF selection,
   classification traversal, cache keys and exact finite JSON bytes are retained.
   The spool is closed on success/failure; it temporarily requires approximately
   one additional uncompressed filing artifact's worth of disk space.

Offline macOS / Python 3.12 comparisons against merged `40e0254`:

| Frozen workload | Baseline | Follow-up | Equivalence |
| --- | ---: | ---: | --- |
| Recovery cleaning, 200 stocks / 479,148 candles; excludes CSV reads | 0.588s | 0.034s | Same evidenced gaps |
| Published fields, same 200 histories | 1.437s | 1.186s | Same serialized stock fields |
| Full local breadth, 2,597 input / 2,308 eligible stocks, serial / one worker / two workers | 72.285s | 59.586s / 53.103s | All four artifacts byte-identical |
| Chart volume events, 300 local histories | 0.514s | 0.445s | Same records and ties |
| Filing stress fixture, 36,000 filings, warm | 1.869s | 1.609s | Same artifact SHA-256 |
| Filing stress fixture, isolated process peak RSS | 648.6 MiB | 452.9 MiB | Cold/warm cache and artifact bytes match |

Snapshot benchmarks freeze producer-code fingerprint inputs as well as data.
Real code edits still change the existing code-derived revision identity;
the revision algorithm and content remain unchanged. Cold snapshot comparisons
use separate cloned inputs, not a warm cache left by the baseline. The benchmark
uses local chart storage and validates chart objects as part of every snapshot
comparison. Earlier scanner-only frontend timing samples are intentionally not
reported here; rerun the corrected benchmark for chart-enabled throughput.
These component samples are not whole-job forecasts or isolated-run medians;
they must not be added to the previously observed 14m35s saving.

Reproduce with:

```sh
python tools/benchmark_pipeline_followup.py --data-root '/path/to/frozen/DO NOT DELETE EDL PIPELINE' --count 2600 --component breadth
```

Use `--component snapshot --count 400` for the complete frontend comparison.
For isolated filing memory measurements, run `--component filings --filing-count 1500 --filing-companies 24 --filing-implementation old_filings`
and then `new_filings` in separate processes. All writes are temporary and no
provider fetch or live R2 publication is performed.

Regression coverage includes spawned worker equivalence, ordering, bounded
queues/cancellation, missing/stale/invalid histories, malformed dates,
fractional/NaN volumes, atomic output failures and one-company classification
lifetime. Local verification: 444 pipeline tests (one existing macOS skip),
55 publication tests, 68 JavaScript tests, production frontend build and
wheel-only imports of the changed packaged modules.

## R2 publication follow-up

Run [38588069574](https://github.com/Anny26022/nexus-scanner/actions/runs/38588069574)
spent 624.08s in chart-object publication: 119.92s listing the object prefix,
278.65s uploading 3,613 new objects (9.2 MB), and 225.03s downloading those
objects for verification. These timings identify remote listing and per-object
operations as optimization candidates; they do not isolate their individual costs.

PR #78 addresses live-price churn in historical filing objects and repeated
EOD2 checkout updates. Manual backup policy and R2 transfer commands retain
their existing behavior. `--no-traverse` is deferred pending a comparison:
it replaces a destination listing with a lookup per selected object, so large
migrations may cost more. Retain full download verification in any benchmark.
The first filing publication creates replacement objects once; measure a later
comparable warm run to establish steady-state savings.

## R2 history audit and transport follow-up (October 16, 2026)

This audit compares the merged code and actual Actions logs rather than treating
all R2-labelled PRs as upload speed improvements. The PR is based directly on
`main` at `f9c78b29`; chart UI work and other open PRs are excluded from the implementation.

The first pass covered ten selected PRs; that was not an exhaustive inventory.
The expanded pass screened all **81 earlier PRs** available before #84, from #1
through #83 (there are no #15/#16 entries), including each PR's changed files and
commit list, 704 review records and 1,180 inline review comments. File/keyword
screening was followed by reading relevant findings, tracing their fix commits
and checking their presence in current main code. Review records/comments are
not counts of unique bugs or auto-fixes. Full main history was also checked so
reverted intermediate changes were not hidden by final net PR diffs.

| Earlier change | What it solved | Decision |
| --- | --- | --- |
| [#14](https://github.com/Anny26022/nexus-scanner/pull/14), [#31](https://github.com/Anny26022/nexus-scanner/pull/31) | Release binding, content-addressed reuse, separate announcements and legacy reads | Keep: these define current storage and compatibility contracts. |
| [#60](https://github.com/Anny26022/nexus-scanner/pull/60) | R2's intermittent 501 on the post-PUT HEAD | Keep `--s3-no-head` and full download verification. This was a correctness fix, not a listing optimization. |
| [#61](https://github.com/Anny26022/nexus-scanner/pull/61), [#62](https://github.com/Anny26022/nexus-scanner/pull/62) | Private-bucket browser delivery and faster company filing loads | Keep: browser delivery uses the Worker; Actions uploads use the S3 endpoint. These cannot remove uploader discovery latency. |
| [#68](https://github.com/Anny26022/nexus-scanner/pull/68) | 16 verification workers, phase timings, faster raw backup compression | Keep instrumentation/compression; increase only current object uploads/checks to 32. Old chart/archive paths retain their settings. |
| [#69](https://github.com/Anny26022/nexus-scanner/pull/69), [#74](https://github.com/Anny26022/nexus-scanner/pull/74) | Reusable historical candle chunks, weekday/weekly backup policy, bounded stalled commands | Keep. #69 initially landed on the performance branch; #74 explicitly ported it to main. The initial migration costs more than later warm runs. |
| [#78](https://github.com/Anny26022/nexus-scanner/pull/78) | Live `ltp` stopped changing historical filing hashes; updated EOD2 checkouts were saved | Keep. The first publication intentionally replaces historical objects once. Its final merged scope explicitly deferred traversal tuning. |
| `163cfb09` then `10cbb888` in #78 | Added `--no-traverse`, then reverted it before merge | The linked job never ran that traversal optimization. Reintroduce it with a cold/bulk guard, actual-rclone tests and reproducible request measurements. |

Additional earlier work identified by the expanded review:

| Earlier PRs | Relevant fixes or improvements | Current assessment |
| --- | --- | --- |
| [#3](https://github.com/Anny26022/nexus-scanner/pull/3), [#6](https://github.com/Anny26022/nexus-scanner/pull/6) | Validated staged publication/rollback; stopped committing oversized filing archives | Safety/history changes, not repeated R2 discovery fixes. |
| [#28](https://github.com/Anny26022/nexus-scanner/pull/28) | Review fix `82eddf9c` excluded PDF retry `attemptedAt` from old chart events | The helper `_filing_events` remains, but its only repository callers are tests. Today's producer uses `build_announcements`; this historical fix must not be credited as optimizing the current upload loop or every modern evidence object. Removing the helper would not speed the job. |
| [#40](https://github.com/Anny26022/nexus-scanner/pull/40), [#45](https://github.com/Anny26022/nexus-scanner/pull/45) | Bounded compression/serialization memory and logs; changed fetch/build scheduling | Upstream runtime and memory improvements, not R2 request optimizations. Their motivating runs did not establish a live R2 speedup. |
| [#41](https://github.com/Anny26022/nexus-scanner/pull/41), [#46](https://github.com/Anny26022/nexus-scanner/pull/46) | Optional classification-cache write failures warn; empty inputs preserve prior caches; normalized company checkpoints and transient-metadata exclusions | Still active. These reduce repeated classification, but do not eliminate object listing/copy/download requests. |
| [#47](https://github.com/Anny26022/nexus-scanner/pull/47), [#55](https://github.com/Anny26022/nexus-scanner/pull/55) | Guarded Actions-cache cleanup, per-delete failure handling, validated fetch/build cache phases | These manage GitHub Actions caches, not R2 bucket objects. Preserve recovery/concurrency guards. |
| [#44](https://github.com/Anny26022/nexus-scanner/pull/44), [#48](https://github.com/Anny26022/nexus-scanner/pull/48) | Removed deployment-suppressing commit markers; early quote rejection and nonblocking optional diagnostics | Prevent skipped deployment or wasted work on rejected inputs. They do not speed successful R2 publication. |
| [#50](https://github.com/Anny26022/nexus-scanner/pull/50) | Prepared archive hash checks; review fixes consumed both archive failures, wrote archive indexes atomically and canceled queued charts on announcement failure | Directly relevant earlier publication work omitted from the first pass. `de7d959d` and `49963db1` are on main; current code retains these checks and has regression coverage. |
| [#51](https://github.com/Anny26022/nexus-scanner/pull/51), [#52](https://github.com/Anny26022/nexus-scanner/pull/52) | Ordered row/chart work, better worker failures, reuse of finalized classified gzip; corrected benchmark scope/baselines | Retain. A prior benchmark accidentally exercised scanner-only output; its review correction matters when assessing historical performance claims. These do not change R2 transfer semantics. |
| [#54](https://github.com/Anny26022/nexus-scanner/pull/54) | Packaged filing/archive helpers and installed-resource checks | Required packaging/reliability work, not upload latency tuning. |

Two additional PRs have net changes in `chart_publication.py` but are still open:
[#20](https://github.com/Anny26022/nexus-scanner/pull/20) adds private scanner-pack
storage, and [#70](https://github.com/Anny26022/nexus-scanner/pull/70) adds financial
objects. Their implementation commits `c610b5b2` and `4bdabd83` are not ancestors
of main and cannot explain the linked job. Likewise, #69's original commits are
not on main; the reviewed implementation reached main through #74's `f047a1a3`.

The expanded review changes the coverage statement, not the transport patch.
It does not support deleting existing validation/cache/rollback code as a speed
fix. Targeted reruns passed the earlier review-feedback, filing-history,
chart/news publication, dual-archive-failure, cache-phase and cache-retention
regressions. No additional runtime code changes were made for this audit.

No obsolete R2 workaround was found that could simply be deleted to fix the
slow run. Legacy publication/archival paths remain supported. Removing them,
verification, immutable checks, retry bounds or retention would change behavior.

### Evidence from completed runs

Sizes below are decimal MB. The timings come from the job logs; manual and
scheduled runs have different backup policies and must not be compared as if
inputs were identical.

| Run | Mode | Existing objects | New objects / MB | Listing / copy / check (seconds) |
| --- | --- | ---: | ---: | ---: |
| [38588069574](https://github.com/Anny26022/nexus-scanner/actions/runs/38588069574) | Scheduled | 133,529 | 3,613 / 9.23 | 119.92 / 278.65 / 225.03 |
| [38607693219](https://github.com/Anny26022/nexus-scanner/actions/runs/38607693219) | Manual | 137,142 | 2,740 / 307.14 | 153.55 / 270.84 / 222.00 |
| [38700744424](https://github.com/Anny26022/nexus-scanner/actions/runs/38700744424) | Manual, first after #78 | 139,882 | 34,978 / 599.22 | 172.14 / 2,186.93 / 1,514.74 |
| [38757834555](https://github.com/Anny26022/nexus-scanner/actions/runs/38757834555/job/116500878138) | Scheduled | 174,860 | 8,984 / 37.94 | 232.27 / 769.00 / 594.69 |

The third run's large historical rebuild is consistent with #78's documented
migration; the logs do not identify the cause of every new hash. The last run
shows why byte-volume optimizations alone do not solve this: only 36.18 MiB was
new, but 8,984 individual files and repeated full-prefix discovery still cost
26m36s. `--files-from` filters names but does not itself stop remote traversal.

### Final implementation and verification

Current object publication uses 32 transfer/check workers. When
`new * 10 <= existing`, copy and check use `--no-traverse`; cold/bulk uploads
retain traversal. The selected mode/workers are logged. This is a workload guard,
not a claim that 10% is optimal for every R2 latency profile. Targeted discovery
trades LIST requests for more parallel HEAD requests. 64 workers were measured
locally but are not adopted without evidence about live throttling.

No formulas, generated bytes, compression settings, object keys, metadata,
retention, backup policies, initial size checks, retries, full download checks or
publication ordering change. No additional application dependency/cache is added.

The offline comparison is now reproducible with the production rclone version:

```sh
python tools/benchmark_r2_publication.py --rclone /path/to/rclone-1.60.1 --repeats 3
```

It runs real rclone against a loopback S3 fixture, comparing 500 selected 4-KiB
files with 10,000 existing files and an empty bucket at 16/32/64 workers. The
artificial default delays are 80ms per listing page and 30ms per object request;
`--list-delay` and `--object-delay` allow testing different latency assumptions.
The initial inventory listing is excluded. Every sample requires identical
remote bytes, unchanged unrelated objects, 500 PUTs and 500 verification GETs.
Targeted discovery must perform zero LISTs. These checks also run in Frontend CI
without artificial delay, alongside the real-rclone corruption/missing-object
regressions. No timing threshold is imposed on CI or presented as an R2 forecast.

Observed copy-plus-check medians from three repeats with those artificial delays:

| Discovery / workers | 10,000 existing | Empty bucket |
| --- | ---: | ---: |
| Traversal / original 16 | 4.504s | 2.485s |
| Targeted / 16 | 4.543s | 4.562s |
| Targeted / 32 | 2.383s | 2.308s |
| Targeted / 64 | 1.431s | 1.249s |
| Traversal / 32 | 3.521s | 1.447s |

The repeated baseline supersedes the earlier single-sample 6.049s figure.
Targeted lookup alone did not improve this sample; the concurrency increase and
cold/bulk fallback are important. Faster server-side LISTs or slower HEADs can
change the crossover, which is why the benchmark exposes both latency controls.

An end-to-end comparison against the original publisher at the job's commit
produced byte-identical source files, local releases, remote objects and remote
release references on a frozen chart fixture. No live R2 writes were performed.

The initial full inventory scan remains and already consumed 232s of its 300s
limit. Retained-object growth is a separate scaling constraint; this patch is
not a permanent solution to unlimited bucket growth. Changing inventory/storage
layout or trusting a cached inventory needs separate consistency and compatibility
work. Do not delete retained objects or skip verification to mask that constraint.
The next comparable deployed run must establish actual R2 savings before this
can be described as a production-proven final fix.

Local validation on the isolated main-based branch passed 508 pipeline tests
(one existing platform skip), 79 publication tests, five refresh workflow tests,
304 browser tests, the production build, the zero-delay S3 request/byte checks,
Python compilation and diff whitespace checks. The final transport test includes
same-size corruption, missing objects, immutable conflicts, idempotent retries
and preservation of unrelated files. Publication command failures preserve the
previous current pointer until a successful retry.
