# Theme Tracker classification

Scanner publication now emits `theme-classification.json.gz` beside each immutable
stock snapshot. `current.json` advertises `themeClassificationUrl` and
`themeClassificationVersion`. Vite/Workers publish it through the existing public
data assets flow; it does not add per-stock requests or alter stock sector/industry.

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
Existing immutable releases are unchanged. This adds a data contract only; theme
filters, hover-card presentation and a Theme Tracker screen are separate UI work.
