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

## Evidence and limits

Python 3.12.14: 404 pipeline tests (one existing skip) and 46 frontend tests
pass, including cache corruption, chunk boundaries, malformed/non-finite JSON,
EOD2 re-overlay, real process workers and dependency/failure-gate tests.

A frozen 100-symbol local breadth sample (87 eligible) took 9.305s before and
7.615s after: **18.16% lower elapsed time**. All four output-file SHA256 hashes
matched the audited baseline, with the generation timestamp held constant.
This is a stage/sample measurement, not a forecast of whole-job improvement.
Reproduce with Python 3.12 and the pipeline requirements installed:

```sh
python tools/benchmark_refresh_runtime.py --only breadth --limit 100 --data-root '/path/to/frozen/DO NOT DELETE EDL PIPELINE'
```

The existing offline benchmark can also compare classification/serialization;
those optimizations were already present in the branch's starting revision.

Provider transport, request concurrency, retry/backoff, freshness, PDF limits,
calculation thresholds, artifact schemas, archive retention, publication gates
and R2 verification were not relaxed. Source-only import skipping, lower gzip
levels, dropping retained archives and unbounded provider concurrency were
excluded because they can change behavior or output. No live fetch, pipeline
deployment or R2 publication was performed during verification; the next daily
run is needed to establish the overall improvement under actual runner load.
