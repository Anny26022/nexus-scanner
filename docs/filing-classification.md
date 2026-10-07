# Filing classification

The pipeline publishes 64 disclosure topics using the versioned, deterministic
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

`build_chart_artifacts.py` publishes announcement summaries and full evidence as
separate content-addressed objects. The taxonomy is shared once per release;
charts retain official corporate actions without embedding the filing archive.
The recent stock view covers 90 days, older history uses year pages of 100 filings,
and screening uses a seven-day cross-stock summary index. No classification runs
in the browser. See [lean announcement publication](lean-announcement-publication.md)
for storage, backup and delivery details. This change does not replace active R2
releases until the pipeline publishes after merge.

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

Version 5 includes `filing_source_labels.json`: exact normalized mappings for
244 descriptor labels, 121 announcement types and four category labels observed
in the retained archive. Normalization folds punctuation and case. Known
ambiguous labels (such as Appointment or Meeting Updates) intentionally map to
no topic and require text evidence. Previously unseen labels use specific regex
rules. The dictionary is committed code/configuration, not a generated runtime
artifact. Changes require fixture review and a classifier version increment.

Source labels are evidence, not a veto: current disclosure text may add independent
topics even when a source label is specific. Annual reports, presentations and
call transcripts retain stricter topic refinement to avoid promoting historical
achievements into new announcements. Multiple topics are allowed;
document type and status are separate fields. Each `events` entry carries its
topic, status, reference, versioned rule ID and the source field/excerpt used.
Status can be proposed, conditional, approved, executed, not_executed, completed,
not_completed, not_approved,
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

Rules inspect metadata and selectively extracted PDF text. They cannot prove semantic
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

## Version 5 event model and selective documents

Output explicitly identifies itself as `evidence_based_topic_tags`. Existing
filing IDs, topics, event status, rule IDs and source excerpts remain available.
There is no importance, sentiment or recommendation score.

New exact topics are `strategic_agreement`, `corporate_guarantee` and
`letter_of_intent`. `joint_venture` now requires an explicit JV description;
MoU labels map to strategic agreements. `borrowing` describes borrowing/loans;
guarantee source labels map to corporate guarantees. Existing topic IDs remain
in the taxonomy, but consumers should follow these refined meanings in version 5.
An intent letter alone is not an order win; commercial letters of award/acceptance
are recognised while the legal-order exclusion remains.

Each event adds `family`, `evidenceBasis` and `transactionStage`. Agreement events
also expose `instrument` (including binding versus non-binding term sheets) and
`agreementStage`. Explicit signing/execution is `executed`, not transaction
completion. Negated execution is `not_executed`; absent transaction evidence is
`unknown`. Explicit "between A and B" wording can expose `partiesMentioned`;
these are literal names, not resolved legal entities. A completion phrase must
refer directly to the transaction. Conditional terms stay visible in the evidence.
This remains a textual heuristic, not a universal language parser.

A `documentGroupId` groups observations using the same document URL. Revisions
retain distinct filing IDs and evidence. This does not merge different documents
into one economic event or infer that two agreements are the same transaction.

During `build_filing_history_artifact.py`, both daily and weekly pipelines now
attempt PDFs for ambiguous generic disclosures or agreement/guarantee/intent
filings from the latest 14 calendar days relative to the cache publication date.
Default budget: 20 attempts per run. `EDL_FILING_PDF_LIMIT=0` disables new downloads;
values are capped at 100; invalid values warn and fall back to 20. Newest eligible filings are attempted first, with a stable document-key tiebreaker. This is a
bounded enrichment pass, not a complete historical attachment backfill; an
oversized backlog can age out without extraction.

Downloads allow only HTTPS BSE/NSE archive hosts, validate redirects, impose
network timeouts and a 4 MiB file limit. Extraction uses pypdf, reads at most five
pages and retains at most 4,000 characters per page. Page/character truncation
is recorded. PDF parsing runs in a separate process with a 384 MiB address-space limit,
a 10-second CPU limit and a 15-second wall timeout. Unsupported isolation fails
closed to metadata-only tags (including the current macOS Python runner, whose
address-space limit is unsupported; the production Ubuntu runner supports it).
Encrypted, scanned/image-only, malformed or inaccessible files retain their
metadata tags; no OCR or AI inference is performed. Failures retry no sooner
than the next day. No attachment failure blocks normal filing publication.

The private runner cache is `filing_history_data/document_text.json`, already
covered by the existing filing-history Actions cache and Git ignore rules.
Keys include URL, publication timestamp, headline and body; changed metadata
invalidates the document observation. Unchanged PDFs behind reused URLs are not
automatically refetched. Old cached text remains usable on later publications.
This runner cache is not a durable backup guarantee.

The raw provider cache is not rewritten. Extracted text is used only in the
derived classification. Public filing detail output includes exact evidence with
`document_page_N` references and extraction status/hash/truncation metadata,
not whole PDF text or binaries. Chart metadata excludes wall-clock retry times. The R2 publisher delivers separate announcement objects through the shared release manifest.

Regression tests cover the observed Optiemus-style failure, guarantees, intent
versus award, mixed events, negation, non-binding agreements, historical
presentations, cache reuse and PDF-to-chart publication. These fixtures do not
establish an archive-wide accuracy percentage. Broader independently labelled
validation is still required before treating tags as authoritative categories.


Version 5 preserves conditional execution nouns ("execution of ... subject to
board approval") unless actual signing/execution is explicit. Ordinary loan
agreements no longer use the strategic-agreement fallback. Evidence excerpts
are literal windows of at most 360 characters around the topic match; full
clauses are used only internally to determine status and instrument. A stable
normalized clause ID collapses equivalent headline/body copies, including simple
attachment boilerplate, while different substantive clauses remain separate.
This is conservative normalization, not fuzzy event merging.
