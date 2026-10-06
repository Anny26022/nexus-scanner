# Filing classification

The pipeline publishes 61 disclosure topics using the versioned, deterministic
rulebook in `DO NOT DELETE EDL PIPELINE/filing_classification.py`. Classification
describes filing content, not financial impact or a recommendation. It does not
claim to reproduce any other site's private classifier.

## Sources and publication

`fetch_company_filings.py` retains Dhan/ScanX company-filings and LODR metadata,
including descriptor, announcement type, caption, body, publication time and
document URL. The resumable cache remains the raw source of record.

Daily and weekly refreshes catch up both feeds until a fully retained page is
reached, or all provider-reported pages are exhausted. A mixed new/old page does
not stop pagination. Initial LODR backfills traverse all pages. An incomplete
catch-up also retries all reported pages, preventing its partially cached first
page from hiding a still-missing middle. Unchanged completed histories normally
require only page one. Recent per-symbol files retain page-one snapshots;
additional recovered pages belong to the persistent history.

Deduplication retains changed content even when a provider reuses a news ID.
Identical observations and non-conflicting enrichment (such as adding a PDF URL
or body) merge; conflicting captions, bodies, dates, labels or URLs remain
separate observed versions. Cross-feed identities stay separate until publication
merges identical documents with their provenance. This cannot detect an edited
PDF whose URL and supplied metadata/body remain unchanged.

Each history entry publishes `fetch_status` for both endpoints: `last_attempt_at`,
`last_success_at`, `refresh_complete`, `pages_fetched`, `total_pages` and `error`.
Success time advances only after catch-up completes; failures retain prior data
and success time. `updated_at` records a cache update, not a successful fetch.
`lodr_backfill_complete` describes the historical sweep and is not proof that
both feeds refreshed today. Freshness metadata passes into the published history
artifact. Older edits below the overlap page are not guaranteed to be revisited.
The daily and weekly fetch behavior is identical; no extra weekly full scan is
introduced by this change.

`build_filing_history_artifact.py` classifies the entire retained history every
publication, so rule changes also update old records without refetching them.
The artifact contains the taxonomy, classifier version, filing count and
unclassified count. Daily and weekly workflows already run this stage before
chart generation. No additional classified cache is introduced.

`build_chart_artifacts.py` carries the classification, original publication
timestamp, source labels, source endpoints and filing ID into per-symbol
compressed chart files. The existing R2 publisher uploads these with the chart
release. A taxonomy accompanies each chart for consumers; the existing generic
`category` field remains compatible. No classification runs in the browser.
This PR does not deploy or replace active R2 releases.

Official NSE corporate actions remain authoritative for action dates and price
adjustments. A filing publication date is not an ex-date or meeting date.
Chart corporate actions also carry classification and structured terms parsed
from the official subject: dividend amounts per share, bonus issued/held ratio,
and split old/new face values where explicit. Ex-dates and record dates are
copied from the ledger. Raw subjects remain available and missing terms stay
absent; no inferred payout or date is substituted.
Filing topics do not change adjustment factors. Automatic cross-source action
linking is deferred until there is a reliable matching contract.

## Rules and meaning

Version 3 includes `filing_source_labels.json`: exact normalized mappings for
244 descriptor labels, 121 announcement types and four category labels observed
in the retained archive. Normalization folds punctuation and case. Known
ambiguous labels (such as Appointment or Meeting Updates) intentionally map to
no topic and require text evidence. Previously unseen labels use specific regex
rules. The dictionary is committed code/configuration, not a generated runtime
artifact. Changes require fixture review and a classifier version increment.

Specific source labels precede caption/body fallback. Generic announcements and
procedural documents can be refined by their text. Multiple topics are allowed;
document type and status are separate fields. Each `events` entry carries its
topic, status, reference, versioned rule ID and the source field/excerpt used.
Status can be proposed, conditional, approved, completed, not_completed, not_approved,
withdrawn, cancelled, revised, adverse, restriction_lifted or unspecified.
The top-level status reflects explicit substantive non-wrapper statuses first.
It is `mixed` when those statuses differ; wrapper statuses are used only when
no substantive status is available.
Historical-reference phrases are flagged separately; presentations do not
automatically turn their past achievements into new announcements.
These are textual
signals, not confirmation that a transaction has settled.

Regulatory observations, restrictions and lifted import alerts use
`regulatory_update`; an inspection without adverse observations is not a product
approval. Provisional operational updates, sustainability reports, certificate
notices, book closures and auditor reports also expose document subtypes.

Tax/legal orders are excluded from order wins. Trading-window notices and
trading plans are excluded from insider transactions. Meeting intimations do
not claim financial results have been announced. ESOP and daily buyback
paperwork have their own labels. Unknown records remain `unclassified`.
Every matched topic carries a stable rule ID and classifier version. Wrapper
documents can retain several substantive topics, including mixed action statuses.

Identical same-time documents with the same URL, caption and body merge across
feeds while retaining source labels and endpoints. Revised content and different
timestamps remain separate. Classification is recomputed from all merged source
labels so topics, event status and document type remain consistent. This
conservative merge can leave duplicates where
the feeds use different timestamps or wording; it avoids erasing real updates.

Version 3 rejects negated approvals and completions, preserves separate
regulatory approval/update clauses, and treats revisions before positive
approval/completion states. Withdrawals and cancellations take precedence.
Missing action dates and empty subjects are omitted rather than serialized as null.

## Limits and validation

Rules inspect metadata/text only, not PDF attachments. They cannot prove semantic
correctness for every record. Before enabling category filters, review a stratified
sample, especially legal orders, defaults, governance and fundraising. Track the
unclassified rate and refine the rulebook with regression fixtures. Importance
is a user display preference; no inferred importance score is published.

The version-2 audit enumerated labels across 1,089,666 local records and evaluated
829 examples selected across all raw source-label families (264 descriptor
variants, 123 announcement-type variants and four category variants). Compared
with version 1, 98 examples changed topics and unclassified examples fell from
67 to 55. These are coverage/regression observations, not an accuracy score or a
claim that all PDFs were read. Regression fixtures cover commercial/tax orders,
fraud captions, signature boilerplate, operational aliases, regulatory negatives,
conditional and mixed actions, duplicate feed order and official action terms.
The audit did not replace production artifacts; the next pipeline run after
merge regenerates classification and publishes through the existing release flow.

The historical archive is large. Publication reclassifies it in memory with the
existing artifact builder; an incremental classified cache is deferred until
measured runtime justifies the extra storage and invalidation logic.
