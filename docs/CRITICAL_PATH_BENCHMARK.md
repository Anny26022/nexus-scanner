# Daily refresh critical-path follow-up

Baseline: `8be8ce48` (main after PR #55). The motivating
[daily job](https://github.com/Anny26022/nexus-scanner/actions/runs/37935933405/job/113837874232)
took 990 seconds: fetching 374, build/publication 478, other workflow work 138.
That run lacked R2 configuration and used scanner-only publication. It is **not**
a measurement of chart uploads; configure R2 separately without changing fallback
or suppressing required chart construction.

## Changes and unchanged contracts

- Fetch workers yield capacity between scripts rather than entire lanes. At most
  three scripts run together; lane dependencies and the formerly disjoint bulk
  quote/news provider pools remain ordered. Provider limits, retries and freshness
  rules are unchanged.
- Normalize repeated field names and short filing text through bounded pure
  caches. Long filing text is not retained; classification inputs/rules remain intact.
- Build independent company announcement objects with two bounded process workers
  on builds with at least 256 symbols and two spare worker slots after reserving
  a core for the parent and up to two candle workers (at least five CPUs).
  Four-core runners retain the original in-process announcement path. Retain ordered parent assembly,
  exact JSON/gzip settings, object hashes and cache verification/pruning rules.
- Enrich published fields in bounded, ordered chunks using two workers on large
  builds. Existing formulas and history filtering are reused; only the parent writes.
- Validate the finalized filing gzip during chart construction. Reuse the exact
  check only after its full SHA-256 still matches at the final validation barrier.
  Changed/missing files are revalidated; failed checks still block publication.
- Do not send the redundant full stock universe to snapshot row workers. Their
  explicit stock inputs and all other evaluation context remain unchanged.

## Evidence and limits

Offline replay of the linked run's measured script and validation durations gives
fetch-lane makespan **319.354 -> 261.468 seconds**, a **57.886-second modeled**
reduction. This is not a live result: contention and network timing can change it.
Moving gzip validation targets part of the measured 22.37-second final validation;
it does not eliminate validation work.

One completed local sample, with byte equivalence asserted:

| Work | Baseline | Current |
| --- | ---: | ---: |
| Standardize 256 published canonical stocks | 0.358s | 0.041s |
| Filing identity/normalization, 2,000 input rows | 0.062s | 0.011s |
| Announcement objects, 64 companies, cold cache | 2.332s | 1.547s |
| Same announcement objects, warm cache | 1.073s | 0.704s |
| Published fields, 255 real CSV histories | 1.955s | 1.178s |

These are samples, not full-stage savings. Earlier local cold spawned runs took
96.207s and 34.258s versus serial 4.526s and 3.054s; startup variability must not
be hidden. PR CI also runs the synthetic byte/timing comparison on Ubuntu. A
comparable full daily run is required before claiming total production savings.
The table records the original two-announcement-worker experiment; the benchmark
now checks both one- and two-worker configurations. A review-follow-up sample
measured serial cold/warm 2.529s/1.094s, one worker 2.552s/1.232s, and two workers
1.467s/0.738s. Because one worker added overhead, the production budget does not
enable a one-worker announcement pool. These isolated timings do not establish
combined chart-stage performance on a four-core runner; its existing path stays intact.
Equivalence checks remain
active under Python `-O`. Scheduling replay rejects diagnostic/incomplete reports
with a clear message rather than assuming missing OHLCV script durations.

## Reproduce

Use the pipeline dependencies, with the baseline commit available locally:

```sh
python3 tools/benchmark_critical_path.py --baseline-ref 8be8ce48
python3 tools/benchmark_critical_path.py --baseline-ref 8be8ce48 \
  --data-root '/path/to/retained/pipeline' --run-report /path/to/pipeline_report.json
python3 tools/check_pipeline_wheel.py
```

The benchmark sends no provider requests, reads source histories without modifying
them, writes objects only in temporary directories, and compares catalog results,
all announcement gzip object bytes and enriched/normalized records. Focused tests
also cover bounded queues, worker/stream failures, missing/stale/duplicate history,
stock identity/order and invalidation of early validation results.
