# Theme Tracker classification

Scanner publication now emits `theme-classification.json.gz` beside each immutable
stock snapshot. `current.json` advertises `themeClassificationUrl` and
`themeClassificationVersion`. Vite/Workers publish it through the existing public
data assets flow; it does not add per-stock requests.

Primary sector/basic-industry classifications and optional `nicheTags` are resolved
once in the fundamentals pipeline, using the pinned `taxonomy_overrides.json`
resource. It ships in the pipeline wheel and is available when Actions builds in
a temporary data directory. Provider sectors remain broad; reviewed company
overrides supply missing or corrected primary classifications. Four
equivalent sector spellings are normalized without merging distinct businesses.
Original provider labels remain in `provider_sector`/`provider_industry` and are
published as `providerSector`/`providerIndustry`. The theme bridge uses those
original labels so reviewed display classifications cannot remove existing themes.
The browser consumes the published values without applying another override layer.
Resource bytes affect release revisions; existing snapshots keep their original
classifications. These additional metadata fields do not alter completeness scores.

Bullion/refining niches are separate from primary classifications: AUGMONT,
RAJESHEXPO, AUSOMENT and ABANSENT have `Bullion Trading` tags. Direct refining
is tagged separately from `Precious Metals Refining (JV)` for AUSOMENT and MMTC.
`nicheAssignments` records the evidence URLs, review date and exposure scope;
these publish as `nicheEvidence` alongside `nicheTags`. Existing company tags
are retained. LGHL remains in the review queue because current issuer evidence
does not corroborate the cached bullion description. These assignments do not
replace the pinned Tracker theme or infer tags from jewellery labels.

The pinned `frontend/theme_tracker_source.json` contains the production public
asset's taxonomy fields plus the reviewed listing overrides and ordered catalogue
rules from the verified production commit. Source URL, source data date, deployed
commit, response headers and original asset checksum are retained. Financial
metrics, candidate fields and company names are omitted from this classification
input. Its source date is not the stock session date.

Priority follows Theme Tracker: canonical source row, curated memberships, explicit
symbols, then exact source-industry rules. Mirror groups are aliases rather than
additional business exposures. Industry rules use Tracker's own industry
vocabulary, never Scanner's similarly named but different classifications.

Each symbol has a primary theme, optional block/macro, all memberships with their
assignment basis, aliases and source sub-industry. A URL-backed issuer mapping or
an exact scanner sector/industry bridge can supply a primary theme only when the
pinned Tracker source has none. Bridge mappings are explicitly marked
`scanner-industry-bridge` with `medium` confidence, so they remain distinguishable
from source and issuer research. Records expose URLs only for issuer-backed primary
mappings. An issuer-backed `issuerOverlay` can add a business niche without
replacing the canonical theme: AUGMONT remains in Tracker's Jewellery theme while
its overlay names its bullion, refining and digital-gold platform. No niche is
inferred from a sector label. Joins are exact security symbols, not fuzzy company
names; renamed/BSE-only identities require reviewed aliases or a future ISIN
crosswalk. Invalid duplicate symbols or themes, and invalid override/bridge theme
names, fail publication rather than silently falling through.

Daily publication is offline and deterministic. Source and resolver bytes both
affect the mapping version and release revision. Source updates are deliberate:
verify the Ready Vercel production deployment, re-import its public asset and the
matching commit's catalogue/overlays together, review coverage and tests, then
commit the pinned input. Never silently update it from an unverified master branch.
Existing immutable releases are unchanged. The copy menu loads this artifact once
per release to group full matching results by theme, sub-industry, thematic block
or macro pillar. Sector/industry and flat symbol exports use stock rows directly.
Grouped output follows `###Theme(count),NSE:SYMBOL,...`, with missing assignments
under `Unclassified`. Groups are sorted by name; symbols retain scan order within
each group. Niche exports are omitted until issuer niche coverage is meaningful.
Older releases without the artifact report its absence when a theme export is
requested. Theme filters, hover-card presentation and a Theme Tracker screen
remain separate UI work.

## Primary sector and basic industry

`frontend/public/data/universe-classification.json` is a checked-in local preview
of the consolidated output, labelled with its input revision and session date.
Each normal publication generates its own immutable
`/data/revisions/<revision>/universe-classification.json`, referenced by
`universeClassificationUrl` in the current manifest. Use that manifest URL for
the latest published data rather than the static preview. Records include primary
sector/basic industry, original provider labels, niche tags and evidence, plus
the full nested `thematic` record (theme, sub-industry, block, macro, memberships,
aliases, mapping confidence, evidence and issuer niche overlay). These separate
fields preserve the distinction between business industry and thematic taxonomy.

The pinned `stockscans_classification.json` is the primary classification source,
using exact NSE symbols from the extracted StockScans JSON (14 October 2026).
It contains 2,859 NSE entries and covers 2,251 of the current 2,604 stocks.
The extract is partial: the other 353 stocks retain reviewed company corrections
where present, otherwise their daily provider classification. Missing individual
fields retain the same fallback. Raw provider labels remain available as metadata
and continue to support the existing Theme Tracker bridge. Nexus Journal themes
and source-backed niche tags are independent and unchanged. This is a pinned
extract, not a new daily StockScans scraper; new listings use the fallback until
the resource is updated. Resource changes participate in the snapshot revision.

The resolver applies the same four explicit sector spelling aliases to extract
rows, reviewed corrections, and provider fallbacks. It does not merge broader
business categories. Raw audit extracts are archived under
`reference/stockscans/*.json.gz`; these are not runtime inputs.

The consolidated public preview is deliberately retained as a requested review
artifact, not regenerated in place each day. It is not fetched by the screener
on startup. Daily consumers should follow `universeClassificationUrl` in the
manifest. Do not ignore all of `frontend/public/data`: the existing release
workflow intentionally commits and serves versioned snapshots there.
