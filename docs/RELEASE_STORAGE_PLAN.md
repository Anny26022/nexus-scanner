# Production evaluation and scanner release storage

This is a verification record and migration design, not a deployment or retention
change. No published revision, URL, schema, formula or missing-data policy changes.

## Production verification — 2026-10-09, approximately 13:46 UTC

Read-only Cloudflare inspection identified `nexus-scanner` as asset-only
(`has_assets=true`, `has_modules=false`), with no custom Worker domain configured.
The deployed site is https://nexus-scanner.aniketmahato26.workers.dev/.
Its served entry asset, `/assets/index-CVC4Ix5y.js`, explicitly uses `/api` as the
scanner fallback base; no external API base was compiled into that expression.

`GET /data/current.json` returned HTTP 200, session `2026-10-09`, revision
`c7a59ba04faec4d4228a82e2d5f33916235583e4fe73e9a7c1f0d2983fd2109e`.
`POST /api/screens/run` with that revision and a valid empty-group screen request
returned HTTP 405 and an empty body. This demonstrates that fallback evaluation
is unavailable on this deployment. It does **not** establish a condition failure
percentage: explicit cases, precomputed preset membership, parameter support,
session alignment and browser history availability all affect fallback usage.

The required operational fix is a separately hosted historical evaluator, with
the matching frozen `.scanner_cache/revisions/<revision>` inputs and required
history. Configure its API base at build time, rebuild, and verify CORS, limits,
process supervision, unavailable-data diagnostics and exact immutable-revision
matching. Do not point the frontend at an unrelated live-data service or emulate
historical formulas in a new Worker. See the existing deployment contract in
[frontend/README.md](../frontend/README.md#historical-evaluation-deployment).
Retest the deployed bundle and POST endpoint after any deployment change.

## Proposed migration — separate operational work

Current scanner releases contain plain JSON, gzip and packed gzip intentionally.
Plain JSON remains necessary for compatibility and older revision lookups. The
schema-7 chart object/release retention policy is separate and remains unchanged.

1. Inventory every committed scanner revision and frozen backend revision. Record
   each existing relative URL, byte count and SHA-256; identify any historical
   revisions whose backend inputs are absent without claiming they are evaluable.
2. Copy each scanner revision file to durable R2 storage under the same revision
   and filename. Verify downloaded bytes and checksums, JSON parsing, gzip decoding,
   MIME types and cache headers. Retain all three stock representations.
3. Serve the existing `/data/revisions/<revision>/<file>` paths through a same-origin
   proxy to R2. Preserve plain-JSON historical lookup and browser/no-decompressor
   paths. Serve `.gz` consistently as either raw gzip or HTTP-decoded content, never
   double-decompress. A production R2 custom domain is an alternative only after
   compatibility URLs and CORS are explicitly handled.
4. Shadow-test current and old releases against repository delivery: identical
   bytes, hashes, rows, ordering, unavailable diagnostics and immutable revision.
   Verify offline/error handling and rollback. Do not change hash inputs or schemas.
5. Upload and verify every immutable object before changing `current.json`. Keep
   the pointer revalidated and immutable files cached. Retain repository delivery
   during rollout so reverting the routing/pointer restores the previous release.
6. Only after compatibility checks pass, stop adding new large revision payloads
   to Git. Removing current-tree files will not reclaim existing Git history;
   any history rewrite requires a separately approved backup/migration plan.

No automatic deletion or retention cutoff is proposed. Browser files and frozen
backend inputs require a coordinated retention decision; Actions caches are not
durable historical storage. R2 routing, credentials, infrastructure ownership and
backend hosting must be selected before implementation.

Cloudflare's [public-bucket documentation](https://developers.cloudflare.com/r2/buckets/public-buckets/)
describes production custom-domain delivery and cache configuration; `r2.dev` is
for non-production use. Existing chart publication behavior is documented in
[r2-chart-publication.md](r2-chart-publication.md).
