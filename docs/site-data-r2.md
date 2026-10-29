# Published site data in R2

The site's `/data/...` files used to be committed by every refresh and shipped as static assets. Each data change
needed a commit, a Worker rebuild and room under the static-asset file limit (one revision is ~2,600 files). They
are now published to the R2 bucket `nexus-screener-chart-data` and served by the `nexus-scanner` Worker. A refresh
goes live as soon as its pointer is uploaded. Every `/data/...` URL stays the same and same-origin.

## Layout

| URL | R2 key | Cache-Control |
| --- | --- | --- |
| `/data/revisions/<rev>/<file>` (one subfolder allowed, e.g. `financial-history/<symbol>.json.gz`) | `releases/<rev>/<file>` | `public, max-age=31536000, immutable` |
| `/data/company/revisions/<rev>/<file>` | `releases/company/<rev>/<file>` | `public, max-age=31536000, immutable` |
| `/data/current.json`, `sessions.json`, `price-band-history.json`, `ai-filter-choices.json`, `results/index.json`, `results/us_index.json`, `heatmap/index.json`, `company/current.json` | `site/data/<same path>` | `no-cache` |

Any other `/data/...` path answers 404, including the development-only `objects/`, `rotation/`, `snapshots/` and
`charts/` folders and the unreferenced top-level `stocks.json`, `ipos.json` and `universe-classification.json`.
The route is `workers/screener-ai/siteData.ts`, and `frontend/site_data.py` is the publisher. A test keeps their
pointer lists the same.

The route sends the stored bytes and headers unchanged. The pipeline stores `.json.gz` as `application/gzip`
without `Content-Encoding`, which matches the static files: readers check the gzip magic bytes. An object stored
with `Content-Encoding` keeps it, and the Worker sends its body with `encodeBody: 'manual'` so the runtime does not
gzip it a second time (see #178). Responses carry `Access-Control-Allow-Origin: *`, as `_headers` gave the static
files, and support `If-None-Match`.

### Compatibility with Nexus Journal

The journal's R2 data mode (`packages/nexus-scanner/src/api/origins.ts` in `new_nexys_ultimate`) maps
`/data/revisions/<rev>/…` to `releases/<rev>/…` and `/data/company/revisions/<rev>/…` to `releases/company/<rev>/…`.
It reads its own pipeline's pointers from `daily/journal/…`. The immutable files above use exactly that layout, so
URLs in this site's manifests resolve in the journal's R2 mode too. `releases/<rev>/` already held this
pipeline's `index.json`, `release.json` and plain `stocks.json`.

The pointers use their own prefix, `site/data/`, for two reasons:

- `daily/journal/` belongs to the journal's pipeline (its runbook calls those "journal-owned R2 keys"). Writing
  there would make the two pipelines overwrite each other's `current.json`.
- `daily/` has a 90-day lifecycle rule. A pointer that stopped being rewritten, such as weekly company data during a
  long pause, would expire and take the site down.

The journal's legacy mode reads `<scanner origin>/data/...` and keeps working unchanged. To read this pipeline's
pointers from the `nexus-scanner-data` Worker instead, that Worker would need `site/` in its prefix allowlist.

### Other readers

- The scanner frontend reads `/data/current.json`, `/data/sessions.json`, `/data/price-band-history.json`
  (fallback), `/data/results/index.json`, `/data/heatmap/index.json`, `/data/company/current.json` and the revision
  files those name. `/data/rotation/local.json` is local only and already failed softly in production.
- The AI endpoint read `/data/ai-filter-choices.json` from the build's assets. It now reads
  `site/data/ai-filter-choices.json` from R2, or from `frontend/public` under `wrangler.dev.jsonc`, which has no R2
  binding.
- The pipeline reads `current.json` (the previous release and the older-session guard), `sessions.json` (archived
  sessions), `price-band-history.json` (the band ledger it extends), the Earnings Pulse indexes and
  `company/current.json`. `site_data.py pull` downloads them before each refresh.
- `tools/export_tijori_overviews.py` reads the current release from the runner's own `frontend/public/data`, which
  the build step has just written.
- The price-band extension and the journal's code have no other references to these files.

## Publication order

`publish_snapshot.py` calls `site_data.publish_site` last:

1. Revision files go to `releases/<rev>/` with `rclone copy --immutable --checksum`, then `rclone check --download`.
2. `ai-filter-choices.json` is built from that release and uploaded.
3. `price-band-history.json` and `sessions.json` are uploaded.
4. `current.json` is uploaded last.

Each pointer is read back before the next one is uploaded. A failure at any point leaves the previous `current.json`
live, as an uncommitted Git refresh did. After the Earnings Pulse, heatmap and Tijori steps,
`site_data.py push-indexes` publishes whichever of their indexes changed. A changed `company/current.json` has its
revision uploaded first. The backfill workflow publishes `sessions.json` with `push-sessions` after its snapshots are
verified.

### The AI catalogue

The AI endpoint answers 409 when the browser's dataset revision differs from the catalogue's. The catalogue used to
be built by `frontend/build_ai_filter_choices.mjs` during the site build. Data published without a rebuild would
therefore have made Ask AI fail with 409 every day. The catalogue is now built by the pipeline from the release
being published (`site_data.build_ai_filter_choices`, a port that produces identical output) and uploaded just
before `current.json`. The build no longer creates it. The Vite dev server regenerates it locally with
`python3 site_data.py ai-choices`.

## What Git still commits

`commit-refresh-outputs` now stages only `reference/`: the index-constituent snapshot daily, and Tijori and Dhan
weekly. These are pipeline files, not site data. The next weekly run reads them (the Dhan sync refuses to clear
known members, and the Tijori export resumes from its cache), and their history records constituent changes. They
still make a commit, so exclude `reference/*` in Workers Builds' build watch paths (dashboard → nexus-scanner →
Settings → Build → Build watch paths) to stop those commits from rebuilding the Worker. Moving them into
`pipeline-state/` (tools/pipeline_state.py) would remove the commit entirely.

## Local development

With `EDL_CHART_STORAGE=local` (the default) the publisher writes everything to `frontend/public/data`, including
`ai-filter-choices.json`, and uploads nothing. Vite serves those files directly. Before the cut-over clean-up,
checkouts keep the last committed copies. Afterwards, run a local publication to populate them.

## Cut-over

1. **Watch paths.** In Workers Builds, exclude `reference/*` and `frontend/public/data/*`.
2. **Lifecycle.** Check that no R2 lifecycle rule covers `site/` or `releases/`.
3. **Seed.** From an up-to-date `main` checkout, after that day's refresh commit and before merging, run
   `python tools/seed_site_data.py` to review the plan, then `python tools/seed_site_data.py --write` with the
   workflows' R2 settings. It is safe to re-run. Re-run it if another refresh commit lands before the merge.
4. **Merge and deploy.** Merging deploys the Worker with the `DATA` binding and `/data/*` routed through it. Check
   `curl -sI https://nexus-scanner.aniketmahato26.workers.dev/data/current.json` shows `cache-control: no-cache`
   and the seeded revision. A `/data/revisions/<rev>/stocks.packed.json.gz` request should show the immutable header
   and `content-type: application/gzip`. Then check the screener loads and Ask AI answers.
5. **One refresh.** Run Daily Data Refresh by hand. Its log should show `Verified: site/data/current.json`, and its
   commit should touch only `reference/`. `/data/current.json` should then name the new revision without a deploy,
   and Ask AI should accept the new release.
6. **Clean up (follow-up commit).** Only after step 5:
   `git rm -r --cached frontend/public/data/{current.json,sessions.json,price-band-history.json,revisions,results,heatmap,company,stocks.json,ipos.json,universe-classification.json}`.
   The files are already in `.gitignore`. Git history keeps the old versions; rewriting it is a separate decision.

Rollback before step 6: revert the merge. The static files are still in the tree, and the next build serves them
again. The pipeline's R2 copies are ignored by the old code.
