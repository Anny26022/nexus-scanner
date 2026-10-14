# Pinned StockScans audit extracts

These deterministic gzip archives preserve the original scrape bytes for audit
and reproduction. They are not pipeline inputs and are not downloaded at runtime.
Use `gzip -dc <file.json.gz>` to inspect them without creating intermediates.

- `cyclone-default-results-partial-4800-of-6725.json.gz`: partial default view,
  exported 14 October 2026; 4,800 of 6,725 source records, limited by source rate
  limits. The original JSON contains provenance and retrieval metadata.
- `cyclone-technical-results-82.json.gz`: separate technical-view extract; not a
  replacement for the default-view classification resource.

The application uses the compact packaged
`DO NOT DELETE EDL PIPELINE/stockscans_classification.json`, containing exact NSE
sector/industry pairs. The raw archives retain source spellings; the resolver
applies only the four explicit spelling aliases in `taxonomy_overrides.json`.
