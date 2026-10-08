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

## Evidence and limits

Python 3.12.14: 416 pipeline tests (one existing macOS skip), 48 frontend Python
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
