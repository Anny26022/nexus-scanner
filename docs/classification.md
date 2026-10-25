# Classification contract

Reviewed and implemented on 25 October 2026. This is the contract shared by publication, screening,
filter choices, AI filters, Earnings, copy/export, Charts, IPO Catalogue, Market and Rotation.
The machine-readable review is `reports/classification-remediation-2026-10-25.json`.
The reasons for introducing the PR, causal analysis and rollout boundaries are in
[the root-cause document](classification-root-cause.md).

## Meaning of each dimension

| Dimension | Meaning | Membership |
| --- | --- | --- |
| Sector | Published primary business sector | One per company, or unavailable |
| Industry | Published primary business industry | One per company, or unavailable |
| Sub-industry | More specific Tracker/reviewed business description | One where supported; otherwise unavailable |
| Theme | Business category or explicitly curated business exposure | Multiple; one deterministic primary for display |
| Thematic block | Parent of an actual business/exposure membership | Distinct union of all direct memberships' parents |
| Macro pillar | Parent of those thematic blocks | Distinct union of all direct memberships' parents |
| Listing cohort | Dated listing/history rule | Independent of business membership |
| Theme aggregate | Defined union of narrower categories | Derived lookup/grouping; does not create new exposure parents |

Sector and industry are the app's curated company taxonomy, not a claim that all labels are an official
exchange standard. Provider originals are retained when available. Tracker's legacy `industry` is a
different vocabulary and must never overwrite the published company industry during a join.

The source is a graph rather than one universal tree. A company has one primary business classification
and may participate in several themes. An alias is a spelling/name lookup for a canonical category;
it is never another exposure. An aggregate is a union, not evidence of a separate line of business.
If the evidence supports only a broad aggregate, it may be retained as an explicitly broad primary theme;
the classifier does not guess a narrower leaf.

## Multiple membership

`theme`, `block` and `macro` scalars describe the primary membership for old clients and compact display.
`memberships` records every approved direct business/exposure membership with its basis.
`levels` is the authoritative projection for all grouping and filtering. Consumers must use
`classificationLabels` in TypeScript or `group_labels` in Python rather than testing a provenance string.

For example, CYIENTDLM retains Industrial Systems & Controls and also participates in Emerging EMS.
Both memberships are available in screening, Earnings, copy and Rotation. Its parent groups are the
distinct union of both paths. If two paths reach the same block or macro pillar, it contributes once to
that parent. A union of screen results likewise counts each security once. Counts across overlapping
themes must not be summed to obtain a universe total.

Categorical filters support ANY (at least one selected membership) and ALL (every selected membership).
Different dimensions combine using the screen's normal Boolean expression. Unknown classification is
different from a known company outside a selected group: negation does not turn unavailable data into a
match. A failed sidecar fetch is a retryable error, not a universe of falsely Unclassified companies.
Unknown, alias and retired theme predicates are rejected; choices expose canonical selectable groups.

`IPO / Young Bases` requires 1–100 observed history sessions and a valid listing date no more than
300 calendar days before the snapshot session. Future/invalid listing dates do not qualify. This cohort
never replaces a company's business theme. `Pharma - Small Cap` is disabled because there is no approved
dated market-cap rule; it is not treated as a business category.

## Authorities and reviewed decisions

The complete source inventory reviewed was 3,410 Tracker security rows, all 313 source theme definitions
and 28 thematic blocks, 2,859 pinned company classifications, 91 manual fallbacks, 43 issuer theme
assignments and the current published universe. This is a full source/contract review, not a claim that
every issuer was independently researched from filings.

- `frontend/theme_tracker_source.json` preserves the original Tracker definitions and primary mappings.
- `DO NOT DELETE EDL PIPELINE/stockscans_classification.json` preserves the pinned company extract.
- `DO NOT DELETE EDL PIPELINE/taxonomy_overrides.json` supplies exact sector aliases and reviewed company
  sector/industry overrides, applied after the pinned extract while preserving provider labels.
- `frontend/theme_tracker_web_overrides.json` supplies researched fallback and issuer niche information.
- `frontend/classification_policy.json` records node IDs, alias/aggregate corrections, macro and exposure
  parents, primary issuer reviews, dated security aliases, cohort rules and individual overlap decisions.
- `frontend/classification_contract.py` validates the graph and projects its memberships.
- `frontend/theme_classification.py` resolves the versioned company records.

The resulting registry has 316 nodes: 214 business categories, four exposure overlays, 64 aliases,
32 aggregates and two cohort definitions (one disabled). Of 39 supplemental overlap decisions,
nine are accepted and 30 are declined with reasons. Broad catch-all symbol lists and obsolete industry
assignments no longer silently add memberships. Reviewed evidence, rather than source insertion order,
determines additional participation. Primary selection is independent of supplemental membership order.

Notable decisions:

- Data-centre, precision engineering, pharma CDMO and emerging EMS overlays inherit their actual business
  blocks. Professional services has a separate macro pillar; general electrical capital goods is industrial.
- Pharma API aliases point to API/CRAMS rather than every pharmaceutical business. The EMS alias points
  to electronics manufacturing rather than ordinary consumer-electronics brands.
- Auto Components, Real Estate Developers and Real Estate Ecosystem have explicit aggregate definitions.
  IT, electrical equipment, power, logistics and media aggregates include their newer canonical categories.
- Eleven current issuer business corrections include Raymond's engineering business, Lumax's automotive
  lighting, Kennametal's tooling, Vimta's contract testing and seven missing new-company mappings.
- Emerging EMS includes Kaynes' documented electronics manufacturing expansion. Tata Technologies'
  engineering-services business retains its ER&D theme; its imported EMS overlay is explicitly rejected.
- The ICICIPRULI → ICICILIFE source-symbol join has the official 23 October 2026 effective date.
  It is an exact dated identity rule, not a fuzzy name match.

The policy and audit contain the individual reasons and primary-source URLs. Representative evidence:
[Raymond's demerger and engineering disclosure](https://api.raymond.in/uploads/investor/1747065722517Financial%20Results%20with%20Press%20Release%20Q4%20FY25%20%E2%80%93%20May%2012%2C%202025.pdf),
[Lumax's business description](https://www.lumaxworld.in/lumaxindustries/overview.html),
[Vimta's annual report](https://vimta.com/wp-content/uploads/Annual-Report-2024-25.pdf) and
[NSE's symbol-change circular](https://nsearchives.nseindia.com/content/circulars/CML76967.pdf).

## Publication and historical integrity

Schema v2 publishes a classification sidecar plus a consolidated company/thematic projection.
The quote snapshot, release manifest, chart directory, IPO labels and market sector summary use the same
normalized primary company rows. Classification version, session date and exact security universe must
agree. Publication validates the staged on-disk artifacts before activating the release pointer.
Backend inputs freeze the same projections with the scanner revision. A historical request cannot silently
fall back to today's classification or company data.

The frontend lazily loads and deduplicates the matching classification sidecar for taxonomy filters and
choices. Joins return classified copies without mutating the cached quote snapshot. The version hashes
source definitions, issuer assignments, policy and classifier/contract code. Stable node IDs are recorded
in the registry; existing Rotation history still uses its established label keys, so future renames need an
explicit history migration.

Schema v1 releases remain readable. Their complete membership maps are honored regardless of provenance;
their recorded scalar parents remain historical facts. Legacy IPO membership is exposed as a cohort.
They cannot reconstruct parent paths that were never published. Rotation migrates older six/seven-level
ledgers without deleting observations. Membership is point in time from observations onward; earlier
price history reconstructed with the earliest known membership must not be described as historical facts.

To rebuild classification from existing frozen quotes without fetching prices or uploading anything:

```sh
python3 tools/rebuild_classification_release.py
```

This creates and validates a new immutable revision, preserving quote dates and all per-stock fields
except reviewed sector/industry labels. It does not attach old Rotation composites to the new taxonomy.
The normal publisher rebuilds production Rotation; `python3 tools/build_rotation_local.py` produces a
separately dated local preview. Repeating an unchanged classification rebuild is idempotent.

## Current verification and remaining limits

The 23 October 2026 local correction release maps all 2,612 stocks to a business theme, with 48 companies
having multiple business memberships and 232 in the listing cohort. There are 29 deliberately broad primary
mappings and 1,168 unavailable sub-industries. Completeness of business mapping does not imply that every
company has a verified narrow sub-industry.

The local Rotation cache has prices through 9 October 2026, shown explicitly in its UI. It must be refreshed
through normal market-data publication before being treated as current production Rotation. No deployment
was performed as part of this correction.

The PR preserves `main`'s newer weekly-refresh pointer and payloads. The frozen-data correction above is
verification evidence; normal publication after merge emits schema v2 and matching backend/Rotation data.

Regression coverage includes the shared Python/TypeScript fixture, actual published artifact joins,
primary-label preservation, every membership dimension, ANY/ALL and unknown semantics, parent deduplication,
cohort boundaries, accepted/rejected overlaps, aliases, stale releases, Earnings errors and ledger migration.
Run the standard frontend, pipeline and worker checks; exact results are recorded in the remediation audit.
