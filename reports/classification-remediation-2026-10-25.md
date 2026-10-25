# Classification review and remediation — 25 October 2026

The existing implementation was inconsistent. Multiple membership is the right model, but consumers
disagreed about which memberships to use, the meaning of parents, and whether listing/style labels were
business themes. The changes in this checkout establish a shared contract and correct the published local
classification release during local verification. They have not been deployed. The PR preserves the
newer weekly-refresh data on `main`; it carries the code, policy and documentation for normal publication.
The [comprehensive root-cause document](../docs/classification-root-cause.md) explains why the PR exists,
how each defect propagated, and what the change intentionally leaves for publication or further research.

## Judgment and implemented model

Keep one primary sector/industry and one deterministic primary theme for display. Allow multiple explicit
business/exposure memberships. Derive thematic blocks and macro pillars from every direct membership,
deduplicating each company within a parent. Keep listing cohorts separate. Resolve aliases to a canonical
category; expose category unions as aggregates without inventing new business exposures.

This is implemented in `frontend/classification_contract.py`, `frontend/theme_classification.py` and
`frontend/src/data/classification.ts`. The detailed semantics, authority boundaries and maintenance workflow
are in [the classification contract](../docs/classification.md).

## Problems found and changes made

| Problem | Implemented behavior |
| --- | --- |
| Copy/Earnings used scalar themes while Rotation accepted only selected provenance values | All use the complete shared membership projection |
| Secondary themes could leave primary-only parents | Blocks/macros are distinct unions of all actual membership paths |
| IPO/young-history label displaced a business classification | Dated listing cohort evaluated independently |
| Aliases and broad unions masqueraded as additional exposures | Explicit business, exposure, alias, aggregate and cohort node kinds |
| Legacy thematic `industry` could replace primary company industry on joins | Explicit primary-label preservation |
| Broad/obsolete lists silently created overlaps | Individual review decisions override imported secondary edges |
| Primary classifications differed between published surfaces | Same normalized company rows feed quotes, Charts, IPO and Market summaries |
| Missing historical releases silently fell back to latest | Retryable unavailable-release errors; exact version/date/universe binding |
| Rotation could carry composites from another classification | Classification version required for schema v2; incompatible composites rejected |
| Classifications were not selectable through the same filter path | Six categorical dimensions added with ANY/ALL, shared choices and AI catalog |
| Failed Earnings classification fetch appeared as Unclassified | Retryable classification error with no false grouping |

## Scope and taxonomy decisions

The review covered all 3,410 Tracker rows, 313 original node definitions, 28 blocks, 2,859 pinned company
records, 91 manual fallbacks and 43 issuer assignments. The final registry has 316 nodes after defining
three missing aggregates. All nodes, parents and alias/aggregate dependencies are validated as one graph.
This is not an independent filing-based re-underwriting of every listed issuer.

There are 39 explicit overlap decisions: nine accepted and 30 declined. Four exposure overlays were
reparented to their business blocks. Professional services was separated from financial services and
general electrical capital goods was assigned to the industrial macro pillar. API, EMS, RTA, auto, real
estate, IT, electrical, power, logistics and media aliases/aggregates received explicit scope corrections.

Eleven researched issuer business corrections address Raymond, Lumax, Kennametal, Vimta and seven
unmapped new issuers. The official ICICIPRULI → ICICILIFE change is dated. The imported Tata Technologies
EMS overlay was rejected; Kaynes' documented EMS expansion was included. Primary evidence URLs and
individual reasons are preserved in the policy and [machine-readable audit](classification-remediation-2026-10-25.json).

## Verified local result

- All 2,612 stocks in the 23 October 2026 release have a business mapping.
- 48 stocks have multiple business memberships, with 50 secondary edges; parents are deduplicated.
- 232 qualify for the separate listing cohort.
- 29 primary mappings remain explicitly broad; 1,168 sub-industries remain unavailable rather than guessed.
- Frozen per-stock prices and financial metrics match the original release. Only reviewed sector/industry
  labels changed; taxonomy details are in the separate versioned projections.
- Schema v1 releases and older Rotation ledgers remain readable with their historical limitations documented.

Verification: the frontend passed all 1,755 tests in 88 files; frontend Python ran 160 tests with two skipped;
the EDL pipeline ran 530 tests with one skipped. Frontend/worker TypeScript checks and the production build
passed. Browser checks exercise the actual Emerging EMS screen and the additional grouping controls.

The local Rotation preview is bound to the corrected taxonomy, but its cached stock prices end on
9 October 2026. The page displays that date. The correction release omits incompatible production Rotation
references; the normal publisher must build and publish fresh composites with current price history.
Historical memberships before their first observation remain reconstructions.

Future changes should update the policy with a reason and dated evidence, regenerate the release, and
pass the shared contract checks. Avoid adding screen-specific category lists or inferring participation
from a broad industry's name alone.
