# Lossless data size audit — 2026-10-07

Inspected the 68 tracked JSON/gzip JSON files, the scanner publisher and loader,
shared pipeline writers, breadth writer, IPO/chart loaders and Tijori exporter.
Sizes below use decimal MB and the committed dataset, not estimates.

| Artifact | Existing JSON | Optimized JSON | Existing gzip | Optimized gzip |
| --- | ---: | ---: | ---: | ---: |
| Browser scanner (2,609 records) | 10.48 MB | 4.31 MB | 1.21 MB | 0.85 MB |
| Quarterly financial history | 48.62 MB | 34.34 MB | 3.44 MB | 3.24 MB |
| Fundamental analysis | 28.33 MB | 20.30 MB | 3.39 MB | 3.13 MB |
| IPO screener | 17.46 MB | 9.11 MB | 1.51 MB | 1.31 MB |
| Sector breadth | 50.95 MB | 31.59 MB | 2.57 MB | 2.29 MB |

Scanner savings use a versioned columnar wire format: top-level row keys and four
nested object key sets are stored once. Missing properties remain distinct from
explicit null, and numbers, booleans, strings, arrays and metadata are unchanged.
The worker reconstructs the standard records before calling the existing engine.
The actual 2,609 records round-trip exactly; 368 requests covering every published
preset, four universes and two pages returned identical responses.

The manifest optionally advertises `datasetPackedGzipUrl`. Standard `stocks.json`
and `stocks.json.gz` remain for older clients and pinned historical revisions.
New clients also accept old manifests. Packing code participates in the revision
hash, and the existing publisher writes the new asset before switching pointers.
This reduces the new browser download, not the reconstructed record heap or total
Git storage: compatibility requires keeping the standard endpoints.

For pipeline artifacts, existing shared and breadth writers now emit compact JSON.
The schema, values, finite-number normalization and atomic replacement stay intact.
Explicit indentation remains supported by the shared writer. Savings above are
measured by lossless compaction plus gzip level 9; actual files change on their next
pipeline run. The 66.68 MB breadth-contributions gzip is a backend artifact, not an
initial browser download; its savings have not been measured in full.

IPO and charts already load on demand. Tijori published reports already use compact,
sorted gzip JSON. Financial history is already separate from scanner rows.
Old immutable revisions and raw source data were not rewritten or deleted.
No new pipeline, dependency, calculation, preset or rounding rule was introduced.
