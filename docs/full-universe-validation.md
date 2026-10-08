# Full-universe performance validation

Run validation outside the source checkout. These commands read local history
and create diagnostic files; they do not upload to R2 or promote `current.json`.

```sh
python3 scripts/validate_scanner_full_universe.py \
  --source "/path/to/nexus-scanner/DO NOT DELETE EDL PIPELINE" \
  --output /path/to/validation
node scripts/benchmark_scanner_worker.mjs /path/to/validation/packs/REVISION
```

The Python validator selects the metadata session by default and refuses a run
with fewer than 2,000 aligned stocks. For a performance-only run against a newer
price session, pass `--session YYYY-MM-DD`; the report records both dates. Such a
run does not establish price/fundamental date alignment or financial correctness.

The validator computes strength and industry context over the whole peer universe,
then processes requested symbols in stable shard batches. Per-symbol checkpoints
include selected detailed bases, runtime family candidates, completion coverage,
and dated strength ranks. Restarting the same source revision and engine reuses
completed checkpoints. Changes to source history or the engine invalidate them.
The diagnostic pack does not regenerate the complete replay archive: checkpoint
episodes are deliberately compact. Its manifest is marked `validationOnly`.

`build-report.json` records universe size, candle and episode counts, compressed
private object sizes, maximum decoded auxiliary size, build duration and Python
peak RSS. All 32 shards must build successfully; the publisher enforces a 12 MiB
decoded limit on every auxiliary shard. The existing published stock rows supply
the native metadata payload shape; their session is recorded in the report. Prices
and base facts are updated from the chosen validation session, but the validator
does not recalculate the whole financial/preset snapshot.

The JavaScript benchmark runs the actual bundled Worker in local workerd using
Miniflare R2 and Cache API fixtures. It exercises scalar, arbitrary MA convergence,
setup-family and nested history expressions across the entire manifest universe.
`worker-performance.json` records cold and cached latency, match/unavailable counts,
V8 heap/backing-store samples and an active CPU-profile estimate. A small fixture
requires `--smoke` and is explicitly labelled as such; it cannot establish
full-universe performance acceptance.

Local acceptance targets are cold latency <=10 seconds, cached latency <=500 ms,
sampled V8 usage <100 MiB and estimated active CPU <30 seconds. Heap sampling can
miss brief peaks, and V8 accounting is not total isolate memory. CPU samples are
not Cloudflare billed CPU time. Deployed R2 network latency, actual isolate memory
and billed CPU still require measurements on Cloudflare with the same revision.

## Runtime candidate retention

Worker packs retain every live forming, fresh-breakout and holding candidate.
They preserve the base start/end dates and every metric required by the four
materialized setup families, including optional contraction, accumulation, trend
and breakout confirmation policies. Tests compare projection dependencies and
selected witness identity against full records.

Completed candidates are limited to the two latest witnesses per pivot basis.
`setupCandidateHistoryComplete` flags any truncation. A `PLAYED_OUT` family screen
returns unavailable for those stocks; it must not silently run against a partial
outcome set. Complete historical outcome research uses the durable production
`base-history` archive. This limitation needs to remain visible when discussing
arbitrary completed-setup screening support.
