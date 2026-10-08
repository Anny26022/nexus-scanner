# Refresh runtime audit and output-preserving optimizations

Audited [run 37731898276, job 113162691632](https://github.com/Anny26022/nexus-scanner/actions/runs/37731898276/job/113162691632),
at revision `c9abf8b6ba752a6de8c44f541d21cc834df5f64c` on 8 October 2026.
The investigation used job logs, step timestamps, the script report, generated
reference status records, and the exact source revision. Benchmarks below are
offline; no production refresh, deployment, API backfill, or data publication
was triggered to obtain them.

## Execution timeline

The successful job ran **05:20:45–06:16:06 UTC: 3,321 seconds (55m 21s)**.
Its recorded pipeline time was 3,066.224 seconds; that number is not the entire
Actions job, because it excludes frontend publication and workflow overhead.

| Work | Wall time / elapsed | Evidence and cause |
| --- | ---: | --- |
| Setup, restore, dependencies, tests, uploader install | ~46s | Caches restored successfully; not the main bottleneck |
| Fetch inputs | 15m 42s | A long ordered reference lane blocked completion |
| Foundation | ~35s | Universe/session/fundamental prerequisites; order is necessary |
| Filing fetch | 162.0s | Eight workers; incremental catch-up, not an all-history re-download |
| EOD2 import | 180.0s | 7,235,043 OHLCV and 3,137,387 delivery rows; full merge/CSV processing |
| Official daily overlay | 32.7s | Runs before provider repair; shared OHLCV writers must stay ordered |
| Provider OHLCV synchronization | 117.7s | 2,565 updated, 32 already current, no errors; API counts not reduced here |
| IPO provider + ScanX IPO fetch | 158.3s | Ordered reference-lane work; existing 0.28s/0.15s pacing retained |
| Official constituent refresh | 576.3s | 140 requested indices: 104 available, 31 read timeouts, 3 missing public downloads, 2 unresolved pages |
| Smaller enrichment fetches | 167.0s | Previously queued behind the slow constituent refresh |
| Build and frontend publication step | 38m 28s | CPU-heavy histories, classifications, JSON and compressed objects |
| Historical breadth | 73.1s | Full histories read again by a separate existing processor |
| MBI breadth | 573.2s + 2.1s validation | Re-evaluated every historical candle for overlapping universes and sectors |
| Filing builder | 756.5s + 48.9s validation | 4.2s load, 13.9s PDF work, 635.7s classification, 96.1s serialization |
| Chart/announcement object build | 306.4s | Retains complete history and immutable object generation |
| Final compression | 50.9s | Level-9 compression; large filing artifact dominates bytes |
| Screener context snapshot | 46.9s | Existing dated context retained |
| Final artifact validation | ~56.8s | Reopens and validates compressed outputs, including the large ledger |
| Frontend scanner publication | ~177s | Builds frozen histories and preset outcomes; not an R2 upload bottleneck in this run |
| Cache saves, commit/push, diagnostics, cleanup | Remaining short steps | None explain the principal delays |

Substage elapsed times overlap during fetch and must not be added to estimate
total wall time. All 48 recorded scripts succeeded; final validation reported
zero warnings.

## Exact bottlenecks

1. **Unnecessary reference barrier.** `refresh_official_index_constituents.py`
   invokes the standalone tool, which reads `INDEX_UNIVERSE_REFERENCE.md` and
   writes only `reference/index-constituent-mappings*`. No calculation or
   publication consumer reads those files. Despite this, it delayed both the
   smaller independent fetches and the entire build. All 31 recorded fetch
   failures were `The read operation timed out`. Requests were already bounded
   to four workers and 30-second socket timeouts; no duplicate resolved page
   URLs were found. There are no per-request timings to attribute every second
   to individual HTML versus CSV downloads.

2. **Cold filing classification.** The restored enrichment key was
   `scanner-enrichment-v1-Linux-37725607211-1-fetch`. That preceding run failed
   in fetch and skipped build, so it could not populate the classification cache
   introduced by commit `11d5f82d` that morning. The builder must classify on
   a cold/missing/rule-invalidated cache. Identical text within one cold pass
   also unnecessarily called the classifier repeatedly. A local profile of
   8,293 deduplicated filings counted 2,115,517 regex searches: repeated empty
   labels and standard clauses searched the same complete rule set again.

3. **Large temporary JSON allocations.** The filing output was
   1,972,177,664 raw bytes and 206,780,495 gzip bytes. `save_json` cloned the
   complete nested tree to sanitize numbers, constructed the complete Unicode
   string, then constructed the complete UTF-8 byte buffer. The log recorded
   **14,796.3 MiB (~14.4 GiB) peak RSS**. This risks memory pressure; the log
   does not establish whether swapping or an OOM actually occurred.

4. **Repeated breadth predicates.** Indicators were prepared once per stock,
   but `BreadthAccumulator.update` walked that frame again for all-active,
   named-universe and sector accumulators. Most stocks belong to more than one
   target. Repeating predicates, missing-value checks and tuple iteration was
   avoidable; the calculations and each target's accumulation order were not.

5. **Remaining full-history/validation costs.** Several independent processors
   still read the same CSV histories. Filing JSON is parsed for stage validation,
   charts, and final compressed validation. There is no local database query
   bottleneck in the inspected paths. Provider-side database behavior is not
   observable from this run. Artificial retry sleeps and IPO pacing exist, but
   deleting them would change reliability or provider traffic behavior.

## Implemented changes

- Keep four ordered fetch chains on **at most three workers**. Smaller fetches
  use the first free worker rather than waiting for the official reference.
- Run the standalone constituent refresh alongside build, then join it and
  record its existing optional success/failure before completion. It is not
  removed, downgraded further, cached instead of refreshed, or omitted from
  output. Older fetch checkpoints that already contain its result do not run it
  twice. The no-OHLCV diagnostic order remains unchanged.
- Evaluate breadth predicates once per candle, then replay the same ordered
  field increments into the relevant accumulators. Each floating-point volume
  addition remains in the original symbol/date order; no vectorized regrouping,
  truncated history, new rounding or shortened recursive warm-up is introduced.
- Reuse classification values for identical classification inputs within the
  same cold pass. Dates, source observations, revisions and filing identities
  remain separate; the existing key/version/rule checks remain enforced.
- Memoize only pure regex-match results for repeated text, preserving rule
  order. The cache is bounded to 2,048 entries; text over 4,096 characters is
  evaluated normally and never retained. All downstream status/evidence rules
  still execute as before, using a fresh mutable list of matches.
- Stream the final filing JSON one company record at a time into a temporary
  file. The same compact JSON encoder and non-finite-to-null sanitizer are used.
  Replace the previous artifact only after successful encoding and close.

No indicator, scanner, earnings, RS, corporate-action, delivery or financial
formula is changed. No source, endpoint, provider worker count, timeout, retry,
backoff, compression level, schema, retained date window or validation is removed.
All shared master-JSON and OHLCV mutation stages remain sequential.

The classification implementation file's fingerprint changes, so the first
refresh after upgrading can rebuild the classification cache once. Subsequent
warm-cache benefits already existed before these optimizations and are not
credited to this patch.

Replaying the audited script durations, including their validation times,
gives an old fetch-lane barrier of **901.732s**. The new IPO lane finishes at
158.415s, releasing a worker for the 167.022s independent chain; the OHLCV lane
then determines the barrier at **333.169s**. This is **568.563s (9m 29s) less
waiting**, before applying any calculation improvement. The 576.295s reference
refresh is hidden behind a build much longer than it. This is a critical-path
model, not a measured new Actions run: provider latency and resource contention
can change actual timing. Internal API worker counts and request counts are
unchanged, but independent request chains now overlap at different times.

## Measured verification

Initial paired local measurements (Python 3.9.6, identical frozen inputs):

| Compared work | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Complete breadth generation, 100 sampled stocks / 87 eligible | 19.2283s | 15.1476s | 21.22% faster |
| Cold classification, 38,161 deduplicated filings | 17.4659s | 15.3013s | 12.39% faster |
| Warm classification, same filings | 1.7760s | 1.7476s | 1.60%; too small to claim a material gain |
| Write 58,914,869-byte filing JSON | 1.5480s | 1.0633s | 31.31% faster |
| Separate-process writer peak RSS | 616.1 MiB | 414.5 MiB | 32.73% lower |

All four breadth artifacts were **byte-identical**, including the full enriched
records, sectors, universe snapshot and contribution lists. Both cold and warm
filing outputs had SHA-256
`5e3cea6b6e6c43f9effead7db431a5b22d8abd2d410acb3d0c8b63d880229f73`.
The serialization comparison had identical SHA-256
`a3299ea927691ff580c80782f59e4f87d86145ad3c0ec23a61f7e1fe014505cc`.

The larger full-local-snapshot check also completed successfully:

| Compared work | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Breadth, all 2,597 input stocks | 511.0329s | 450.4535s | 11.85% faster |
| Cold classification, 2,603 cached symbols / 998,111 deduplicated filings | 510.5086s | 484.2511s | 5.14% faster |
| Warm classification, same full filing snapshot | 41.8184s | 40.9937s | 1.97%; not a material speedup claim |
| Write 55,739,099-byte filing JSON | 1.3648s | 0.9319s | 31.72% faster |
| Separate-process writer peak RSS | 581.8 MiB | 395.5 MiB | 32.02% lower |

The full breadth fixture had 2,308 eligible and 2,302 processed stocks. Both
paths reported the same six missing local histories (`ACEVECTOR`, `GERMAN`,
`ORIENTCABL`, `RUNWALENTR`, `SHAHINVEST`, `SRIT`) and zero invalid histories.
These are pre-existing local-fixture gaps, not missing histories established
for the audited CI runner. All four complete output files had identical bytes:

| Artifact | SHA-256 (identical before/after) |
| --- | --- |
| Breadth | `afaf4abac3a7ccf832c1811d0bac163592c72e79ca65577fddd640130cf022f3` |
| Universe snapshot | `4aa3b506060cc2cb42a929ca7bb2f9a0f65e05bafca7e06f8e4d8b8a054cc921` |
| Sectors | `f85ca4d2ff08ca40854e8e195ae0e8f581f598b5b378792ed5322df438ba1a29` |
| Contributions | `a3d6f71eacb40d079023c8a2bca79d8ee30804e526e978333dac50103f219bce` |

Both full cold/warm filing comparisons returned SHA-256
`c2f132c63a619eb1085c0eae8249dc63a38fd08924aa1825ca523bdb19993d10`,
and the full-check serializer fixture returned identical byte hash
`c91d489ed80a58542dfc6c074dc8643b2efea1bb81b342073d86d076a663af89`.
The breadth and filing full checks ran alongside each other; these local
elapsed times are not isolated-run medians or GitHub-hosted timings. The larger
check is the conservative performance evidence; the sample's higher percentage
must not be extrapolated indiscriminately.

The benchmark uses existing local caches, not an exported copy of every API
response from the audited runner. Live fetching produces new timestamps and
may observe changed provider values; a whole-job live byte-for-byte comparison
cannot substitute for a frozen-input calculation comparison. Gzip headers in
existing non-deterministic pipeline compression also vary by run; the decoded
content and deterministic content-addressed compression are the comparison
contracts.

Reproduce without modifying production data:

```sh
python3 tools/benchmark_refresh_runtime.py --data-root '/absolute/path/to/local/pipeline/cache' --limit 100
# Larger equivalence check across the complete local snapshot:
python3 tools/benchmark_refresh_runtime.py --data-root '/absolute/path/to/local/pipeline/cache' --limit 0
cd 'DO NOT DELETE EDL PIPELINE'
PYTHONPATH='.:src:tests' python3 -m unittest discover -s tests
```

The baseline Git object must be present. The benchmark verifies unchanged
formula dependencies and refuses to report equivalence if those have changed.
Benchmark files and classification caches are disposable temporary files, not
the input histories.

Validation also covers disk-full/encode/replace failures (previous artifact
preserved, temporary file removed), Unicode/control characters, non-finite
numbers, tuples, empty records, repeated observations without identity merging,
cold/warm/invalidated/corrupt classification caches, long text bypass, cache
eviction, missing and zero volumes, exact thresholds, short/new listings,
unequal memberships, out-of-order date ranges, symbol-less contribution updates,
and float sums sensitive to regrouping. Runner tests check three-worker caps,
per-lane ordering, required failures, optional reference failures, completion
barriers, and old versus new split checkpoints. Pipeline and frontend suites
pass (376 pipeline tests, one existing skip; 46 publication tests).
The skip is the existing macOS `RLIMIT_AS` PDF-parser platform limitation;
Linux CI is the relevant environment for that test.

## Rollout and deliberately retained work

No new environment variables, services, dependencies or workflow settings are
required. Both daily and weekly refreshes use the same optimized runner.
Measure the next normal full run using its job timestamps and script report;
do not advertise the sum of script timings as wall-clock savings.
Applying the conservative local stage ratios to this run plus the fetch-barrier
model suggests roughly **44–46 minutes instead of 55m 21s** under comparable
cold-cache/provider conditions. This is an estimate, not a completed optimized
CI run or guaranteed SLA. Warm-cache behavior may improve further, but that
benefit is largely from the already-existing classification cache.

The audited run lacked all four R2 configuration settings and therefore
published a scanner-only release. Chart generation still ran; upload did not.
Skipping charts or inventing credentials is not an output-preserving runtime
fix, so this patch leaves that behavior intact. Correct R2 configuration is a
separate operational action.

Further work should be measured separately: version-safe EOD2 import reuse,
shared immutable history parsing, streaming validation with exactly equivalent
failure semantics, or parallel immutable object generation. Do not replace
these with stale data, fewer symbols, reduced archive retention, skipped
validation, higher provider concurrency, or arbitrary shorter timeouts.
