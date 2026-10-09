# Remaining daily pipeline hot paths

Baseline: merged PR #51 (`fa997041`). Measurements below are offline on the
same local Python 3.12.14 environment, not a GitHub-hosted daily run. Inputs are
read-only; benchmark outputs are temporary. No provider calls, live refresh,
deployment, or R2 publication were triggered.

## Included changes

- Native breadth predicates for prepared numeric/bool histories; retain the
  existing pandas path for nullable/object inputs.
- Native volume cells receive exactly the same additions in symbol/date order.
  Repeated dates use ordered `add.at`, not a reduction. Preserve untouched
  integer zeros, count overflow promotion, JSON key order, zero-volume audit
  membership, and contribution retention.
- Skip unused pre-output MBI decoration, but retain the previous boundary row's
  ratios, rolling/index state, and every step of the unchanged XP recurrence.
- Reuse only this run's freshly completed classified gzip payload for its
  deterministic archive. Both archives, charts, promotion, compression levels,
  main gzip headers, archive hashes, and validation remain intact. Unsupported
  producer headers use the original archive writer.
- Release the raw filing cache's list aliases after creating shallow company
  records, allowing spooling to release each company's raw filings/PDF pages.
- Correct the skipped-gap diagnostic for mixed adjusted/safe boundaries.
- Handle breadth pool construction, initial/refill submission, and result
  failures with ordered serial fallback after pool shutdown. Consumer failures
  propagate without replaying already-admitted histories.
- Log process CPU and wall time for OHLCV ledger/recovery/synchronization and
  the complete filing fetch, including cache load/save. Provider limits,
  retries, pacing, request logic, and scheduling are unchanged.

## Measured results

| Frozen work | PR #51 | This change | Evidence |
| --- | ---: | ---: | --- |
| Full local breadth, 2,597 input stocks, two preparation workers | 46.463s | 30.833s | 33.6% faster; all four artifacts byte-identical |
| Same breadth with serial preparation | — | 47.518s | Same four artifact bytes as both parallel paths |
| Both retained archives, synthetic 40,000-filings fixture | 1.305s | 0.511s | 60.8% faster; both gzip streams, index, and hashes identical |
| Filing build, same fixture, cold | 10.349s | 10.480s | No claimed speed improvement; output/cache bytes identical |
| Filing build, same fixture, warm | 1.598s | 1.628s | No claimed speed improvement; raw-list lifetime covered by regression |

The filing artifact SHA-256 in both implementations, cold and warm, was
`f41a167ebccc6c086155b7e819f2f2991f5abd7e07c32ca8afe4ca33a7cea87f`.
An earlier breadth pair measured 48.422s versus 33.940s before the final
contribution-window cleanup; it also passed the four-artifact comparison.

These component timings must not be added to predict whole-job savings.
Compression/archives already overlap other required work. The next daily run
is needed to measure the actual critical-path reduction on the hosted runner.

## Proposals not included

- An OHLCV worker slot is not a reserved CPU, and the lane already has its own
  ordered scheduling slot. The audited run finished OHLCV only 8.8s after another
  required lane, so a claimed 70–90s whole-job scheduling win is not established.
  The added CPU timings provide evidence for a later scheduling decision.
- Duplicate OHLCV validation was already removed by PR #51; do not credit it
  again here.
- Skipping archives, charts, or their promotion would change retained/local
  outputs. They are not skipped, even with missing R2 configuration.
- A validated partial NPZ reuse prototype on 2,606 histories saved only 0.524s
  with 85% of sources changed (7.942s to 7.418s), before any Actions cache restore,
  upload, or retention overhead. It was removed, together with its proposed
  workflow/cache-policy changes. Unchanged-source NPZ loading already works
  without `scanner_revision.json` (1.795s versus 7.781s cold CSV preparation).
- No grouped volume sums, history truncation, XP approximation, compressor
  changes, extra workers, or provider concurrency increases.

## Reproduce

Verification: 452 pipeline tests (one existing skip), 56 publication tests,
13 cache-retention tests, 68 frontend tests, frontend build, Python compilation,
and wheel-only pipeline/breadth/filing imports. Added regressions cover nullable
predicate boundaries, ordered volume replay, archive byte identity/fallback,
raw filing-list release, mixed adjustment counts, all pool failure points,
and isolation of selected benchmark revisions and their relative imports.

```sh
python3 tools/benchmark_pipeline_followup.py --baseline-ref fa997041 \
  --component breadth --data-root '/path/to/read-only/EDL data' --count 100000
python3 tools/benchmark_pipeline_followup.py --baseline-ref fa997041 \
  --component filings --filing-count 1000 --filing-companies 40
python3 tools/benchmark_pipeline_followup.py --component cache \
  --data-root '/path/to/read-only/EDL data' --count 100000
```

Cache benchmarking simulates an 85% metadata change on temporary copies only.
The removed partial-reuse prototype timings are a recorded experiment, not a
feature or speedup present in this PR.
