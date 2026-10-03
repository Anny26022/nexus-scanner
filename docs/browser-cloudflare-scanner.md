# Browser-first scanner and Cloudflare advanced engine

## Runtime architecture

The latest closed NSE session is evaluated through one of two deterministic paths.

1. The browser downloads `core.json.gz` and starts a dedicated Web Worker.
2. The capability registry examines every leaf in the full expression.
3. Scalar and common-window expressions load only the required `technical` or `fundamentals` pack and run locally.
4. If any leaf needs arbitrary OHLCV history, the complete expression is posted to the Cloudflare Worker. Nested groups are never split across runtimes.
5. The Worker validates the immutable revision, reads private R2 shards in batches of four, and caches the canonical response for that revision for 30 days.

The product remains latest-session-only. No as-of date selector or historical screening endpoint is introduced.

## Schema 7 public release

Every immutable frontend revision contains:

| File | Contents |
| --- | --- |
| `core.json.gz` | Symbols, names, table/search values, current prices, and universe identifiers. |
| `technical.json.gz` | Published returns, common averages, RVOL, turnover, volatility, event flags, distances, RS values, and preset matches. |
| `fundamentals.json.gz` | Valuation, filings-derived values, delivery, surveillance, membership, and regulatory metadata. |
| `stocks.json` / `stocks.json.gz` | One-cycle compatibility snapshot for clients older than schema 7. |
| `ipos.json` | IPO catalogue. |

`current.json` includes the URL, compressed byte count, SHA-256, encoding, and schema version of each pack. The publisher stops if the core pack exceeds 1.25 MB or all public packs exceed 4 MB compressed. The client validates the byte count, digest, revision, session, and row count before using a pack.

The newest two validated revisions are retained in IndexedDB. The Web Worker also keeps its existing small in-memory cache. Both caches use the immutable revision and content digest in their key.

## Private R2 scan packs

Private objects live in `nexus-screener-private-data` under:

```text
scanner/v1/revisions/<revision>/
  manifest.json
  metadata.json.gz
  benchmarks.json.gz
  auxiliary/00.json.gz ... auxiliary/31.json.gz
  shards/00.bin.gz ... shards/31.bin.gz
```

Symbol placement uses the first SHA-256 byte modulo 32, so it remains stable across publications. Each binary shard stores:

- an indexed symbol header;
- integer epoch-day arrays;
- Float64 open, high, low, close, and volume arrays;
- at most 1,500 recent sessions per symbol.

Each auxiliary shard contains dated delivery and earnings inputs for the matching OHLCV shard. This prevents the full filings ledger from occupying the Worker isolate. Benchmark histories are separate so every shard does not repeat them. `metadata.json.gz` supplies latest-session stock and fundamental values to the advanced engine.

The publisher uploads and verifies every data object before copying `manifest.json`. The private manifest is the commit marker. Chart publication and the public `current.json` update happen afterward, so any configured upload failure leaves the previous public release active. The private bucket retains seven revisions; chart retention remains independent.

## Worker API and limits

The package is in `cloudflare/scanner-worker`.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/health` | Reports the active release and whether its private manifest is present. |
| `POST /v1/screens/run` | Runs a validated full expression against the latest immutable revision. |

Requests are limited to 100 KB, 32 leaves, 8 expression levels, and 100 rows per page. The Worker configuration requests 30 seconds of paid CPU. Shards are loaded four at a time to keep peak isolate memory below the 128 MB platform ceiling. R2 bindings remain private; no credentials or object URLs are returned to clients.

Only configured frontend and localhost origins receive CORS headers. Cache keys contain the revision, full expression or text query, universe, custom symbols, sorting, and pagination. Cached responses are immutable for 30 days.

## Deterministic query behavior

The TypeScript query compiler accepts only complete, recognized `field comparison value` clauses joined by `AND` or `OR`. `AND` binds more tightly. Parenthesized labels such as P/E, EPS, dividend yield, and absolute volume are matched as complete labels. Unsupported fields and malformed clauses fail the request; no guessed leaf, fallback RVOL rule, or reduced expression is executed.

Python remains the publication and preset authority. The shared TypeScript runtime implements three-valued results (`match`, `no match`, `unavailable`), strict and inclusive operators, repeated conditions, negation, nested boolean expressions, indicator comparisons, convergence, Supertrend, confirmed divergence, patterns, RS, delivery, earnings, and context filters.

## Configuration

Repository secrets:

- `CLOUDFLARE_API_TOKEN` scoped to Workers deployment and the scanner bucket
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Repository variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `ALLOWED_FRONTEND_ORIGINS`
- `SCANNER_RELEASE_URL`
- `SCANNER_API_BASE_URL`

Pipeline environment:

- `EDL_SCANNER_STORAGE=r2`
- `SCANNER_R2_BUCKET=nexus-screener-private-data`

Frontend production environment:

- `VITE_API_BASE_URL=<SCANNER_API_BASE_URL>/v1`

Until a static frontend host is configured, the Worker reads the immutable release pointer from the repository's raw `main` URL. Set `SCANNER_RELEASE_URL` to the deployed frontend's same-origin `data/current.json` when that host is introduced.

The local Vite server continues to use the Python bridge when `VITE_API_BASE_URL` is omitted.

## Deployment and rollback

1. Enable Workers Paid and create the private R2 bucket.
2. Configure secrets and variables.
3. Deploy `cloudflare/scanner-worker` and check `/v1/health`.
4. Run the pipeline to upload private packs and generate schema 7 public packs.
5. Run browser, Worker, checksum, and parity tests.
6. Publish immutable frontend files and update `current.json` last.
7. Set the frontend API base URL to the Worker.

Rollback restores the previous immutable `current.json` pointer and, when needed, the previous Worker deployment. Seven private scanner revisions are retained for this purpose.
